"""The sync job: pull one region's stations from OpenAQ and store them (ADR 0002, ADR 0010).

Every path ends the job `failed` or `succeeded`; nothing returns while it is still `processing`
except a transient failure that has retries left, which re-raises for the worker to retry."""

import asyncio
import logging
from datetime import UTC, datetime, timedelta
from uuid import UUID

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from airlayer.config import Settings, get_settings
from airlayer.db import get_sessionmaker
from airlayer.models import IN_FLIGHT, Region, StationReading, SyncJob, SyncStatus
from airlayer.openaq import (
    OpenAQClient,
    StationSnapshot,
    TransientUpstreamError,
    UpstreamError,
    make_http_client,
)

logger = logging.getLogger(__name__)

_IN_FLIGHT_VALUES = [s.value for s in IN_FLIGHT]


# Replaceable in tests so they do not really wait.
_sleep = asyncio.sleep


def _fetch_deadline_seconds(settings: Settings) -> float:
    # Half the reaper's timeout, so a run that is still fetching when the reaper would fail the
    # job has stopped calling OpenAQ by then.
    return settings.sync_timeout_minutes * 60 / 2


async def run_sync(sync_job_id: UUID, *, final_attempt: bool) -> None:
    try:
        bbox = await _start(sync_job_id)
        if bbox is None:
            return
        settings = get_settings()
        api_key = settings.openaq_api_key.get_secret_value()
        if not api_key:
            await fail_job(sync_job_id, "upstream_unauthorized", "No OpenAQ API key is configured.")
            return
        stations = await _fetch(settings, api_key, bbox)
        await _finish(sync_job_id, stations)
    except TransientUpstreamError as exc:
        if not final_attempt:
            # Wait out the rate-limit window before the worker's own (shorter) backoff, or the
            # retries would all land inside it and hit 429 again.
            if exc.retry_after:
                await _sleep(exc.retry_after)
            raise
        await fail_job(
            sync_job_id,
            "upstream_unavailable",
            "OpenAQ could not be reached or kept failing after retries.",
        )
    except UpstreamError as exc:
        await fail_job(sync_job_id, exc.code, str(exc))
    except TimeoutError:
        await fail_job(sync_job_id, "timed_out", "The sync took too long.")
    except Exception:
        # Details go to the log only; the stored message must not leak internals.
        logger.exception("Sync %s failed unexpectedly", sync_job_id)
        await fail_job(sync_job_id, "processing_error", "The sync failed unexpectedly.")


async def _fetch(settings: Settings, api_key: str, bbox: list[float]) -> list[StationSnapshot]:
    http = make_http_client(
        api_key=api_key,
        base_url=settings.openaq_base_url,
        timeout=settings.openaq_timeout_seconds,
    )
    try:
        client = OpenAQClient(http, max_stations=settings.max_stations_per_sync)
        async with asyncio.timeout(_fetch_deadline_seconds(settings)):
            return await client.fetch_stations(bbox)
    finally:
        await http.aclose()


async def _start(sync_job_id: UUID) -> list[float] | None:
    """Mark the job processing. None means there is nothing to do (unknown or already finished),
    which is what makes a redelivered queue job harmless."""
    async with get_sessionmaker()() as session:
        job = await session.get(SyncJob, sync_job_id, with_for_update=True)
        if job is None or job.status not in _IN_FLIGHT_VALUES:
            return None
        row = (
            await session.execute(
                select(
                    func.ST_XMin(Region.geom),
                    func.ST_YMin(Region.geom),
                    func.ST_XMax(Region.geom),
                    func.ST_YMax(Region.geom),
                ).where(Region.id == job.region_id)
            )
        ).one()
        job.status = SyncStatus.PROCESSING.value
        job.started_at = job.started_at or datetime.now(UTC)
        await session.commit()
        return [float(v) for v in row]


async def fail_job(sync_job_id: UUID, code: str, message: str) -> None:
    async with get_sessionmaker()() as session:
        await session.execute(
            update(SyncJob)
            .where(SyncJob.id == sync_job_id, SyncJob.status.in_(_IN_FLIGHT_VALUES))
            .values(
                status=SyncStatus.FAILED.value,
                finished_at=func.now(),
                errors=[{"code": code, "message": message}],
            )
        )
        await session.commit()


def _reading_json(station: StationSnapshot) -> dict[str, object]:
    return {
        name: {
            "value": r.value,
            "unit": r.unit,
            "observed_at": r.observed_at.astimezone(UTC).isoformat().replace("+00:00", "Z"),
        }
        for name, r in station.readings.items()
    }


async def _finish(sync_job_id: UUID, stations: list[StationSnapshot]) -> None:
    """Readings and the terminal status commit together, so a failed sync shows no readings."""
    async with get_sessionmaker()() as session:
        done = await _mark_succeeded(session, sync_job_id, len(stations))
        if not done:
            # Reaped while we were fetching: the job is already failed, so store nothing.
            await session.rollback()
            return
        session.add_all(
            StationReading(
                sync_job_id=sync_job_id,
                openaq_location_id=s.location_id,
                name=s.name,
                geom=func.ST_SetSRID(func.ST_MakePoint(s.longitude, s.latitude), 4326),
                readings=_reading_json(s),
            )
            for s in stations
        )
        await session.commit()


async def _mark_succeeded(session: AsyncSession, sync_job_id: UUID, station_count: int) -> bool:
    result = await session.execute(
        update(SyncJob)
        .where(SyncJob.id == sync_job_id, SyncJob.status == SyncStatus.PROCESSING.value)
        .values(
            status=SyncStatus.SUCCEEDED.value, finished_at=func.now(), station_count=station_count
        )
        .returning(SyncJob.id)
    )
    return result.first() is not None


async def reap_stale_jobs() -> int:
    """Fail jobs abandoned by a dead worker or a lost enqueue, so none stays in flight forever."""
    cutoff = datetime.now(UTC) - timedelta(minutes=get_settings().sync_timeout_minutes)
    async with get_sessionmaker()() as session:
        result = await session.execute(
            update(SyncJob)
            .where(SyncJob.status.in_(_IN_FLIGHT_VALUES), SyncJob.created_at < cutoff)
            .values(
                status=SyncStatus.FAILED.value,
                finished_at=func.now(),
                errors=[{"code": "timed_out", "message": "The sync did not finish in time."}],
            )
            .returning(SyncJob.id)
        )
        reaped = len(result.all())
        await session.commit()
    return reaped
