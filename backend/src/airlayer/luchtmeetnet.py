"""Luchtmeetnet client (ADR 0017). Like OpenAQ's, everything it returns is untrusted: shape,
numbers and timestamps are validated here and a violation fails the whole fetch.

The station catalogue is a snapshot in the repo (`refresh_luchtmeetnet.py`) because coordinates
cost one call per station against a limit of 100 calls per 5 minutes. A sync then costs one call
per station inside the region."""

import asyncio
import json
import time
from collections import deque
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from functools import lru_cache
from pathlib import Path
from typing import Annotated, Any

import httpx
from pydantic import AwareDatetime, BaseModel, Field, ValidationError

from airlayer.openaq import (
    PermanentUpstreamError,
    Reading,
    StationSnapshot,
    TransientUpstreamError,
    is_missing_marker,
)

SNAPSHOT = Path(__file__).with_name("luchtmeetnet_stations.json")
SOURCE = "luchtmeetnet"
CLOCK_SKEW = timedelta(minutes=5)
# The API allows 100 calls per 5 minutes; stay under it with a little room.
CALLS_PER_WINDOW = 90
WINDOW_SECONDS = 300.0

# Luchtmeetnet formula -> (our parameter name, unit). The API sends no unit with a measurement, so
# these are an Assumption taken from its component descriptions (ADR 0017). Anything not listed
# is dropped, not guessed.
PARAMETERS: dict[str, tuple[str, str]] = {
    "PM25": ("pm25", "µg/m³"),
    "PM10": ("pm10", "µg/m³"),
    "NO2": ("no2", "µg/m³"),
    "NO": ("no", "µg/m³"),
    "O3": ("o3", "µg/m³"),
    "SO2": ("so2", "µg/m³"),
    "CO": ("co", "µg/m³"),
    "NH3": ("nh3", "µg/m³"),
    "H2S": ("h2s", "µg/m³"),
    "C6H6": ("c6h6", "µg/m³"),
    "C7H8": ("c7h8", "µg/m³"),
    "C8H10": ("c8h10", "µg/m³"),
    "FN": ("fn", "µg/m³"),
    "BCWB": ("bcwb", "µg/m³"),
    "PS": ("ps", "particles/cm³"),
}


@dataclass(frozen=True)
class CatalogueStation:
    number: str
    name: str
    longitude: float
    latitude: float


class _CatalogueEntry(BaseModel):
    # The number goes into a URL path, so only plain characters are allowed.
    number: Annotated[str, Field(strict=True, pattern=r"^[A-Za-z0-9]{1,20}$")]
    name: Annotated[str, Field(strict=True, min_length=1, max_length=100)]
    longitude: Annotated[float, Field(strict=True, ge=-180, le=180)]
    latitude: Annotated[float, Field(strict=True, ge=-90, le=90)]


class _Catalogue(BaseModel):
    stations: list[_CatalogueEntry]


@lru_cache
def load_catalogue() -> tuple[CatalogueStation, ...]:
    parsed = _Catalogue.model_validate(json.loads(SNAPSHOT.read_text(encoding="utf-8")))
    return tuple(
        CatalogueStation(e.number, e.name, e.longitude, e.latitude) for e in parsed.stations
    )


def stations_in(
    bbox: list[float], catalogue: tuple[CatalogueStation, ...]
) -> list[CatalogueStation]:
    west, south, east, north = bbox
    return [s for s in catalogue if west <= s.longitude <= east and south <= s.latitude <= north]


class _Measurement(BaseModel):
    value: Annotated[float, Field(strict=True, allow_inf_nan=False)]
    formula: Annotated[str, Field(strict=True, max_length=20)]
    timestamp_measured: AwareDatetime


class _MeasurementsPage(BaseModel):
    data: list[_Measurement]


def make_http_client(*, base_url: str, timeout: float, user_agent: str) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        base_url=base_url, headers={"User-Agent": user_agent}, timeout=httpx.Timeout(timeout)
    )


