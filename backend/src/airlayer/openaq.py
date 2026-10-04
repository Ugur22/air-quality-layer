"""OpenAQ v3 client. Everything it returns is untrusted input (AGENTS.md): shape, ranges and
timestamps are validated here, and any violation fails the whole fetch rather than storing a
partial result."""

import asyncio
import math
import time
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Annotated, Any

import httpx
from pydantic import AwareDatetime, BaseModel, Field, ValidationError, field_validator

LOCATIONS_PAGE_SIZE = 1000
LATEST_PAGE_SIZE = 1000
# A guard against a pager that never ends, far above what the real lists need (world-wide pm25 is
# about 22 pages of latest values; the largest country about 2 pages of locations).
MAX_PAGES = 200
# Never sleep longer than the rate-limit window itself, whatever the header claims.
MAX_PAUSE_SECONDS = 60.0
# OpenAQ data carries a marker where a sensor has no measurement; it is not a value. -999, -998 and
# -995 were seen in real responses (ADR 0014), so anything at or below this threshold is dropped.
# Values above it, including small negatives, are legitimate readings. A starting value.
MISSING_VALUE_AT_OR_BELOW = -990.0


def is_missing_marker(value: float) -> bool:
    return value <= MISSING_VALUE_AT_OR_BELOW


class UpstreamError(Exception):
    code = "processing_error"


class TransientUpstreamError(UpstreamError):
    """Network trouble, timeouts, 429 and 5xx: worth retrying."""

    code = "upstream_unavailable"

    def __init__(self, message: str, retry_after: float | None = None) -> None:
        super().__init__(message)
        self.retry_after = retry_after


