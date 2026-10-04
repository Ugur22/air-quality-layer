"""The hourly national refresh: pull the whole Netherlands from both sources and store it as one
layer (ADR 0018).

Unlike a sync, nothing here is retried or user-triggered: a refresh that fails is simply replaced
by the next hour's, and the layer keeps serving the newest refresh that succeeded."""

import asyncio
import logging
from datetime import UTC, datetime, timedelta
from uuid import UUID

from sqlalchemy import func, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from airlayer import luchtmeetnet
from airlayer.config import Settings, get_settings
from airlayer.db import get_sessionmaker
from airlayer.merge import merge_stations
from airlayer.models import NationalRefresh, StationReading, SyncStatus
from airlayer.openaq import (
    OpenAQClient,
    PermanentUpstreamError,
    StationSnapshot,
    UpstreamError,
    make_http_client,
)
from airlayer.sync import reading_json

logger = logging.getLogger(__name__)


async def run_refresh() -> None:
    """One refresh. Every path ends it `failed` or `succeeded`; nothing is left `processing`."""
    settings = get_settings()
    refresh_id = await _start(settings)
    if refresh_id is None:
        return
    try:
        api_key = settings.openaq_api_key.get_secret_value()
        if not api_key:
            await _fail(refresh_id, "upstream_unauthorized", "No OpenAQ API key is configured.")
            return
        async with asyncio.timeout(settings.national_refresh_budget_seconds):
            stations, warnings = await _fetch(settings, api_key)
        await _finish(refresh_id, stations, warnings)
    except UpstreamError as exc:
        await _fail(refresh_id, exc.code, str(exc))
    except TimeoutError:
        await _fail(refresh_id, "timed_out", "The refresh took too long.")
    except Exception:
        # Details go to the log only; the stored message must not leak internals.
        logger.exception("National refresh %s failed unexpectedly", refresh_id)
        await _fail(refresh_id, "processing_error", "The refresh failed unexpectedly.")


async def _fetch(
    settings: Settings, api_key: str
) -> tuple[list[StationSnapshot], list[dict[str, str]]]:
    http = make_http_client(
        api_key=api_key,
        base_url=settings.openaq_base_url,
        timeout=settings.openaq_timeout_seconds,
    )
    try:
        client = OpenAQClient(
            http,
            max_stations=settings.max_stations_national,
            min_interval_seconds=settings.national_openaq_interval_seconds,
        )
        stations = await client.fetch_country_stations(settings.national_openaq_country_id)
    finally:
        await http.aclose()
    extra, warnings = await _fetch_luchtmeetnet(settings)
    merged = merge_stations(stations, extra)
    if len(merged) > settings.max_stations_national:
        raise PermanentUpstreamError(
            "too_many_stations",
            f"The country has more than {settings.max_stations_national} stations.",
        )
    return merged, warnings


async def _fetch_luchtmeetnet(
    settings: Settings,
) -> tuple[list[StationSnapshot], list[dict[str, str]]]:
    unavailable = [
        {
            "code": "luchtmeetnet_unavailable",
            "message": "Luchtmeetnet could not be used; these stations are from OpenAQ only.",
        }
    ]
    http = luchtmeetnet.make_http_client(
        base_url=settings.luchtmeetnet_base_url,
        timeout=settings.luchtmeetnet_timeout_seconds,
        user_agent=settings.places_user_agent,
    )
    try:
        async with asyncio.timeout(settings.national_luchtmeetnet_budget_seconds):
            client = luchtmeetnet.LuchtmeetnetClient(http)
            return await client.fetch_stations(list(luchtmeetnet.load_catalogue())), []
    except UpstreamError as exc:
        logger.warning("Luchtmeetnet unavailable (%s): %s", exc.code, exc)
        return [], unavailable
    except TimeoutError:
        logger.warning("Luchtmeetnet did not answer within its national budget")
        return [], unavailable
    finally:
        await http.aclose()


async def _start(settings: Settings) -> UUID | None:
    """Open a refresh. None means one is already running, which is what makes an overlapping
    trigger harmless."""
    cutoff = datetime.now(UTC) - timedelta(minutes=settings.national_refresh_timeout_minutes)
    async with get_sessionmaker()() as session:
        # An abandoned refresh (dead worker) would otherwise block every later one.
        await session.execute(
            update(NationalRefresh)
            .where(
                NationalRefresh.status == SyncStatus.PROCESSING.value,
                NationalRefresh.created_at < cutoff,
            )
            .values(
                status=SyncStatus.FAILED.value,
                finished_at=func.now(),
                errors=[{"code": "timed_out", "message": "The refresh did not finish in time."}],
            )
        )
        refresh = NationalRefresh()
        session.add(refresh)
        try:
            await session.commit()
        except IntegrityError:
            await session.rollback()
            logger.info("A national refresh is already running; skipping this one")
            return None
        return refresh.id


async def _fail(refresh_id: UUID, code: str, message: str) -> None:
    async with get_sessionmaker()() as session:
        await session.execute(
            update(NationalRefresh)
            .where(
                NationalRefresh.id == refresh_id,
                NationalRefresh.status == SyncStatus.PROCESSING.value,
            )
            .values(
                status=SyncStatus.FAILED.value,
                finished_at=func.now(),
                errors=[{"code": code, "message": message}],
            )
        )
        await session.commit()


async def _finish(
    refresh_id: UUID, stations: list[StationSnapshot], warnings: list[dict[str, str]]
) -> None:
    """Readings and the terminal status commit together, so a failed refresh shows no readings."""
    async with get_sessionmaker()() as session:
        if not await _mark_succeeded(session, refresh_id, len(stations), warnings):
            await session.rollback()
            return
        session.add_all(
            StationReading(
                national_refresh_id=refresh_id,
                openaq_location_id=s.location_id,
                luchtmeetnet_number=s.luchtmeetnet_number,
                sources=list(s.sources),
                name=s.name,
                geom=func.ST_SetSRID(func.ST_MakePoint(s.longitude, s.latitude), 4326),
                readings=reading_json(s),
            )
            for s in stations
        )
        await session.commit()


async def _mark_succeeded(
    session: AsyncSession, refresh_id: UUID, station_count: int, warnings: list[dict[str, str]]
) -> bool:
    result = await session.execute(
        update(NationalRefresh)
        .where(
            NationalRefresh.id == refresh_id,
            NationalRefresh.status == SyncStatus.PROCESSING.value,
        )
        .values(
            status=SyncStatus.SUCCEEDED.value,
            finished_at=func.now(),
            station_count=station_count,
            warnings=warnings,
        )
        .returning(NationalRefresh.id)
    )
    return result.first() is not None
