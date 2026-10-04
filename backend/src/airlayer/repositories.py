"""Data access. Every query takes the request context and filters by organisation (ADR 0003);
routes never build unscoped queries."""

import base64
from dataclasses import dataclass
from datetime import datetime
from typing import Any
from uuid import UUID

from sqlalchemy import ColumnElement, Row, func, select, tuple_
from sqlalchemy.dialects.postgresql import distinct_on
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from airlayer.countries import Country, load_countries
from airlayer.errors import ApiError
from airlayer.identity import RequestContext
from airlayer.layers import LayerFilter
from airlayer.models import (
    IN_FLIGHT_INDEX,
    AuditEvent,
    NationalRefresh,
    Project,
    Region,
    StationReading,
    SyncJob,
    SyncStatus,
)
from airlayer.openaq import is_missing_marker
from airlayer.schemas import (
    CountryListResponse,
    CountryOut,
    MapLayerOut,
    MapLayerResponse,
    NationalLayerOut,
    NationalLayerResponse,
    PointGeometry,
    ProjectOut,
    ReadingOut,
    RegionOut,
    StationCollection,
    StationFeature,
    StationProperties,
    SyncError,
    SyncJobOut,
)


def parse_id(raw: str) -> UUID | None:
    try:
        return UUID(raw)
    except ValueError:
        return None


def not_found(what: str) -> ApiError:
    return ApiError(404, "not_found", f"{what} not found.")


def invalid_id(what: str) -> ApiError:
    # Same status and code as an unknown id (ids are opaque to clients); the message only helps
    # a person pasting an id from a JSON response, quotes included.
    return ApiError(404, "not_found", f"{what} not found. An id is a UUID: no quotes, no spaces.")


_REGION_COLUMNS = (
    Region.id,
    Region.project_id,
    Region.name,
    Region.created_at,
    func.ST_XMin(Region.geom).label("min_lon"),
    func.ST_YMin(Region.geom).label("min_lat"),
    func.ST_XMax(Region.geom).label("max_lon"),
    func.ST_YMax(Region.geom).label("max_lat"),
)


def _region_out(row: Row[tuple[object, ...]]) -> RegionOut:
    return RegionOut(
        id=row.id,
        project_id=row.project_id,
        name=row.name,
        bbox=[row.min_lon, row.min_lat, row.max_lon, row.max_lat],
        created_at=row.created_at,
    )


async def list_projects(session: AsyncSession, ctx: RequestContext) -> list[ProjectOut]:
    result = await session.execute(
        select(Project.id, Project.name)
        .where(Project.organisation_id == ctx.organisation_id)
        .order_by(Project.created_at, Project.id)
    )
    return [ProjectOut(id=r.id, name=r.name) for r in result]


async def project_exists(session: AsyncSession, ctx: RequestContext, project_id: UUID) -> bool:
    found = await session.scalar(
        select(Project.id).where(
            Project.id == project_id, Project.organisation_id == ctx.organisation_id
        )
    )
    return found is not None


async def create_region(
    session: AsyncSession, ctx: RequestContext, project_id: UUID, name: str, bbox: list[float]
) -> RegionOut:
    region = Region(
        project_id=project_id,
        organisation_id=ctx.organisation_id,
        name=name,
        geom=func.ST_MakeEnvelope(*bbox, 4326),
    )
    session.add(region)
    await session.flush()
    await session.refresh(region, ["created_at"])
    session.add(
        AuditEvent(
            organisation_id=ctx.organisation_id,
            actor_id=ctx.actor_id,
            action="region.created",
            entity_type="region",
            entity_id=region.id,
        )
    )
    await session.commit()
    return RegionOut(
        id=region.id,
        project_id=region.project_id,
        name=region.name,
        bbox=bbox,
        created_at=region.created_at,
    )


