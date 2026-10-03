# ruff: noqa: F811 - `make_layer` is a pytest fixture imported from test_map_layers
import asyncio
from collections.abc import Callable, Iterator
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

import httpx
import pytest
from httpx import AsyncClient

from airlayer.history import HistoryProvider, get_history_provider
from airlayer.main import app
from tests.conftest import Tenant
from tests.test_map_layers import Layer, get_layer, make_layer, reading  # noqa: F401

NOW = datetime(2026, 10, 3, 14, 6, 13, tzinfo=UTC)
# location id 1 is "Low" in test_map_layers.STATIONS (pm25 and no2); 4 is "NoPm" (no2 only).
SENSORS = {
    1: [(11, "pm25"), (12, "no2")],
    2: [(21, "pm25")],
    3: [(31, "pm25"), (32, "no2")],
    4: [(42, "no2")],
}


def hour(end: str, value: Any, name: str = "pm25") -> dict[str, Any]:
    return {
        "value": value,
        "parameter": {"id": 2, "name": name, "units": "µg/m³", "displayName": None},
        "period": {
            "label": "1hour",
            "interval": "01:00:00",
            "datetimeFrom": {"utc": end, "local": end},
            "datetimeTo": {"utc": end, "local": end},
        },
        "coordinates": None,
        "summary": None,
    }


DEFAULT_HOURS = [
    hour("2026-10-02T15:00:00Z", 3.9),
    hour("2026-10-02T16:00:00Z", 4.5),
    hour("2026-10-02T17:00:00Z", -1.5),
]


class Upstream:
    """A fake OpenAQ serving sensors per location and hourly values per sensor, with a call log."""

    def __init__(self, hours: list[dict[str, Any]] | None = None) -> None:
        self.hours = DEFAULT_HOURS if hours is None else hours
        self.calls: list[httpx.Request] = []
        self.fail_with: httpx.Response | Exception | None = None
        self.body_override: Any = None

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.calls.append(request)
        if isinstance(self.fail_with, Exception):
            raise self.fail_with
        if self.fail_with is not None:
            return self.fail_with
        parts = request.url.path.strip("/").split("/")
        if self.body_override is not None:
            return httpx.Response(200, json=self.body_override)
        if parts[-1] == "sensors" and parts[-3] == "locations":
            location = int(parts[-2])
            return httpx.Response(
                200,
                json={
                    "meta": {"found": 2},
                    "results": [
                        {
                            "id": sid,
                            "name": f"{name} µg/m³",
                            "parameter": {"id": 1, "name": name, "units": "µg/m³"},
                        }
                        for sid, name in SENSORS.get(location, [])
                    ],
                },
            )
        if parts[-1] == "hours" and parts[-3] == "sensors":
            return httpx.Response(
                200, json={"meta": {"found": len(self.hours)}, "results": self.hours}
            )
        return httpx.Response(404, json={})


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


@pytest.fixture
def upstream() -> Iterator[Upstream]:
    fake = Upstream()
    http = httpx.AsyncClient(transport=httpx.MockTransport(fake), base_url="https://openaq.test")
    clock = Clock()
    provider = HistoryProvider(http, ttl_seconds=300, clock=clock, now=lambda: NOW)
    provider.test_clock = clock  # type: ignore[attr-defined]
    app.dependency_overrides[get_history_provider] = lambda: provider
    yield fake
    app.dependency_overrides.pop(get_history_provider, None)


def history_url(layer: Layer, station_id: str) -> str:
    return f"{layer.url}/stations/{station_id}/history"


async def station_id(client: AsyncClient, layer: Layer, name: str = "Low") -> str:
    body = (await get_layer(client, layer)).json()
    return str(
        next(f["id"] for f in body["stations"]["features"] if f["properties"]["name"] == name)
    )


async def get_history(
    client: AsyncClient,
    layer: Layer,
    sid: str,
    params: dict[str, str] | None = None,
    tenant: Tenant | None = None,
) -> httpx.Response:
    return await client.get(
        history_url(layer, sid),
        params={"property": "pm25"} | (params or {}),
        headers=(tenant or layer.tenant).headers,
    )


async def test_returns_hourly_points_oldest_first_in_the_documented_shape(
    client: AsyncClient, make_layer: Callable[..., Layer], upstream: Upstream
) -> None:
    layer = make_layer()
    sid = await station_id(client, layer)

    response = await get_history(client, layer, sid)

    assert response.status_code == 200
    assert response.json() == {
        "history": {
            "property": "pm25",
            "unit": "µg/m³",
            "interval": "hour",
            "from": "2026-10-02T14:06:13Z",
            "to": "2026-10-03T14:06:13Z",
            "points": [
                {"at": "2026-10-02T15:00:00Z", "value": 3.9},
                {"at": "2026-10-02T16:00:00Z", "value": 4.5},
                {"at": "2026-10-02T17:00:00Z", "value": -1.5},
            ],
        }
    }


