"""Data access. Every query takes the request context and filters by organisation (ADR 0003);
routes never build unscoped queries."""

import base64
from datetime import datetime
from uuid import UUID

from sqlalchemy import Row, func, select, tuple_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from airlayer.errors import ApiError
from airlayer.identity import RequestContext
from airlayer.layers import LayerFilter
from airlayer.models import (
    IN_FLIGHT_INDEX,
    AuditEvent,
    Project,
    Region,
    StationReading,
    SyncJob,
    SyncStatus,
)
from airlayer.schemas import (
    MapLayerOut,
    MapLayerResponse,
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
    rows = (
        await session.execute(
            select(
                StationReading.id,
                StationReading.name,
                func.ST_X(StationReading.geom).label("lon"),
                func.ST_Y(StationReading.geom).label("lat"),
                StationReading.readings,
            )
            .where(StationReading.sync_job_id == job.id)
            .order_by(StationReading.openaq_location_id)
        )
    ).all()
    property_keys = sorted({key for r in rows for key in r.readings})
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
                name=r.name, readings={k: ReadingOut(**v) for k, v in r.readings.items()}
            ),
        )
        for r in rows
        if layer_filter is None or layer_filter.matches(r.readings)
    ]
    return MapLayerResponse(
        map_layer=MapLayerOut(
            id=job.id,
            region_id=job.region_id,
            station_count=len(rows),
            bbox=[float(v) for v in bbox_row],
            property_keys=property_keys,
        ),
        stations=StationCollection(features=features),
    )