async def get_region(
    session: AsyncSession, ctx: RequestContext, region_id: UUID
) -> RegionOut | None:
    result = await session.execute(
        select(*_REGION_COLUMNS).where(
            Region.id == region_id, Region.organisation_id == ctx.organisation_id
        )
    )
    row = result.first()
    return _region_out(row) if row else None


def encode_cursor(created_at: datetime, item_id: UUID) -> str:
    return base64.urlsafe_b64encode(f"{created_at.isoformat()}|{item_id}".encode()).decode()


def decode_cursor(cursor: str) -> tuple[datetime, UUID]:
    try:
        created, item_id = base64.urlsafe_b64decode(cursor.encode()).decode().split("|")
        created_at = datetime.fromisoformat(created)
        if created_at.tzinfo is None:
            raise ValueError("cursor timestamp has no timezone")
        return created_at, UUID(item_id)
    except ValueError:
        raise ApiError(400, "validation_failed", "cursor is not valid.") from None


async def list_regions(
    session: AsyncSession,
    ctx: RequestContext,
    project_id: UUID,
    limit: int,
    cursor: str | None,
) -> tuple[list[RegionOut], str | None]:
    query = (
        select(*_REGION_COLUMNS)
        .where(Region.project_id == project_id, Region.organisation_id == ctx.organisation_id)
        .order_by(Region.created_at.desc(), Region.id.desc())
        .limit(limit + 1)
    )
    if cursor is not None:
        created_at, region_id = decode_cursor(cursor)
        query = query.where(tuple_(Region.created_at, Region.id) < (created_at, region_id))
    rows = (await session.execute(query)).all()
    page = rows[:limit]
    next_cursor = (
        encode_cursor(page[-1].created_at, page[-1].id) if len(rows) > limit and page else None
    )
    return [_region_out(r) for r in page], next_cursor


def _sync_job_out(job: SyncJob) -> SyncJobOut:
    return SyncJobOut(
        id=job.id,
        region_id=job.region_id,
        status=job.status,
        created_at=job.created_at,
        started_at=job.started_at,
        finished_at=job.finished_at,
        station_count=job.station_count,
        map_layer_id=job.id if job.status == SyncStatus.SUCCEEDED.value else None,
        errors=[SyncError(**e) for e in job.errors],
        warnings=[SyncError(**w) for w in job.warnings],
    )


async def create_sync_job(
    session: AsyncSession, ctx: RequestContext, region_id: UUID
) -> SyncJobOut:
    job = SyncJob(
        organisation_id=ctx.organisation_id,
        region_id=region_id,
        status=SyncStatus.QUEUED.value,
        errors=[],
    )
    session.add(job)
    try:
        await session.commit()
    except IntegrityError as exc:
        await session.rollback()
        # The partial unique index allows one queued/processing job per region (ADR 0010); any
        # other integrity failure is a bug and must not be reported as a conflict.
        diag = getattr(exc.orig, "diag", None)
        if getattr(diag, "constraint_name", None) != IN_FLIGHT_INDEX:
            raise
        raise ApiError(409, "conflict", "A sync is already running for this region.") from None
    await session.refresh(job)
    return _sync_job_out(job)


async def get_sync_job(
    session: AsyncSession, ctx: RequestContext, sync_job_id: UUID
) -> SyncJobOut | None:
    job = await session.scalar(
        select(SyncJob).where(
            SyncJob.id == sync_job_id, SyncJob.organisation_id == ctx.organisation_id
        )
    )
    return _sync_job_out(job) if job else None


async def list_sync_jobs(
    session: AsyncSession,
    ctx: RequestContext,
    region_id: UUID,
    limit: int,
    cursor: str | None,
) -> tuple[list[SyncJobOut], str | None]:
    query = (
        select(SyncJob)
        .where(SyncJob.region_id == region_id, SyncJob.organisation_id == ctx.organisation_id)
        .order_by(SyncJob.created_at.desc(), SyncJob.id.desc())
        .limit(limit + 1)
    )
    if cursor is not None:
        created_at, job_id = decode_cursor(cursor)
        query = query.where(tuple_(SyncJob.created_at, SyncJob.id) < (created_at, job_id))
    jobs = list((await session.scalars(query)).all())
    page = jobs[:limit]
    next_cursor = (
        encode_cursor(page[-1].created_at, page[-1].id) if len(jobs) > limit and page else None
    )
    return [_sync_job_out(j) for j in page], next_cursor


