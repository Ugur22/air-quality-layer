"""Station history fetched from OpenAQ when asked, never stored (ADR 0014, api-contracts.md
section 7). OpenAQ's answer is untrusted input and is validated in `openaq.py`; any problem makes
the whole answer unavailable instead of returning partial points.

The cache lives in memory, per process, like place search: with several worker processes each
keeps its own, so the real call rate towards OpenAQ is the per-process rate times the workers."""

import asyncio
import logging
import time
from collections import OrderedDict
from collections.abc import Callable
from datetime import UTC, datetime, timedelta

import httpx

from airlayer.config import get_settings
from airlayer.openaq import (
    OpenAQClient,
    StationHistory,
    TransientUpstreamError,
    UpstreamError,
    make_http_client,
)

logger = logging.getLogger(__name__)

MAX_CACHED = 256


class HistoryUnavailable(Exception):
    """OpenAQ could not give a usable answer right now (or no API key is configured)."""


async def _do_not_wait(_: float) -> None:
    # The sync worker may sleep out a rate-limit window; a browser request must not hang for it.
    raise TransientUpstreamError("OpenAQ asked us to wait; not waiting inside a request.")


class HistoryProvider:
    def __init__(
        self,
        http: httpx.AsyncClient | None,
        *,
        ttl_seconds: float,
        clock: Callable[[], float] = time.monotonic,
        now: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self._http = http
        self._ttl = ttl_seconds
        self._clock = clock
        self._now = now
        self._cache: OrderedDict[tuple[int, str, int], tuple[float, StationHistory, datetime]] = (
            OrderedDict()
        )
        # Identical requests that arrive while one is being fetched share its answer, so a burst
        # of clicks on one station costs one pair of OpenAQ calls, not one pair per click.
        self._inflight: dict[
            tuple[int, str, int], asyncio.Task[tuple[StationHistory, datetime, datetime]]
        ] = {}

    async def history(
        self, location_id: int, property_name: str, hours: int
    ) -> tuple[StationHistory, datetime, datetime]:
        """The points plus the window they were asked for (start, end)."""
        if self._http is None:
            raise HistoryUnavailable  # no API key is configured
        key = (location_id, property_name, hours)
        cached = self._cache.get(key)
        if cached is not None and self._clock() - cached[0] < self._ttl:
            self._cache.move_to_end(key)
            return cached[1], cached[2] - timedelta(hours=hours), cached[2]
        task = self._inflight.get(key)
        if task is None:
            task = asyncio.ensure_future(self._fetch(self._http, key))
            self._inflight[key] = task
            task.add_done_callback(lambda _: self._inflight.pop(key, None))
        # Shielded: one client giving up must not cancel the fetch the others are waiting for.
        return await asyncio.shield(task)

    async def _fetch(
        self, http: httpx.AsyncClient, key: tuple[int, str, int]
    ) -> tuple[StationHistory, datetime, datetime]:
        location_id, property_name, hours = key
        end = self._now().replace(microsecond=0)
        start = end - timedelta(hours=hours)
        client = OpenAQClient(http, max_stations=0, sleep=_do_not_wait)
        try:
            result = await client.fetch_history(location_id, property_name, start=start, end=end)
        except UpstreamError as exc:
            # The reason (rate limit, key, shape) is for the logs, not for the browser.
            logger.warning("OpenAQ history unavailable (%s): %s", exc.code, exc)
            raise HistoryUnavailable from None
        self._cache[key] = (self._clock(), result, end)
        while len(self._cache) > MAX_CACHED:
            self._cache.popitem(last=False)
        return result, start, end

    async def aclose(self) -> None:
        if self._http is not None:
            await self._http.aclose()


_instance: HistoryProvider | None = None


def get_history_provider() -> HistoryProvider:
    """One shared client for the process, so the cache is shared too."""
    global _instance  # noqa: PLW0603 - a process-wide singleton is the point
    if _instance is None:
        settings = get_settings()
        api_key = settings.openaq_api_key.get_secret_value()
        # Without a key the provider still exists, so ids and parameters are checked (404, 400)
        # before a request is refused (503) for a reason only the server can fix.
        _instance = HistoryProvider(
            make_http_client(
                api_key=api_key,
                base_url=settings.openaq_base_url,
                timeout=settings.openaq_timeout_seconds,
            )
            if api_key
            else None,
            ttl_seconds=settings.history_cache_seconds,
        )
    return _instance


async def close_history_provider() -> None:
    global _instance  # noqa: PLW0603
    if _instance is not None:
        await _instance.aclose()
        _instance = None
