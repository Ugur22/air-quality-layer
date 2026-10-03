"""OpenAQ v3 client. Everything it returns is untrusted input (AGENTS.md): shape, ranges and
timestamps are validated here, and any violation fails the whole fetch rather than storing a
partial result."""

import asyncio
import math
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Annotated, Any

import httpx
from pydantic import AwareDatetime, BaseModel, Field, ValidationError, field_validator

LOCATIONS_PAGE_SIZE = 1000
# Never sleep longer than the rate-limit window itself, whatever the header claims.
MAX_PAUSE_SECONDS = 60.0
# OpenAQ data carries -999 where a sensor has no measurement; it is not a value (seen in real
# responses). Only this exact marker is dropped: small negatives are legitimate readings.
MISSING_VALUE = -999.0


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


@dataclass(frozen=True)
class StationSnapshot:
    location_id: int
    name: str
    longitude: float
    latitude: float
    readings: dict[str, Reading]


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

    async def _snapshot(self, loc: _Location) -> StationSnapshot:
        sensors = {s.id: s.parameter for s in loc.sensors}
        latest = self._parse(_LatestPage, await self._get(f"/locations/{loc.id}/latest", {}))
        readings: dict[str, Reading] = {}
        for item in latest.results:
            parameter = sensors.get(item.sensorsId)
            if parameter is None:
                raise _invalid(f"Latest value for unknown sensor {item.sensorsId}.")
            if item.value == MISSING_VALUE:
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