async def test_asks_openaq_for_the_right_sensor_and_names_the_time_range_correctly(
    client: AsyncClient, make_layer: Callable[..., Layer], upstream: Upstream
) -> None:
    layer = make_layer()
    sid = await station_id(client, layer)

    await get_history(client, layer, sid, {"hours": "6"})

    sensors, hours = upstream.calls
    assert sensors.url.path.endswith("/locations/1/sensors")
    assert hours.url.path.endswith("/sensors/11/hours")
    query = dict(hours.url.params)
    # `date_from`/`date_to` are silently ignored by OpenAQ, which then answers with 2016 data.
    assert "date_from" not in query and "date_to" not in query
    assert query["datetime_from"] == "2026-10-03T08:06:13Z"
    assert query["datetime_to"] == "2026-10-03T14:06:13Z"


async def test_values_at_or_below_the_missing_data_marker_threshold_are_left_out(
    client: AsyncClient, make_layer: Callable[..., Layer], upstream: Upstream
) -> None:
    upstream.hours = [
        hour("2026-10-02T15:00:00Z", -999),
        hour("2026-10-02T16:00:00Z", -998),
        hour("2026-10-02T17:00:00Z", -990),
        hour("2026-10-02T18:00:00Z", -989.9),
        hour("2026-10-02T19:00:00Z", 5.0),
    ]
    layer = make_layer()
    sid = await station_id(client, layer)

    points = (await get_history(client, layer, sid)).json()["history"]["points"]

    assert [p["value"] for p in points] == [-989.9, 5.0]


async def test_points_are_sorted_and_one_per_hour(
    client: AsyncClient, make_layer: Callable[..., Layer], upstream: Upstream
) -> None:
    upstream.hours = [
        hour("2026-10-02T17:00:00Z", 3.0),
        hour("2026-10-02T15:00:00Z", 1.0),
        hour("2026-10-02T15:00:00Z", 9.0),
    ]
    layer = make_layer()
    sid = await station_id(client, layer)

    points = (await get_history(client, layer, sid)).json()["history"]["points"]

    assert [p["at"] for p in points] == ["2026-10-02T15:00:00Z", "2026-10-02T17:00:00Z"]


async def test_an_empty_window_is_an_empty_list_not_an_error(
    client: AsyncClient, make_layer: Callable[..., Layer], upstream: Upstream
) -> None:
    upstream.hours = []
    layer = make_layer()
    sid = await station_id(client, layer)

    body = (await get_history(client, layer, sid)).json()["history"]

    assert body["points"] == []
    assert body["unit"] == "µg/m³"


async def test_a_station_without_a_sensor_for_the_property_has_no_points_and_no_unit(
    client: AsyncClient, make_layer: Callable[..., Layer], upstream: Upstream
) -> None:
    layer = make_layer()
    sid = await station_id(client, layer, "NoPm")

    body = (await get_history(client, layer, sid)).json()["history"]

    assert body["points"] == []
    assert body["unit"] is None
    assert len(upstream.calls) == 1  # the sensor lookup only


async def test_a_repeat_request_is_served_from_the_cache(
    client: AsyncClient, make_layer: Callable[..., Layer], upstream: Upstream
) -> None:
    layer = make_layer()
    sid = await station_id(client, layer)

    first = await get_history(client, layer, sid)
    calls_after_first = len(upstream.calls)
    second = await get_history(client, layer, sid)

    assert first.json() == second.json()
    assert len(upstream.calls) == calls_after_first == 2


async def test_another_window_or_property_is_not_served_from_the_same_cache_entry(
    client: AsyncClient, make_layer: Callable[..., Layer], upstream: Upstream
) -> None:
    layer = make_layer()
    sid = await station_id(client, layer)

    await get_history(client, layer, sid)
    await get_history(client, layer, sid, {"hours": "48"})
    await get_history(client, layer, sid, {"property": "no2"})

    assert len(upstream.calls) == 6


async def test_the_cache_expires(
    client: AsyncClient, make_layer: Callable[..., Layer], upstream: Upstream
) -> None:
    layer = make_layer()
    sid = await station_id(client, layer)
    provider = app.dependency_overrides[get_history_provider]()

    await get_history(client, layer, sid)
    provider.test_clock.now += 301
    await get_history(client, layer, sid)

    assert len(upstream.calls) == 4


