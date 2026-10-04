"""The hourly national refresh: build one layer per country and store each (ADR 0018, 0019).

Unlike a sync, nothing here is retried or user-triggered: a refresh that fails is simply replaced
by the next hour's, and a country keeps serving the newest refresh that succeeded.

All countries are built in one pass because they share the expensive part: OpenAQ's latest values
are paged world-wide once per parameter, not once per country."""

import asyncio
import contextlib
import logging
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from uuid import UUID

from sqlalchemy import delete, func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from airlayer import luchtmeetnet
from airlayer.config import Settings, get_settings
from airlayer.countries import LUCHTMEETNET_COUNTRIES, Country, load_countries
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


@dataclass
class _Built:
    """What one country's pass produced: stations, or the error that failed only that country."""

    stations: list[StationSnapshot] = field(default_factory=list)
    warnings: list[dict[str, str]] = field(default_factory=list)
    error: UpstreamError | None = None


async def run_refresh() -> None:
    """One refresh of every country. Every path ends each country's refresh `failed` or
    `succeeded`; nothing is left `processing`."""
    settings = get_settings()
    countries = {c.code: c for c in load_countries()}
    opened = await _start(settings, list(countries.values()))
    if not opened:
        return
    try:
        api_key = settings.openaq_api_key.get_secret_value()
        if not api_key:
            await _fail_all(opened, "upstream_unauthorized", "No OpenAQ API key is configured.")
            return
        async with asyncio.timeout(settings.national_refresh_budget_seconds):
            built = await _fetch(settings, api_key, [countries[code] for code in opened])
        for code, refresh_id in opened.items():
            outcome = built[code]
            if outcome.error is not None:
                await _fail(refresh_id, outcome.error.code, str(outcome.error))
                continue
            await _finish(refresh_id, outcome.stations, outcome.warnings)
            await _prune_quietly(code, settings.national_refreshes_kept)
    except UpstreamError as exc:
        await _fail_all(opened, exc.code, str(exc))
    except TimeoutError:
        await _fail_all(opened, "timed_out", "The refresh took too long.")
    except asyncio.CancelledError:
        # A worker shutting down: leaving 44 rows `processing` would block the next run until the
        # abandoned-refresh sweep, so they are failed first, even though this task is cancelled.
        await asyncio.shield(_fail_all(opened, "processing_error", "The refresh was interrupted."))
        raise
    except Exception:
        # Details go to the log only; the stored message must not leak internals.
        logger.exception("National refresh failed unexpectedly")
        await _fail_all(opened, "processing_error", "The refresh failed unexpectedly.")


async def _fetch(settings: Settings, api_key: str, countries: list[Country]) -> dict[str, _Built]:
    # Luchtmeetnet has its own limit (100 calls per 5 minutes, so about 5 minutes for its 107
    # stations), separate from OpenAQ's. Running them together costs the longer of the two instead
    # of the sum.
    second_source = (
        asyncio.create_task(_fetch_luchtmeetnet(settings))
        if any(c.code in LUCHTMEETNET_COUNTRIES for c in countries)
        else None
    )
    try:
        built = await _fetch_openaq(settings, api_key, countries)
        if second_source is not None:
            extra, warnings = await second_source
            for code in LUCHTMEETNET_COUNTRIES & built.keys():
                _merge_second_source(settings, built[code], extra, warnings)
        return built
    finally:
        if second_source is not None and not second_source.done():
            second_source.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await second_source


async def _fetch_openaq(
    settings: Settings, api_key: str, countries: list[Country]
) -> dict[str, _Built]:
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
            retries=settings.national_openaq_retries,
            retry_wait_seconds=settings.national_openaq_retry_wait_seconds,
        )
        located = {}
        built: dict[str, _Built] = {}
        for country in countries:
            try:
                located[country.code] = await client.fetch_country_locations(country.openaq_id)
            except PermanentUpstreamError as exc:
                # A country too big for the cap, or one OpenAQ answers oddly for, fails alone.
                # A rejected key is the same for every country, so it fails the whole run.
                if exc.code == "upstream_unauthorized":
                    raise
                built[country.code] = _Built(error=exc)
        latest = await client.fetch_latest([loc for locs in located.values() for loc in locs])
    finally:
        await http.aclose()
    for code, locations in located.items():
        stations = [OpenAQClient.station_of(location, latest) for location in locations]
        built[code] = _Built(stations=stations)
    return built


def _merge_second_source(
    settings: Settings,
    built: _Built,
    extra: list[StationSnapshot],
    warnings: list[dict[str, str]],
) -> None:
    if built.error is not None:
        return
    built.warnings = warnings
    built.stations = merge_stations(built.stations, extra)
    if len(built.stations) > settings.max_stations_national:
        built.error = PermanentUpstreamError(
            "too_many_stations",
            f"The country has more than {settings.max_stations_national} stations.",
        )


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
    except Exception:
        # A second source must never take the first one down with it (ADR 0017).
        logger.exception("Luchtmeetnet failed unexpectedly")
        return [], unavailable
    finally:
        await http.aclose()


async def _start(settings: Settings, countries: list[Country]) -> dict[str, UUID]:
    """Open a refresh per country, by code. A country missing from the answer already has one
    running, which is what makes an overlapping trigger harmless."""
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
        await session.commit()
    opened: dict[str, UUID] = {}
    try:
        for country in countries:
            async with get_sessionmaker()() as session:
                refresh = NationalRefresh(country_code=country.code)
                session.add(refresh)
                try:
                    await session.commit()
                except IntegrityError:
                    await session.rollback()
                    logger.info("A refresh of %s is already running; skipping it", country.code)
                    continue
                opened[country.code] = refresh.id
    except BaseException:
        await asyncio.shield(_fail_all(opened, "processing_error", "The refresh did not start."))
        raise
    return opened


async def _fail_all(opened: dict[str, UUID], code: str, message: str) -> None:
    """Fails every refresh still processing; one that already settled is left as it is."""
    for refresh_id in opened.values():
        await _fail(refresh_id, code, message)


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


async def _prune_quietly(country_code: str, kept: int) -> None:
    """Retention is housekeeping: failing to prune must not fail a refresh that stored its layer."""
    try:
        await _prune(country_code, kept)
    except Exception:
        logger.exception("Pruning old refreshes of %s failed", country_code)


async def _prune(country_code: str, kept: int) -> None:
    """Keep a country's newest succeeded refreshes and delete older ones with their readings
    (ADR 0019). A failed refresh newer than the oldest kept one stays, so a recent failure is
    still visible."""
    async with get_sessionmaker()() as session:
        newest = (
            await session.execute(
                select(NationalRefresh.id, NationalRefresh.finished_at)
                .where(
                    NationalRefresh.country_code == country_code,
                    NationalRefresh.status == SyncStatus.SUCCEEDED.value,
                )
                .order_by(NationalRefresh.finished_at.desc(), NationalRefresh.id)
                .limit(max(kept, 1))
            )
        ).all()
        if not newest:
            return
        old = select(NationalRefresh.id).where(
            NationalRefresh.country_code == country_code,
            NationalRefresh.status != SyncStatus.PROCESSING.value,
            NationalRefresh.id.not_in([row.id for row in newest]),
            NationalRefresh.finished_at < newest[-1].finished_at,
        )
        await session.execute(
            delete(StationReading).where(StationReading.national_refresh_id.in_(old))
        )
        await session.execute(delete(NationalRefresh).where(NationalRefresh.id.in_(old)))
        await session.commit()