def _usable(readings: dict[str, Any]) -> dict[str, Any]:
    """The readings without missing-data markers (a value at or below -990)."""
    return {k: v for k, v in readings.items() if not is_missing_marker(v["value"])}


async def get_map_layer(
    session: AsyncSession,
    ctx: RequestContext,
    layer_id: UUID,
    layer_filter: LayerFilter | None,
) -> MapLayerResponse | None:
    """The layer is the readings of one succeeded sync job (ADR 0010).

    Filtering happens here, in Python, over the whole layer: a layer is bounded by the 50-station
    cap, and this keeps `station_count` and `property_keys` (which describe the unfiltered layer)
    and the filter in one place. Revisit with SQL if that cap is ever raised a lot."""
    job = await session.scalar(
        select(SyncJob).where(
            SyncJob.id == layer_id,
            SyncJob.organisation_id == ctx.organisation_id,
            SyncJob.status == SyncStatus.SUCCEEDED.value,
        )
    )
    if job is None:
        return None
    bbox_row = (
        await session.execute(
            select(
                func.ST_XMin(Region.geom),
                func.ST_YMin(Region.geom),
                func.ST_XMax(Region.geom),
                func.ST_YMax(Region.geom),
            ).where(Region.id == job.region_id, Region.organisation_id == ctx.organisation_id)
        )
    ).one()
    contents = await _layer_contents(session, StationReading.sync_job_id == job.id, layer_filter)
    return MapLayerResponse(
        map_layer=MapLayerOut(
            id=job.id,
            region_id=job.region_id,
            station_count=contents.station_count,
            bbox=[float(v) for v in bbox_row],
            property_keys=contents.property_keys,
        ),
        stations=contents.stations,
    )


async def get_national_layer(
    session: AsyncSession, country: Country, layer_filter: LayerFilter | None
) -> NationalLayerResponse | None:
    """The newest succeeded national refresh of a country (ADR 0018, 0019). Public data, so no
    organisation filter."""
    refresh = await latest_succeeded_refresh(session, country.code)
    if refresh is None or refresh.finished_at is None:
        return None
    contents = await _layer_contents(
        session, StationReading.national_refresh_id == refresh.id, layer_filter
    )
    return NationalLayerResponse(
        map_layer=NationalLayerOut(
            id=refresh.id,
            country=country.code,
            refreshed_at=refresh.finished_at,
            station_count=contents.station_count,
            bbox=country.bbox,
            property_keys=contents.property_keys,
        ),
        stations=contents.stations,
    )


async def latest_succeeded_refresh(
    session: AsyncSession, country_code: str
) -> NationalRefresh | None:
    return await session.scalar(
        select(NationalRefresh)
        .where(
            NationalRefresh.country_code == country_code,
            NationalRefresh.status == SyncStatus.SUCCEEDED.value,
        )
        .order_by(NationalRefresh.finished_at.desc(), NationalRefresh.id)
        .limit(1)
    )


async def list_countries(session: AsyncSession) -> CountryListResponse:
    """Every country with a national layer, and when its newest succeeded refresh finished."""
    newest = {
        row.country_code: row
        for row in (
            await session.execute(
                select(
                    NationalRefresh.country_code,
                    NationalRefresh.finished_at,
                    NationalRefresh.station_count,
                )
                .where(NationalRefresh.status == SyncStatus.SUCCEEDED.value)
                .order_by(
                    NationalRefresh.country_code,
                    NationalRefresh.finished_at.desc(),
                    NationalRefresh.id,
                )
                .ext(distinct_on(NationalRefresh.country_code))
            )
        ).all()
    }
    return CountryListResponse(
        countries=[
            CountryOut(
                code=c.code,
                name=c.name,
                bbox=c.bbox,
                refreshed_at=newest[c.code].finished_at if c.code in newest else None,
                station_count=newest[c.code].station_count if c.code in newest else None,
            )
            for c in sorted(load_countries(), key=lambda country: country.name)
        ]
    )