@pytest.mark.parametrize(
    "failure",
    [
        httpx.Response(429, headers={"x-ratelimit-reset": "5"}, json={}),
        httpx.Response(500, json={}),
        httpx.Response(401, json={"message": "no"}),
        httpx.Response(400, json={}),
        httpx.ConnectTimeout("slow"),
    ],
)
async def test_upstream_trouble_is_service_unavailable_and_not_cached(
    client: AsyncClient,
    make_layer: Callable[..., Layer],
    upstream: Upstream,
    failure: httpx.Response | Exception,
) -> None:
    layer = make_layer()
    sid = await station_id(client, layer)
    upstream.fail_with = failure

    response = await get_history(client, layer, sid)

    assert response.status_code == 503
    assert response.json()["error"]["code"] == "service_unavailable"
    upstream.fail_with = None
    assert (await get_history(client, layer, sid)).status_code == 200


@pytest.mark.parametrize(
    "body",
    [
        {"results": "nope"},
        {"results": [{"id": "x"}]},
        [],
    ],
)
async def test_a_malformed_sensor_answer_is_service_unavailable(
    client: AsyncClient, make_layer: Callable[..., Layer], upstream: Upstream, body: Any
) -> None:
    layer = make_layer()
    sid = await station_id(client, layer)
    upstream.body_override = body

    response = await get_history(client, layer, sid)

    assert response.status_code == 503


@pytest.mark.parametrize(
    "bad",
    [
        hour("2026-10-02T15:00:00Z", "12.4"),
        hour("2026-10-02T15:00:00Z", None),
        hour("2026-10-02T15:00:00Z", True),
        hour("not a time", 1.0),
        hour("2026-10-02T15:00:00", 1.0),
    ],
)
async def test_one_bad_hour_fails_the_whole_answer_instead_of_returning_partial_points(
    client: AsyncClient, make_layer: Callable[..., Layer], upstream: Upstream, bad: dict[str, Any]
) -> None:
    upstream.hours = [hour("2026-10-02T14:00:00Z", 2.0), bad]
    layer = make_layer()
    sid = await station_id(client, layer)

    response = await get_history(client, layer, sid)

    assert response.status_code == 503
    assert "points" not in response.text


async def test_a_property_the_layer_does_not_have_lists_the_valid_ones(
    client: AsyncClient, make_layer: Callable[..., Layer], upstream: Upstream
) -> None:
    layer = make_layer()
    sid = await station_id(client, layer)

    response = await get_history(client, layer, sid, {"property": "o3"})

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "validation_failed"
    assert "no2, pm25" in response.json()["error"]["message"]
    assert upstream.calls == []


async def test_property_is_required(
    client: AsyncClient, make_layer: Callable[..., Layer], upstream: Upstream
) -> None:
    layer = make_layer()
    sid = await station_id(client, layer)

    response = await client.get(history_url(layer, sid), headers=layer.tenant.headers)

    assert response.status_code == 400


@pytest.mark.parametrize("hours", ["0", "169", "-1", "x", "1.5", ""])
async def test_hours_must_be_a_whole_number_from_1_to_168(
    client: AsyncClient, make_layer: Callable[..., Layer], upstream: Upstream, hours: str
) -> None:
    layer = make_layer()
    sid = await station_id(client, layer)

    response = await get_history(client, layer, sid, {"hours": hours})

    assert response.status_code == 400
    assert upstream.calls == []


@pytest.mark.parametrize("hours", ["1", "168"])
async def test_the_limits_of_hours_are_allowed(
    client: AsyncClient, make_layer: Callable[..., Layer], upstream: Upstream, hours: str
) -> None:
    layer = make_layer()
    sid = await station_id(client, layer)

    assert (await get_history(client, layer, sid, {"hours": hours})).status_code == 200


async def test_another_organisation_gets_404_and_openaq_is_not_called(
    client: AsyncClient,
    make_layer: Callable[..., Layer],
    make_tenant: Callable[[], Tenant],
    upstream: Upstream,
) -> None:
    layer = make_layer()
    sid = await station_id(client, layer)

    response = await get_history(client, layer, sid, tenant=make_tenant())

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"
    assert upstream.calls == []


async def test_a_station_of_another_layer_is_404(
    client: AsyncClient, make_layer: Callable[..., Layer], upstream: Upstream
) -> None:
    layer, other = make_layer(), make_layer()
    sid_other = await station_id(client, other)

    assert (await get_history(client, layer, sid_other)).status_code == 404


@pytest.mark.parametrize("sid", [str(uuid4()), "not-a-uuid"])
async def test_an_unknown_or_malformed_station_id_is_404(
    client: AsyncClient, make_layer: Callable[..., Layer], upstream: Upstream, sid: str
) -> None:
    layer = make_layer()

    assert (await get_history(client, layer, sid)).status_code == 404


async def test_the_layer_of_a_failed_job_is_404(
    client: AsyncClient, make_layer: Callable[..., Layer], upstream: Upstream
) -> None:
    layer = make_layer(status="failed")

    assert (await get_history(client, layer, str(uuid4()))).status_code == 404


