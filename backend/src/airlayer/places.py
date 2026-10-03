"""Place search through Photon (OpenStreetMap data), so a region can be defined by name (ADR 0013).

Photon's answer is untrusted input, like OpenAQ's: its shape and numbers are checked here, a result
in an unexpected shape is dropped, and an answer that is not the expected shape at all is a
failure. Everything user-facing a result carries is text; the caller must never treat it as HTML.

State (the cache, the rate limit, the cooldown) lives in memory, per process: with several worker
processes each keeps its own, so the real limit towards Photon is the per-process limit times the
number of workers."""

import asyncio
import logging
import math
import time
from collections import OrderedDict, deque
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Annotated, Literal

import httpx
from pydantic import BaseModel, Field, ValidationError, field_validator

from airlayer.config import get_settings

logger = logging.getLogger(__name__)

Bbox = tuple[float, float, float, float]

# Boxes are computed in whole ten-thousandths of a degree (the 4 decimals a region box carries),
# so rounding noise in floating point can never push a box over a limit.
SCALE = 10_000
# Starting values (api-contracts.md section 6): a region box is never narrower than 0.1 degrees,
# so a park or a street is not an unusable sliver, and never wider than the 2 degrees a region
# may span.
MIN_SIDE = 1_000
MAX_SIDE = 20_000
MAX_NAME_LENGTH = 200
MAX_KIND_LENGTH = 50
MAX_DETAIL_LENGTH = 300
MAX_RESULTS = 5
# More than are returned, because results with the same name and detail are collapsed.
REQUESTED_RESULTS = 10


class ProviderUnavailable(Exception):
    """Photon was unreachable, slow, answered with an error, or sent something unusable."""


class RateLimited(Exception):
    """This server has already asked Photon too often in a short time."""


@dataclass(frozen=True)
class Place:
    id: str
    name: str
    detail: str
    kind: str
    point: tuple[float, float]
    bbox: Bbox | None


def _units(value: float) -> int:
    # The tiny offset hides multiplication noise (4.7287 * 10000 is 47286.99999999999).
    return round(value * SCALE + 1e-6) if value >= 0 else -round(-value * SCALE + 1e-6)


def _widen(low: int, high: int) -> tuple[int, int]:
    if high - low >= MIN_SIDE:
        return low, high
    start = (low + high - MIN_SIDE) // 2
    return start, start + MIN_SIDE


def _shift_inside(low: int, high: int, limit: int) -> tuple[int, int]:
    if low < -limit:
        low, high = -limit, high + (-limit - low)
    if high > limit:
        low, high = low - (high - limit), limit
    return low, high


def fit_bbox(point: tuple[float, float], extent: Sequence[float] | None) -> Bbox | None:
    """A box that is a valid region (api-contracts.md section 1) for a place, or None when the
    place is too large (or its extent too strange) to be one. `extent` is Photon's
    [west, north, east, south]."""
    if extent is None:
        west = east = point[0]
        south = north = point[1]
    else:
        if len(extent) != 4 or not all(math.isfinite(v) for v in extent):
            return None
        west, north, east, south = extent
        if west > east or south > north:
            return None
        if not (-180 <= west <= 180 and -180 <= east <= 180):
            return None
        if not (-90 <= south <= 90 and -90 <= north <= 90):
            return None
    w, e = _units(west), _units(east)
    s, n = _units(south), _units(north)
    if e - w > MAX_SIDE or n - s > MAX_SIDE:
        return None
    w, e = _shift_inside(*_widen(w, e), 180 * SCALE)
    s, n = _shift_inside(*_widen(s, n), 90 * SCALE)
    return (w / SCALE, s / SCALE, e / SCALE, n / SCALE)


_Number = Annotated[float, Field(strict=True, allow_inf_nan=False)]
_Text = Annotated[str, Field(strict=True)]


class _Geometry(BaseModel):
    coordinates: Annotated[list[_Number], Field(min_length=2, max_length=2)]

    @field_validator("coordinates")
    @classmethod
    def inside_the_world(cls, v: list[float]) -> list[float]:
        if not (-180 <= v[0] <= 180 and -90 <= v[1] <= 90):
            raise ValueError("coordinates out of range")
        return v


class _Properties(BaseModel):
    osm_type: Literal["N", "W", "R"]
    osm_id: Annotated[int, Field(strict=True, ge=0)]
    name: Annotated[str, Field(strict=True, min_length=1)]
    type: _Text | None = None
    osm_value: _Text | None = None
    city: _Text | None = None
    county: _Text | None = None
    state: _Text | None = None
    country: _Text | None = None
    extent: Annotated[list[_Number], Field(min_length=4, max_length=4)] | None = None


class _Feature(BaseModel):
    geometry: _Geometry
    properties: _Properties


def _place(raw: object) -> Place | None:
    try:
        feature = _Feature.model_validate(raw)
    except ValidationError:
        return None
    props = feature.properties
    detail_parts: list[str] = []
    for part in (props.city, props.county, props.state, props.country):
        if part and part != props.name and part not in detail_parts:
            detail_parts.append(part)
    point = (feature.geometry.coordinates[0], feature.geometry.coordinates[1])
    return Place(
        id=f"{props.osm_type}{props.osm_id}",
        name=props.name[:MAX_NAME_LENGTH],
        detail=", ".join(detail_parts)[:MAX_DETAIL_LENGTH],
        kind=(props.type or props.osm_value or "place")[:MAX_KIND_LENGTH],
        point=point,
        bbox=fit_bbox(point, props.extent),
    )