@dataclass(frozen=True)
class _LayerContents:
    # station_count and property_keys describe the whole layer, stations only the filtered part.
    station_count: int
    property_keys: list[str]
    stations: StationCollection


async def _layer_contents(
    session: AsyncSession, parent: ColumnElement[bool], layer_filter: LayerFilter | None
) -> _LayerContents:
    rows = (
        await session.execute(
            select(
                StationReading.id,
                StationReading.name,
                func.ST_X(StationReading.geom).label("lon"),
                func.ST_Y(StationReading.geom).label("lat"),
                StationReading.readings,
                StationReading.sources,
            )
            .where(parent)
            .order_by(
                StationReading.openaq_location_id.asc().nulls_last(),
                StationReading.luchtmeetnet_number,
                StationReading.id,
            )
        )
    ).all()
    # A layer stored before markers were dropped at sync time still holds them (ADR 0014).
    cleaned = [(r, _usable(r.readings)) for r in rows]
    property_keys = sorted({key for _, readings in cleaned for key in readings})
    if layer_filter is not None and layer_filter.property not in property_keys:
        raise ApiError(
            400,
            "validation_failed",
            f"property must be one of: {', '.join(property_keys) or '(none)'}.",
        )
    features = [
        StationFeature(
            id=r.id,
            geometry=PointGeometry(coordinates=[r.lon, r.lat]),
            properties=StationProperties(
                name=r.name,
                sources=r.sources,
                readings={k: ReadingOut(**v) for k, v in readings.items()},
            ),
        )
        for r, readings in cleaned
        if layer_filter is None or layer_filter.matches(readings)
    ]
    return _LayerContents(
        station_count=len(rows),
        property_keys=property_keys,
        stations=StationCollection(features=features),
    )


@dataclass(frozen=True)
class HistoryTarget:
    # None for a station only Luchtmeetnet has: it has no history here (ADR 0017).
    openaq_location_id: int | None
    property_keys: list[str]


async def get_history_target(
    session: AsyncSession, ctx: RequestContext, layer_id: UUID, station_id: UUID
) -> HistoryTarget | None:
    """The OpenAQ location behind one station of a layer, and the layer's property keys.

    The layer is a succeeded job of this organisation, or a kept succeeded national refresh
    (public data, ADR 0018, 0019). None when it is neither, or the station is not in it, so another
    organisation's ids are indistinguishable from unknown ones."""
    job_id = await session.scalar(
        select(SyncJob.id).where(
            SyncJob.id == layer_id,
            SyncJob.organisation_id == ctx.organisation_id,
            SyncJob.status == SyncStatus.SUCCEEDED.value,
        )
    )
    if job_id is not None:
        parent = StationReading.sync_job_id == job_id
    else:
        refresh_id = await session.scalar(
            select(NationalRefresh.id).where(
                NationalRefresh.id == layer_id,
                NationalRefresh.status == SyncStatus.SUCCEEDED.value,
            )
        )
        if refresh_id is None:
            return None
        parent = StationReading.national_refresh_id == refresh_id
    rows = (
        await session.execute(
            select(
                StationReading.id, StationReading.openaq_location_id, StationReading.readings
            ).where(parent)
        )
    ).all()
    station = next((r for r in rows if r.id == station_id), None)
    if station is None:
        return None
    keys = sorted({key for r in rows for key in _usable(r.readings)})
    return HistoryTarget(station.openaq_location_id, keys)