class PermanentUpstreamError(UpstreamError):
    """Retrying cannot help: a rejected key, a malformed response, or a region over the cap."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class Reading:
    value: float
    unit: str
    observed_at: datetime
    # Which source this value came from (ADR 0017).
    source: str = "openaq"


@dataclass(frozen=True)
class HistoryPoint:
    at: datetime
    value: float


@dataclass(frozen=True)
class StationHistory:
    unit: str | None
    points: list[HistoryPoint]


@dataclass(frozen=True)
class StationSnapshot:
    # None for a station only Luchtmeetnet has (ADR 0017).
    location_id: int | None
    name: str
    longitude: float
    latitude: float
    readings: dict[str, Reading]
    luchtmeetnet_number: str | None = None
    sources: tuple[str, ...] = ("openaq",)


# Strict types throughout: the API sends JSON numbers and strings, so "12.4" or true where a number
# belongs means the response is wrong, not something to coerce. Ids must fit the BIGINT column.
_MAX_ID = 2**63 - 1
_Id = Annotated[int, Field(strict=True, ge=0, le=_MAX_ID)]
_Label = Annotated[str, Field(strict=True, min_length=1, max_length=50)]


class _Coordinates(BaseModel):
    latitude: Annotated[float, Field(strict=True, ge=-90, le=90, allow_inf_nan=False)]
    longitude: Annotated[float, Field(strict=True, ge=-180, le=180, allow_inf_nan=False)]


class _Parameter(BaseModel):
    # Needed by the bulk latest-values pull (ADR 0019); a sync by box or per location never uses it.
    id: _Id | None = None
    name: _Label
    units: _Label


class _Sensor(BaseModel):
    id: _Id
    parameter: _Parameter


class _Location(BaseModel):
    id: _Id
    name: Annotated[str, Field(strict=True)] | None = None
    coordinates: _Coordinates
    sensors: list[_Sensor]


class _Meta(BaseModel):
    # OpenAQ sends a number, or a string such as ">1000" when the count is capped.
    found: Annotated[int, Field(strict=True)] | Annotated[str, Field(strict=True)]


class _LocationsPage(BaseModel):
    meta: _Meta
    results: list[_Location]


class _Datetime(BaseModel):
    utc: AwareDatetime


class _Latest(BaseModel):
    datetime: _Datetime
    value: Annotated[float, Field(strict=True)]
    sensorsId: _Id

    @field_validator("value")
    @classmethod
    def finite(cls, v: float) -> float:
        if not math.isfinite(v):
            raise ValueError("value must be finite")
        return v


class _LatestPage(BaseModel):
    results: list[_Latest]


class _RawPage(BaseModel):
    """A page whose items are looked at one by one, because only some of them are ours."""

    results: list[dict[str, Any]]


# The shapes the refresh passes between its steps (ADR 0019).
Location = _Location
Latest = _Latest


class _SensorsPage(BaseModel):
    results: list[_Sensor]


class _Period(BaseModel):
    datetimeTo: _Datetime


class _Hour(BaseModel):
    value: Annotated[float, Field(strict=True)]
    period: _Period

    @field_validator("value")
    @classmethod
    def finite(cls, v: float) -> float:
        if not math.isfinite(v):
            raise ValueError("value must be finite")
        return v


class _HoursPage(BaseModel):
    meta: _Meta
    results: list[_Hour]


def _utc(moment: datetime) -> str:
    return moment.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def make_http_client(*, api_key: str, base_url: str, timeout: float) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        base_url=base_url, headers={"X-API-Key": api_key}, timeout=httpx.Timeout(timeout)
    )


def _invalid(message: str) -> PermanentUpstreamError:
    return PermanentUpstreamError("upstream_invalid_response", message)


class OpenAQClient:
    def __init__(
        self,
        http: httpx.AsyncClient,
        *,
        max_stations: int,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        clock: Callable[[], float] = time.monotonic,
        min_interval_seconds: float = 0.0,
        retries: int = 0,
        retry_wait_seconds: float = 2.0,
    ) -> None:
        self._http = http
        # A floor between calls, for a caller that makes hundreds (ADR 0018); a sync makes few.
        self._min_interval = min_interval_seconds
        # A sync retries the whole job (Procrastinate); a caller with hundreds of calls to lose
        # (the national refresh, ADR 0019) retries a failed call instead.
        self._retries = retries
        self._retry_wait = retry_wait_seconds
        self._clock = clock
        # Calls are spaced by when they start, so a slow answer already counts towards the gap.
        self._next_start = 0.0
        self._max_stations = max_stations
        self._sleep = sleep
        self._pause_before_next: float = 0.0

    async def fetch_stations(self, bbox: list[float]) -> list[StationSnapshot]:
        return await self._fetch_located({"bbox": ",".join(f"{v:.4f}" for v in bbox)})

    async def fetch_country_locations(self, countries_id: int) -> list[Location]:
        """Every OpenAQ location in one country, oldest id first (ADR 0019). The list is paged;
        the cap is checked as pages arrive, before any latest values are asked for."""
        found: list[Location] = []
        for page_number in range(1, MAX_PAGES + 1):
            page = self._parse(
                _LocationsPage,
                await self._get(
                    "/locations",
                    {
                        "countries_id": countries_id,
                        "limit": LOCATIONS_PAGE_SIZE,
                        "page": page_number,
                    },
                ),
            )
            found.extend(page.results)
            if len(found) > self._max_stations:
                raise PermanentUpstreamError(
                    "too_many_stations",
                    f"The country contains more than {self._max_stations} stations.",
                )
            if len(page.results) < LOCATIONS_PAGE_SIZE:
                break
        else:
            raise _invalid("OpenAQ listed more pages of locations than expected.")
        self._check_unique(found)
        self._check_lookup(found)
        return sorted(found, key=lambda location: location.id)

    async def fetch_latest(self, locations: Sequence[Location]) -> dict[int, Latest]:
        """The newest value of every sensor of these locations, from the bulk endpoint.

        `/parameters/{id}/latest` ignores a country, so each parameter is paged world-wide once
        (about 22 calls for pm25) and only the wanted sensors are kept. That replaces one call per
        station, which for Europe would take hours (ADR 0019)."""
        self._check_lookup(locations)
        wanted = {
            sensor.id: sensor.parameter.id
            for location in locations
            for sensor in location.sensors
            if sensor.parameter.id is not None
        }
        newest: dict[int, Latest] = {}
        for parameter_id in sorted(set(wanted.values())):
            for page_number in range(1, MAX_PAGES + 1):
                page = self._parse(
                    _RawPage,
                    await self._get(
                        f"/parameters/{parameter_id}/latest",
                        {"limit": LATEST_PAGE_SIZE, "page": page_number},
                    ),
                )
                for raw in page.results:
                    # The page is world-wide: a malformed value of someone else's sensor is not
                    # ours to reject. Only the sensors we asked about are validated strictly.
                    sensor_id = raw.get("sensorsId")
                    if not isinstance(sensor_id, int) or wanted.get(sensor_id) != parameter_id:
                        continue
                    item = self._parse(_Latest, raw)
                    # A list that changes while it is paged can repeat a sensor; keep the newest.
                    current = newest.get(item.sensorsId)
                    if current is None or item.datetime.utc > current.datetime.utc:
                        newest[item.sensorsId] = item
                if len(page.results) < LATEST_PAGE_SIZE:
                    break
            else:
                raise _invalid("OpenAQ returned more pages of latest values than expected.")
        return newest

    @classmethod
    def station_of(cls, location: Location, latest: dict[int, Latest]) -> StationSnapshot:
        items = [latest[s.id] for s in location.sensors if s.id in latest]
        return cls._station(location, items)

    async def _fetch_located(self, selector: dict[str, Any]) -> list[StationSnapshot]:
        page = self._parse(
            _LocationsPage,
            await self._get("/locations", {**selector, "limit": LOCATIONS_PAGE_SIZE}),
        )
        # Checked before the per-station calls, which are what use up the rate limit (ADR 0010).
        if (
            isinstance(page.meta.found, str)
            or page.meta.found > self._max_stations
            or len(page.results) > self._max_stations
        ):
            raise PermanentUpstreamError(
                "too_many_stations",
                f"The region contains more than {self._max_stations} stations.",
            )
        self._check_unique(page.results)
        stations = []
        for loc in sorted(page.results, key=lambda location: location.id):
            stations.append(await self._snapshot(loc))
        return stations

    @staticmethod
    def _check_lookup(locations: Sequence[Location]) -> None:
        """The bulk endpoint is asked per parameter id, so a sensor without one cannot be read."""
        for location in locations:
            for sensor in location.sensors:
                if sensor.parameter.id is None:
                    raise _invalid(f"Sensor {sensor.id} has no parameter id.")

    @staticmethod
    def _check_unique(locations: Sequence[Location]) -> None:
        ids = [loc.id for loc in locations]
        if len(set(ids)) != len(ids):
            raise _invalid("OpenAQ returned the same location more than once.")

    async def fetch_history(
        self, location_id: int, property_name: str, *, start: datetime, end: datetime
    ) -> StationHistory:
        """Hourly values of one pollutant at one location, oldest first, one per hour.

        Two calls: the location's sensors (to find the pollutant's sensor), then that sensor's
        hourly values. A location without a sensor for the pollutant has no history."""
        sensors = self._parse(
            _SensorsPage, await self._get(f"/locations/{location_id}/sensors", {})
        )
        sensor = next((s for s in sensors.results if s.parameter.name == property_name), None)
        if sensor is None:
            return StationHistory(unit=None, points=[])
        limit = max(int((end - start).total_seconds() / 3600) + 2, 3)
        page = self._parse(
            _HoursPage,
            await self._get(
                f"/sensors/{sensor.id}/hours",
                {
                    # `date_from` / `date_to` are silently ignored by OpenAQ, which then answers
                    # with the oldest data and status 200; these are the real names (ADR 0014).
                    "datetime_from": _utc(start),
                    "datetime_to": _utc(end),
                    "limit": limit,
                },
            ),
        )
        # OpenAQ answers oldest first, so a capped answer would lose the newest hours: the ones a
        # trend is for. One result per hour fits the limit; more means something is off.
        if isinstance(page.meta.found, str) or page.meta.found > limit:
            raise _invalid("OpenAQ returned more hours than were asked for.")
        by_hour: dict[datetime, float] = {}
        for item in page.results:
            if not is_missing_marker(item.value):
                # Two results for the same hour would draw a vertical jump; the first one wins.
                by_hour.setdefault(item.period.datetimeTo.utc, item.value)
        points = [HistoryPoint(at.astimezone(UTC), by_hour[at]) for at in sorted(by_hour)]
        return StationHistory(unit=sensor.parameter.units, points=points)

    async def _snapshot(self, loc: _Location) -> StationSnapshot:
        latest = self._parse(_LatestPage, await self._get(f"/locations/{loc.id}/latest", {}))
        return self._station(loc, latest.results)

    @staticmethod
    def _station(loc: _Location, items: Sequence[_Latest]) -> StationSnapshot:
        sensors = {s.id: s.parameter for s in loc.sensors}
        readings: dict[str, Reading] = {}
        for item in items:
            parameter = sensors.get(item.sensorsId)
            if parameter is None:
                raise _invalid(f"Latest value for unknown sensor {item.sensorsId}.")
            if is_missing_marker(item.value):
                continue
            reading = Reading(item.value, parameter.units, item.datetime.utc)
            current = readings.get(parameter.name)
            if current is None or reading.observed_at > current.observed_at:
                readings[parameter.name] = reading
        return StationSnapshot(
            location_id=loc.id,
            name=loc.name or f"Location {loc.id}",
            longitude=loc.coordinates.longitude,
            latitude=loc.coordinates.latitude,
            readings=readings,
        )

    @staticmethod
    def _parse[T: BaseModel](model: type[T], body: Any) -> T:
        try:
            return model.model_validate(body)
        except ValidationError as exc:
            raise _invalid(
                f"OpenAQ response did not match the expected shape: {exc.error_count()} problem(s)."
            ) from None

    async def _get(self, path: str, params: dict[str, Any]) -> Any:
        for attempt in range(self._retries + 1):
            try:
                return await self._get_once(path, params)
            except TransientUpstreamError as exc:
                if attempt == self._retries:
                    raise
                wait = (
                    exc.retry_after
                    if exc.retry_after is not None
                    else self._retry_wait * 2**attempt
                )
                await self._sleep(min(wait, MAX_PAUSE_SECONDS))
        raise AssertionError("unreachable")  # the loop returns or raises on its last attempt

    async def _get_once(self, path: str, params: dict[str, Any]) -> Any:
        if self._min_interval:
            now = self._clock()
            if self._next_start > now:
                await self._sleep(self._next_start - now)
            self._next_start = max(now, self._next_start) + self._min_interval
        if self._pause_before_next:
            await self._sleep(self._pause_before_next)
            self._pause_before_next = 0.0
        try:
            response = await self._http.get(path, params=params)
        except httpx.HTTPError as exc:
            raise TransientUpstreamError(f"OpenAQ request failed: {type(exc).__name__}") from None
        self._note_rate_limit(response)
        status = response.status_code
        if status == 429 or status >= 500:
            raise TransientUpstreamError(
                f"OpenAQ answered {status}.", self._reset_seconds(response)
            )
        if status in (401, 403):
            raise PermanentUpstreamError(
                "upstream_unauthorized", f"OpenAQ rejected the API key ({status})."
            )
        if status >= 400:
            raise _invalid(f"OpenAQ answered {status}.")
        try:
            return response.json()
        except ValueError:
            raise _invalid("OpenAQ response was not JSON.") from None

    @staticmethod
    def _reset_seconds(response: httpx.Response) -> float | None:
        raw = response.headers.get("x-ratelimit-reset") or response.headers.get("retry-after")
        try:
            seconds = float(raw) if raw is not None else None
        except ValueError:
            return None
        if seconds is None or not math.isfinite(seconds) or seconds < 0:
            return None
        return min(seconds, MAX_PAUSE_SECONDS)

    def _note_rate_limit(self, response: httpx.Response) -> None:
        remaining = response.headers.get("x-ratelimit-remaining")
        reset = self._reset_seconds(response)
        if (
            remaining is not None
            and reset is not None
            and remaining.isdigit()
            and int(remaining) == 0
        ):
            self._pause_before_next = reset