def make_places_http_client(*, base_url: str, timeout: float, user_agent: str) -> httpx.AsyncClient:
    # Photon asks for fair use; saying who is calling lets them contact us instead of blocking.
    return httpx.AsyncClient(
        base_url=base_url, headers={"User-Agent": user_agent}, timeout=httpx.Timeout(timeout)
    )


class PlaceSearch:
    def __init__(
        self,
        http: httpx.AsyncClient,
        *,
        ttl_seconds: float = 600.0,
        max_entries: int = 500,
        max_upstream: int = 20,
        window_seconds: float = 10.0,
        cooldown_seconds: float = 30.0,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._http = http
        self._ttl = ttl_seconds
        self._max_entries = max_entries
        self._max_upstream = max_upstream
        self._window = window_seconds
        self._cooldown = cooldown_seconds
        self._clock = clock
        self._cache: OrderedDict[str, tuple[float, list[Place]]] = OrderedDict()
        self._upstream_calls: deque[float] = deque()
        self._in_flight: dict[str, asyncio.Task[list[Place]]] = {}
        self._cooling_until = 0.0

    @property
    def cached_queries(self) -> int:
        return len(self._cache)

    async def aclose(self) -> None:
        await self._http.aclose()

    async def search(self, text: str) -> list[Place]:
        # Case and spacing do not change what a person means, so they share one cache entry.
        key = " ".join(text.casefold().split())
        now = self._clock()
        cached = self._cache.get(key)
        if cached is not None and cached[0] > now:
            self._cache.move_to_end(key)
            return list(cached[1])
        task = self._in_flight.get(key)
        if task is None:
            # After a failure Photon is left alone for a while, whatever is asked meanwhile.
            if now < self._cooling_until:
                raise ProviderUnavailable
            self._take_upstream_slot(now)
            task = asyncio.ensure_future(self._fetch_and_store(key, text, now))
            self._in_flight[key] = task
        # Shielded, so one impatient caller cannot cancel the answer the others are waiting for.
        return list(await asyncio.shield(task))

    async def _fetch_and_store(self, key: str, text: str, now: float) -> list[Place]:
        try:
            places = await self._ask(text)
        except ProviderUnavailable:
            self._cooling_until = self._clock() + self._cooldown
            raise
        finally:
            self._in_flight.pop(key, None)
        self._cache[key] = (now + self._ttl, places)
        self._cache.move_to_end(key)
        while len(self._cache) > self._max_entries:
            self._cache.popitem(last=False)
        return places

    def _take_upstream_slot(self, now: float) -> None:
        while self._upstream_calls and self._upstream_calls[0] <= now - self._window:
            self._upstream_calls.popleft()
        if len(self._upstream_calls) >= self._max_upstream:
            raise RateLimited
        self._upstream_calls.append(now)

    async def _ask(self, text: str) -> list[Place]:
        try:
            response = await self._http.get("/api/", params={"q": text, "limit": REQUESTED_RESULTS})
        except httpx.HTTPError as exc:
            # The exception text can contain the request URL, so only its type is logged or kept.
            logger.warning("Place search request failed: %s", type(exc).__name__)
            raise ProviderUnavailable from None
        if response.status_code != 200:
            logger.warning("Place search answered %s", response.status_code)
            raise ProviderUnavailable
        try:
            body = response.json()
        except ValueError:
            logger.warning("Place search answered with something that is not JSON")
            raise ProviderUnavailable from None
        if not isinstance(body, dict) or not isinstance(body.get("features"), list):
            logger.warning("Place search answered in an unexpected shape")
            raise ProviderUnavailable
        places: list[Place] = []
        seen: set[tuple[str, str]] = set()
        for raw in body["features"]:
            place = _place(raw)
            if place is None or (place.name, place.detail) in seen:
                continue
            seen.add((place.name, place.detail))
            places.append(place)
            if len(places) == MAX_RESULTS:
                break
        return places


_instance: PlaceSearch | None = None


def get_place_search() -> PlaceSearch:
    """One shared client for the process, so the cache and the rate limit are shared too."""
    global _instance  # noqa: PLW0603 - a process-wide singleton is the point
    if _instance is None:
        settings = get_settings()
        _instance = PlaceSearch(
            make_places_http_client(
                base_url=settings.places_base_url,
                timeout=settings.places_timeout_seconds,
                user_agent=settings.places_user_agent,
            ),
            ttl_seconds=settings.places_cache_seconds,
            max_upstream=settings.places_max_upstream_per_window,
            window_seconds=settings.places_window_seconds,
            cooldown_seconds=settings.places_cooldown_seconds,
        )
    return _instance


async def close_place_search() -> None:
    global _instance  # noqa: PLW0603
    if _instance is not None:
        await _instance.aclose()
        _instance = None