def _invalid(message: str) -> PermanentUpstreamError:
    return PermanentUpstreamError("upstream_invalid_response", message)


async def _do_sleep(seconds: float) -> None:
    await asyncio.sleep(seconds)


class CallPacer:
    """Keeps calls under the API's limit. One is shared by every sync in a process, so several
    syncs close together do not add up to more than the limit; with several worker processes the
    total is higher (like place search, ADR 0013)."""

    def __init__(
        self,
        *,
        sleep: Callable[[float], Awaitable[None]] = _do_sleep,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._sleep = sleep
        self._clock = clock
        self._calls: deque[float] = deque()

    async def wait(self) -> None:
        now = self._clock()
        while self._calls and now - self._calls[0] >= WINDOW_SECONDS:
            self._calls.popleft()
        if len(self._calls) >= CALLS_PER_WINDOW:
            await self._sleep(WINDOW_SECONDS - (now - self._calls[0]))
        self._calls.append(self._clock())


_PACER = CallPacer()


class LuchtmeetnetClient:
    def __init__(
        self,
        http: httpx.AsyncClient,
        *,
        pacer: CallPacer = _PACER,
        now: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self._http = http
        self._pacer = pacer
        self._now = now

    async def fetch_stations(self, stations: list[CatalogueStation]) -> list[StationSnapshot]:
        snapshots = []
        for station in sorted(stations, key=lambda s: s.number):
            snapshots.append(await self._snapshot(station))
        return snapshots

    async def _snapshot(self, station: CatalogueStation) -> StationSnapshot:
        # Without `formula` the newest hours of every pollutant come back in one call; the newest
        # value per pollutant is the station's latest reading.
        page = self._parse(
            await self._get(
                f"/stations/{station.number}/measurements",
                {"page": 1, "order_by": "timestamp_measured", "order_direction": "desc"},
            )
        )
        newest: dict[str, _Measurement] = {}
        now = self._now()
        for item in page.data:
            if item.formula not in PARAMETERS or is_missing_marker(item.value):
                continue
            # A timestamp in the future is a wrong clock somewhere, not a reading.
            if item.timestamp_measured > now + CLOCK_SKEW:
                raise _invalid("Luchtmeetnet returned a measurement from the future.")
            current = newest.get(item.formula)
            if current is None or item.timestamp_measured > current.timestamp_measured:
                newest[item.formula] = item
        readings = {
            PARAMETERS[formula][0]: Reading(
                item.value,
                PARAMETERS[formula][1],
                item.timestamp_measured.astimezone(UTC),
                source=SOURCE,
            )
            for formula, item in newest.items()
        }
        return StationSnapshot(
            location_id=None,
            name=station.name,
            longitude=station.longitude,
            latitude=station.latitude,
            readings=readings,
            luchtmeetnet_number=station.number,
            sources=(SOURCE,),
        )

    @staticmethod
    def _parse(body: Any) -> _MeasurementsPage:
        try:
            return _MeasurementsPage.model_validate(body)
        except ValidationError as exc:
            raise _invalid(
                "Luchtmeetnet response did not match the expected shape: "
                f"{exc.error_count()} problem(s)."
            ) from None

    async def _get(self, path: str, params: dict[str, Any]) -> Any:
        await self._pacer.wait()
        try:
            response = await self._http.get(path, params=params)
        except httpx.HTTPError as exc:
            raise TransientUpstreamError(
                f"Luchtmeetnet request failed: {type(exc).__name__}"
            ) from None
        status = response.status_code
        if status == 429 or status >= 500:
            raise TransientUpstreamError(f"Luchtmeetnet answered {status}.")
        if status >= 400:
            raise _invalid(f"Luchtmeetnet answered {status}.")
        try:
            return response.json()
        except ValueError:
            raise _invalid("Luchtmeetnet response was not JSON.") from None
