"""OpenAQ v3 client. Everything it returns is untrusted input (AGENTS.md): shape, ranges and
timestamps are validated here, and any violation fails the whole fetch rather than storing a
partial result."""

import asyncio
import math
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Annotated, Any

import httpx
from pydantic import AwareDatetime, BaseModel, Field, ValidationError, field_validator

LOCATIONS_PAGE_SIZE = 1000
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
    ) -> None:
        self._http = http
        self._max_stations = max_stations
        self._sleep = sleep
        self._pause_before_next: float = 0.0

    async def fetch_stations(self, bbox: list[float]) -> list[StationSnapshot]:
        page = self._parse(
            _LocationsPage,
            await self._get(
                "/locations",
                {"bbox": ",".join(f"{v:.4f}" for v in bbox), "limit": LOCATIONS_PAGE_SIZE},
            ),
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
        ids = [loc.id for loc in page.results]
        if len(set(ids)) != len(ids):
            raise _invalid("OpenAQ returned the same location more than once.")
        stations = []
        for loc in sorted(page.results, key=lambda location: location.id):
            stations.append(await self._snapshot(loc))
        return stations

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
        sensors = {s.id: s.parameter for s in loc.sensors}
        latest = self._parse(_LatestPage, await self._get(f"/locations/{loc.id}/latest", {}))
        readings: dict[str, Reading] = {}
        for item in latest.results:
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