async def test_a_malformed_layer_id_is_404(client: AsyncClient, upstream: Upstream) -> None:
    response = await client.get(
        f"/api/v1/map-layers/nope/stations/{uuid4()}/history", params={"property": "pm25"}
    )

    assert response.status_code == 404


async def test_a_marker_value_that_was_stored_before_the_rule_does_not_count_as_a_property(
    client: AsyncClient, make_layer: Callable[..., Layer], upstream: Upstream
) -> None:
    layer = make_layer(
        stations={1: ("Only marker", 4.9, 52.37, {"pm25": reading(-998.0), "no2": reading(5.0)})}
    )
    sid = await station_id(client, layer, "Only marker")

    response = await get_history(client, layer, sid)

    assert response.status_code == 400  # pm25 is not one of the layer's property keys any more
    assert "no2" in response.json()["error"]["message"]


async def test_a_rate_limit_pause_is_a_503_at_once_not_a_wait(
    client: AsyncClient, make_layer: Callable[..., Layer], upstream: Upstream
) -> None:
    layer = make_layer()
    sid = await station_id(client, layer)
    upstream.fail_with = httpx.Response(
        200,
        headers={"x-ratelimit-remaining": "0", "x-ratelimit-reset": "30"},
        json={
            "meta": {"found": 0},
            "results": [{"id": 11, "parameter": {"name": "pm25", "units": "µg/m³"}}],
        },
    )

    response = await get_history(client, layer, sid)

    assert response.status_code == 503
    assert len(upstream.calls) == 1  # the second call was refused, not delayed


async def test_more_hours_than_asked_for_is_refused_instead_of_dropping_the_newest(
    client: AsyncClient, make_layer: Callable[..., Layer], upstream: Upstream
) -> None:
    upstream.hours = [hour(f"2026-10-02T{h:02d}:00:00Z", 1.0) for h in range(10)]
    layer = make_layer()
    sid = await station_id(client, layer)

    # hours=3 allows 5 results; the fake reports found=10.
    assert (await get_history(client, layer, sid, {"hours": "3"})).status_code == 503


async def test_a_non_utc_offset_from_openaq_is_served_as_utc(
    client: AsyncClient, make_layer: Callable[..., Layer], upstream: Upstream
) -> None:
    upstream.hours = [hour("2026-10-02T17:00:00+02:00", 2.0)]
    layer = make_layer()
    sid = await station_id(client, layer)

    points = (await get_history(client, layer, sid)).json()["history"]["points"]

    assert points == [{"at": "2026-10-02T15:00:00Z", "value": 2.0}]


async def test_identical_concurrent_requests_share_one_openaq_fetch(
    client: AsyncClient, make_layer: Callable[..., Layer]
) -> None:
    fake = Upstream()

    async def slow(request: httpx.Request) -> httpx.Response:
        await asyncio.sleep(0.05)
        return fake(request)

    provider = HistoryProvider(
        httpx.AsyncClient(transport=httpx.MockTransport(slow), base_url="https://openaq.test"),
        ttl_seconds=300,
        now=lambda: NOW,
    )
    app.dependency_overrides[get_history_provider] = lambda: provider
    try:
        layer = make_layer()
        sid = await station_id(client, layer)

        responses = await asyncio.gather(*[get_history(client, layer, sid) for _ in range(5)])
    finally:
        app.dependency_overrides.pop(get_history_provider, None)

    assert [r.status_code for r in responses] == [200] * 5
    assert len(fake.calls) == 2  # one sensor lookup, one hourly fetch, for all five


@pytest.fixture
def no_key() -> Iterator[None]:
    app.dependency_overrides[get_history_provider] = lambda: HistoryProvider(None, ttl_seconds=300)
    yield
    app.dependency_overrides.pop(get_history_provider, None)


async def test_without_an_api_key_a_valid_request_is_503(
    client: AsyncClient, make_layer: Callable[..., Layer], no_key: None
) -> None:
    layer = make_layer()
    sid = await station_id(client, layer)

    response = await get_history(client, layer, sid)

    assert response.status_code == 503
    assert response.json()["error"]["code"] == "service_unavailable"


async def test_without_an_api_key_bad_requests_are_still_404_and_400(
    client: AsyncClient,
    make_layer: Callable[..., Layer],
    make_tenant: Callable[[], Tenant],
    no_key: None,
) -> None:
    layer = make_layer()
    sid = await station_id(client, layer)

    assert (await get_history(client, layer, sid, tenant=make_tenant())).status_code == 404
    assert (await get_history(client, layer, str(uuid4()))).status_code == 404
    assert (await get_history(client, layer, sid, {"hours": "999"})).status_code == 400
    assert (await get_history(client, layer, sid, {"property": "o3"})).status_code == 400
