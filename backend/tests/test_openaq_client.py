from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any

import httpx
import pytest

from airlayer import openaq
from airlayer.openaq import (
    OpenAQClient,
    PermanentUpstreamError,
    TransientUpstreamError,
    make_http_client,
)

BBOX = [4.85, 52.35, 4.95, 52.40]
Handler = Callable[[httpx.Request], httpx.Response]


def sensor(sensor_id: int, name: str = "pm25", units: str = "µg/m³") -> dict[str, Any]:
    return {
        "id": sensor_id,
        "name": f"{name} {units}",
        "parameter": {"id": 1, "name": name, "units": units},
    }


def location(
    location_id: int, sensors: list[dict[str, Any]] | None = None, **overrides: Any
) -> dict[str, Any]:
    body: dict[str, Any] = {
        "id": location_id,
        "name": f"Station {location_id}",
        "coordinates": {"latitude": 52.37, "longitude": 4.9},
        "sensors": sensors if sensors is not None else [sensor(location_id * 10)],
    }
    return body | overrides


def latest(
    sensor_id: int, location_id: int, value: Any = 12.4, utc: Any = "2026-10-03T08:00:00Z"
) -> dict[str, Any]:
    return {
        "datetime": {"utc": utc, "local": "2026-10-03T10:00:00+02:00"},
        "value": value,
        "sensorsId": sensor_id,
        "locationsId": location_id,
    }


class Upstream:
    """A fake OpenAQ: a locations page plus per-location latest results, with a call log."""

    def __init__(
        self,
        locations: list[dict[str, Any]],
        latest_by_location: dict[int, list[dict[str, Any]]] | None = None,
        found: Any = None,
    ) -> None:
        self.locations = locations
        self.latest = latest_by_location or {}
        self.found = len(locations) if found is None else found
        self.calls: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.calls.append(request)
        path = request.url.path
        if path.endswith("/locations"):
            return httpx.Response(
                200, json={"meta": {"found": self.found}, "results": self.locations}
            )
        location_id = int(path.split("/")[-2])
        results = self.latest.get(location_id, [])
        return httpx.Response(200, json={"meta": {"found": len(results)}, "results": results})


def client_for(
    handler: Handler, max_stations: int = 50, sleeps: list[float] | None = None
) -> OpenAQClient:
    async def record(seconds: float) -> None:
        if sleeps is not None:
            sleeps.append(seconds)

    http = httpx.AsyncClient(
        transport=httpx.MockTransport(handler), base_url="https://openaq.test/v3"
    )
    return OpenAQClient(http, max_stations=max_stations, sleep=record)


async def test_stations_carry_readings_with_unit_and_observation_time() -> None:
    upstream = Upstream(
        [location(1, [sensor(11, "pm25"), sensor(12, "no2")]), location(2)],
        {
            1: [latest(11, 1, 12.4), latest(12, 1, 30.0, "2026-10-03T07:00:00Z")],
            2: [latest(20, 2, 4.2)],
        },
    )

    stations = await client_for(upstream).fetch_stations(BBOX)

    assert [s.location_id for s in stations] == [1, 2]
    first = stations[0]
    assert (first.name, first.longitude, first.latitude) == ("Station 1", 4.9, 52.37)
    assert first.readings["pm25"].value == 12.4
    assert first.readings["pm25"].unit == "µg/m³"
    assert first.readings["pm25"].observed_at == datetime(2026, 10, 3, 8, 0, tzinfo=UTC)
    assert first.readings["no2"].observed_at == datetime(2026, 10, 3, 7, 0, tzinfo=UTC)
    assert stations[1].readings["pm25"].value == 4.2


async def test_request_uses_the_bbox_in_openaq_order_and_asks_for_a_full_page() -> None:
    upstream = Upstream([])

    await client_for(upstream).fetch_stations(BBOX)

    (request,) = upstream.calls
    assert request.url.params["bbox"] == "4.8500,52.3500,4.9500,52.4000"
    assert request.url.params["limit"] == "1000"


async def test_two_sensors_for_one_parameter_keep_the_most_recent_reading() -> None:
    upstream = Upstream(
        [location(1, [sensor(11, "pm25"), sensor(12, "pm25")])],
        {
            1: [
                latest(11, 1, 5.0, "2026-10-03T06:00:00Z"),
                latest(12, 1, 9.0, "2026-10-03T08:00:00Z"),
            ]
        },
    )

    (station,) = await client_for(upstream).fetch_stations(BBOX)

    assert station.readings["pm25"].value == 9.0


async def test_the_minus_999_missing_value_marker_is_not_stored_as_a_reading() -> None:
    # Seen in real OpenAQ data: a sensor with no measurement reports -999 instead of nothing.
    upstream = Upstream(
        [location(1, [sensor(11, "pm25"), sensor(12, "no")])],
        {1: [latest(11, 1, 7.6), latest(12, 1, -999.0)]},
    )

    (station,) = await client_for(upstream).fetch_stations(BBOX)

    assert set(station.readings) == {"pm25"}


@pytest.mark.parametrize("marker", [-999.0, -998.0, -995.0, -990.0])
async def test_every_missing_data_marker_at_or_below_minus_990_is_dropped(marker: float) -> None:
    # Seen in real OpenAQ data: -999, -998 and -995 (ADR 0014).
    upstream = Upstream(
        [location(1, [sensor(11, "pm25"), sensor(12, "no")])],
        {1: [latest(11, 1, 7.6), latest(12, 1, marker)]},
    )

    (station,) = await client_for(upstream).fetch_stations(BBOX)

    assert set(station.readings) == {"pm25"}


async def test_a_value_just_above_the_marker_threshold_is_kept() -> None:
    upstream = Upstream([location(1)], {1: [latest(10, 1, -989.9)]})

    (station,) = await client_for(upstream).fetch_stations(BBOX)

    assert station.readings["pm25"].value == -989.9


async def test_small_negative_values_are_real_measurements_and_are_kept() -> None:
    upstream = Upstream([location(1)], {1: [latest(10, 1, -0.4)]})

    (station,) = await client_for(upstream).fetch_stations(BBOX)

    assert station.readings["pm25"].value == -0.4


async def test_a_station_with_no_latest_values_is_kept_with_no_readings() -> None:
    upstream = Upstream([location(1)], {1: []})

    (station,) = await client_for(upstream).fetch_stations(BBOX)

    assert station.readings == {}


async def test_zero_locations_is_a_valid_empty_result_and_makes_no_further_calls() -> None:
    upstream = Upstream([])

    assert await client_for(upstream).fetch_stations(BBOX) == []
    assert len(upstream.calls) == 1


@pytest.mark.parametrize("found", [51, 5000, ">1000"])
async def test_more_stations_than_the_cap_fails_before_any_per_station_call(found: Any) -> None:
    upstream = Upstream([location(1)], found=found)

    with pytest.raises(PermanentUpstreamError) as caught:
        await client_for(upstream, max_stations=50).fetch_stations(BBOX)

    assert caught.value.code == "too_many_stations"
    assert len(upstream.calls) == 1


def respond(status: int, **kwargs: Any) -> Handler:
    return lambda request: httpx.Response(status, **kwargs)


@pytest.mark.parametrize("status", [401, 403])
async def test_rejected_key_is_permanent_and_unauthorized(status: int) -> None:
    with pytest.raises(PermanentUpstreamError) as caught:
        await client_for(respond(status, json={})).fetch_stations(BBOX)

    assert caught.value.code == "upstream_unauthorized"


@pytest.mark.parametrize("status", [400, 404, 422])
async def test_other_client_errors_are_permanent_invalid_responses(status: int) -> None:
    with pytest.raises(PermanentUpstreamError) as caught:
        await client_for(respond(status, json={"detail": "no"})).fetch_stations(BBOX)

    assert caught.value.code == "upstream_invalid_response"


@pytest.mark.parametrize("status", [429, 500, 502, 503])
async def test_rate_limit_and_server_errors_are_transient(status: int) -> None:
    with pytest.raises(TransientUpstreamError):
        await client_for(respond(status, json={})).fetch_stations(BBOX)


async def test_timeouts_and_connection_failures_are_transient() -> None:
    def timeout(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("slow", request=request)

    def refused(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("down", request=request)

    for handler in (timeout, refused):
        with pytest.raises(TransientUpstreamError):
            await client_for(handler).fetch_stations(BBOX)


async def test_429_reports_how_long_to_wait_from_the_reset_header() -> None:
    handler = respond(429, headers={"x-ratelimit-reset": "42"}, json={})

    with pytest.raises(TransientUpstreamError) as caught:
        await client_for(handler).fetch_stations(BBOX)

    assert caught.value.retry_after == 42


@pytest.mark.parametrize("reset", ["nan", "inf", "-5", "soon"])
async def test_a_nonsensical_reset_header_is_ignored(reset: str) -> None:
    handler = respond(429, headers={"x-ratelimit-reset": reset}, json={})

    with pytest.raises(TransientUpstreamError) as caught:
        await client_for(handler).fetch_stations(BBOX)

    assert caught.value.retry_after is None


async def test_client_pauses_until_reset_when_the_quota_is_used_up() -> None:
    upstream = Upstream([location(1), location(2)], {1: [latest(10, 1)], 2: [latest(20, 2)]})
    sleeps: list[float] = []

    def with_quota(request: httpx.Request) -> httpx.Response:
        response = upstream(request)
        response.headers["x-ratelimit-remaining"] = "0" if len(upstream.calls) == 2 else "30"
        response.headers["x-ratelimit-reset"] = "7"
        return response

    await client_for(with_quota, sleeps=sleeps).fetch_stations(BBOX)

    assert sleeps == [7]


def malformed_cases() -> list[Any]:
    ok = location(1)
    return [
        pytest.param(lambda: httpx.Response(200, text="<html>not json"), id="not-json"),
        pytest.param(lambda: httpx.Response(200, json=["a"]), id="json-not-an-object"),
        pytest.param(
            lambda: httpx.Response(200, json={"meta": {"found": 1}}), id="missing-results"
        ),
        pytest.param(
            lambda: httpx.Response(
                200, json={"meta": {"found": 1}, "results": [ok | {"coordinates": None}]}
            ),
            id="null-coordinates",
        ),
        pytest.param(
            lambda: httpx.Response(
                200,
                json={
                    "meta": {"found": 1},
                    "results": [ok | {"coordinates": {"latitude": 91, "longitude": 4}}],
                },
            ),
            id="latitude-out-of-range",
        ),
        pytest.param(
            lambda: httpx.Response(
                200,
                json={
                    "meta": {"found": 1},
                    "results": [ok | {"coordinates": {"latitude": 52, "longitude": 181}}],
                },
            ),
            id="longitude-out-of-range",
        ),
        pytest.param(
            lambda: httpx.Response(200, json={"meta": {"found": 1}, "results": [{"id": 1}]}),
            id="location-missing-fields",
        ),
        pytest.param(
            lambda: httpx.Response(
                200,
                json={
                    "meta": {"found": 1},
                    "results": [ok | {"sensors": [{"id": 1, "parameter": {"name": "pm25"}}]}],
                },
            ),
            id="sensor-without-units",
        ),
        pytest.param(
            lambda: httpx.Response(200, json={"results": [ok]}),
            id="missing-meta",
        ),
        pytest.param(
            lambda: httpx.Response(
                200, json={"meta": {"found": 1}, "results": [ok | {"id": True}]}
            ),
            id="boolean-location-id",
        ),
        pytest.param(
            lambda: httpx.Response(
                200, json={"meta": {"found": 1}, "results": [ok | {"id": 2**63}]}
            ),
            id="location-id-too-large-to-store",
        ),
        pytest.param(
            lambda: httpx.Response(200, json={"meta": {"found": 2}, "results": [ok, ok]}),
            id="duplicate-location-ids",
        ),
        pytest.param(
            lambda: httpx.Response(
                200,
                json={
                    "meta": {"found": 1},
                    "results": [ok | {"coordinates": {"latitude": "52", "longitude": 4}}],
                },
            ),
            id="string-coordinate",
        ),
        pytest.param(
            lambda: httpx.Response(
                200,
                json={
                    "meta": {"found": 1},
                    "results": [ok | {"sensors": [sensor(1, units="x" * 200)]}],
                },
            ),
            id="absurdly-long-unit",
        ),
    ]


@pytest.mark.parametrize("make_response", malformed_cases())
async def test_malformed_locations_response_is_a_permanent_invalid_response(
    make_response: Callable[[], httpx.Response],
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/locations"):
            return make_response()
        # A well-formed latest page, so only the locations body can be the reason for failure.
        return httpx.Response(200, json={"meta": {"found": 0}, "results": []})

    with pytest.raises(PermanentUpstreamError) as caught:
        await client_for(handler).fetch_stations(BBOX)

    assert caught.value.code == "upstream_invalid_response"


@pytest.mark.parametrize(
    "bad_latest",
    [
        pytest.param([latest(10, 1, value=None)], id="null-value"),
        pytest.param([latest(10, 1, value="high")], id="text-value"),
        pytest.param([latest(10, 1, value="12.4")], id="numeric-string-value"),
        pytest.param([latest(10, 1, value=True)], id="boolean-value"),
        pytest.param([{**latest(10, 1), "sensorsId": "10"}], id="string-sensor-id"),
        pytest.param([latest(10, 1, utc="not a date")], id="bad-timestamp"),
        pytest.param([latest(10, 1, utc="2026-10-03T08:00:00")], id="timestamp-without-timezone"),
        pytest.param([latest(999, 1)], id="unknown-sensor"),
        pytest.param([{"value": 1.0, "sensorsId": 10}], id="missing-datetime"),
    ],
)
async def test_malformed_latest_value_fails_the_whole_fetch(
    bad_latest: list[dict[str, Any]],
) -> None:
    upstream = Upstream([location(1)], {1: bad_latest})

    with pytest.raises(PermanentUpstreamError) as caught:
        await client_for(upstream).fetch_stations(BBOX)

    assert caught.value.code == "upstream_invalid_response"


async def test_http_client_sends_the_api_key_header_and_has_a_timeout() -> None:
    http = make_http_client(
        api_key="test-key-not-a-secret", base_url="https://openaq.test/v3", timeout=5
    )

    assert http.headers["x-api-key"] == "test-key-not-a-secret"
    assert http.timeout.read == 5
    await http.aclose()


def sensor_of(sensor_id: int, name: str, parameter_id: int, units: str = "µg/m³") -> dict[str, Any]:
    body = sensor(sensor_id, name, units)
    body["parameter"]["id"] = parameter_id
    return body


class Bulk:
    """A fake OpenAQ for the national pull (ADR 0019): locations per country, and latest values
    per parameter across the whole world, both paged the way the real API pages them."""

    def __init__(
        self,
        locations: dict[int, list[dict[str, Any]]] | None = None,
        latest_by_parameter: dict[int, list[dict[str, Any]]] | None = None,
    ) -> None:
        self.locations = locations or {}
        self.latest = latest_by_parameter or {}
        self.calls: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.calls.append(request)
        params = request.url.params
        limit = int(params["limit"])
        start = (int(params.get("page", "1")) - 1) * limit
        if request.url.path.endswith("/locations"):
            rows = self.locations.get(int(params["countries_id"]), [])
        else:
            rows = self.latest.get(int(request.url.path.split("/")[-2]), [])
        return httpx.Response(
            200, json={"meta": {"found": len(rows)}, "results": rows[start : start + limit]}
        )

    def paths(self) -> list[str]:
        return [call.url.path.removeprefix("/v3") for call in self.calls]


def bulk_client(bulk: Bulk, max_stations: int = 50, **kwargs: Any) -> OpenAQClient:
    http = httpx.AsyncClient(transport=httpx.MockTransport(bulk), base_url="https://openaq.test/v3")
    return OpenAQClient(http, max_stations=max_stations, **kwargs)


async def test_a_country_is_listed_by_its_id_across_pages(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(openaq, "LOCATIONS_PAGE_SIZE", 2)
    bulk = Bulk({94: [location(3), location(1), location(2)]})

    found = await bulk_client(bulk).fetch_country_locations(94)

    assert [loc.id for loc in found] == [1, 2, 3]
    assert [c.url.params["page"] for c in bulk.calls] == ["1", "2"]
    assert all(c.url.params["countries_id"] == "94" for c in bulk.calls)
    assert all("bbox" not in c.url.params for c in bulk.calls)


async def test_a_country_over_the_cap_is_refused_before_latest_values_are_asked_for() -> None:
    bulk = Bulk({94: [location(1), location(2)]})

    with pytest.raises(PermanentUpstreamError) as caught:
        await bulk_client(bulk, max_stations=1).fetch_country_locations(94)

    assert caught.value.code == "too_many_stations"
    assert len(bulk.calls) == 1


async def test_a_location_listed_twice_is_an_invalid_response() -> None:
    bulk = Bulk({94: [location(1), location(1)]})

    with pytest.raises(PermanentUpstreamError) as caught:
        await bulk_client(bulk).fetch_country_locations(94)

    assert caught.value.code == "upstream_invalid_response"


async def test_a_pager_that_never_ends_is_an_invalid_response(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(openaq, "LOCATIONS_PAGE_SIZE", 1)
    monkeypatch.setattr(openaq, "MAX_PAGES", 3)
    http = httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda request: httpx.Response(
                200, json={"meta": {"found": ">1"}, "results": [location(len(request.url.query))]}
            )
        ),
        base_url="https://openaq.test/v3",
    )

    with pytest.raises(PermanentUpstreamError) as caught:
        await OpenAQClient(http, max_stations=50).fetch_country_locations(94)

    assert caught.value.code == "upstream_invalid_response"


async def test_latest_values_cost_one_call_per_parameter_not_one_per_station() -> None:
    locations = [
        location(1, [sensor_of(11, "pm25", 2), sensor_of(12, "no2", 7)]),
        location(2, [sensor_of(21, "pm25", 2)]),
    ]
    bulk = Bulk(
        latest_by_parameter={
            2: [latest(11, 1, 12.4), latest(21, 2, 4.2)],
            7: [latest(12, 1, 30.0)],
        }
    )

    got = await bulk_client(bulk).fetch_latest(
        [openaq.Location.model_validate(x) for x in locations]
    )

    assert bulk.paths() == ["/parameters/2/latest", "/parameters/7/latest"]
    assert {sensor_id: item.value for sensor_id, item in got.items()} == {
        11: 12.4,
        12: 30.0,
        21: 4.2,
    }


async def test_latest_values_of_other_sensors_are_left_out_and_pages_are_followed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(openaq, "LATEST_PAGE_SIZE", 2)
    wanted = openaq.Location.model_validate(location(1, [sensor_of(11, "pm25", 2)]))
    # World-wide values: another country's sensors fill the first page, ours is on the second.
    bulk = Bulk(
        latest_by_parameter={2: [latest(900, 90, 1.0), latest(901, 91, 2.0), latest(11, 1, 5.0)]}
    )

    got = await bulk_client(bulk).fetch_latest([wanted])

    assert list(got) == [11]
    assert len(bulk.calls) == 2


async def test_the_newest_value_wins_when_a_sensor_appears_twice() -> None:
    wanted = openaq.Location.model_validate(location(1, [sensor_of(11, "pm25", 2)]))
    bulk = Bulk(
        latest_by_parameter={
            2: [
                latest(11, 1, 9.0, "2026-10-03T09:00:00Z"),
                latest(11, 1, 7.0, "2026-10-03T07:00:00Z"),
            ]
        }
    )

    got = await bulk_client(bulk).fetch_latest([wanted])

    assert got[11].value == 9.0


async def test_a_sensor_without_a_parameter_id_is_refused_when_its_country_is_listed() -> None:
    without_id = location(1, [sensor(11)])
    del without_id["sensors"][0]["parameter"]["id"]
    bulk = Bulk({94: [without_id]})

    with pytest.raises(PermanentUpstreamError) as caught:
        await bulk_client(bulk).fetch_country_locations(94)

    assert caught.value.code == "upstream_invalid_response"


async def test_a_malformed_value_of_an_unwanted_sensor_is_ignored() -> None:
    wanted = openaq.Location.model_validate(location(1, [sensor_of(11, "pm25", 2)]))
    bulk = Bulk(
        latest_by_parameter={
            2: [
                {"sensorsId": 900, "value": None, "datetime": "yesterday"},
                {"value": 1.0},
                latest(11, 1, 5.0),
            ]
        }
    )

    got = await bulk_client(bulk).fetch_latest([wanted])

    assert {k: v.value for k, v in got.items()} == {11: 5.0}


async def test_a_malformed_value_of_a_wanted_sensor_is_an_invalid_response() -> None:
    wanted = openaq.Location.model_validate(location(1, [sensor_of(11, "pm25", 2)]))
    bulk = Bulk(latest_by_parameter={2: [{"sensorsId": 11, "value": "12.4", "datetime": None}]})

    with pytest.raises(PermanentUpstreamError) as caught:
        await bulk_client(bulk).fetch_latest([wanted])

    assert caught.value.code == "upstream_invalid_response"


async def test_a_station_is_built_from_its_sensors_latest_values() -> None:
    loc = openaq.Location.model_validate(
        location(1, [sensor_of(11, "pm25", 2), sensor_of(12, "no2", 7), sensor_of(13, "o3", 9)])
    )
    got = await bulk_client(
        Bulk(
            latest_by_parameter={
                2: [latest(11, 1, 12.4)],
                7: [latest(12, 1, -999.0)],
            }
        )
    ).fetch_latest([loc])

    station = OpenAQClient.station_of(loc, got)

    # No value for o3, and -999 is the missing-value marker, not a reading.
    assert set(station.readings) == {"pm25"}
    assert station.readings["pm25"].value == 12.4
    assert station.readings["pm25"].unit == "µg/m³"
    assert station.location_id == 1


class FakeTime:
    """A clock that moves only when the client sleeps or an answer 'takes' time."""

    def __init__(self) -> None:
        self.now = 100.0
        self.sleeps: list[float] = []

    def clock(self) -> float:
        return self.now

    async def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.now += seconds


def paced_client(fake: FakeTime, answer_seconds: float) -> OpenAQClient:
    upstream = Upstream([location(1), location(2)])

    def answer(request: httpx.Request) -> httpx.Response:
        fake.now += answer_seconds
        return upstream(request)

    http = httpx.AsyncClient(transport=httpx.MockTransport(answer), base_url="https://x.test/v3")
    return OpenAQClient(
        http, max_stations=50, sleep=fake.sleep, clock=fake.clock, min_interval_seconds=1.2
    )


async def test_calls_are_spaced_by_when_they_start_not_by_when_they_end() -> None:
    fake = FakeTime()

    await paced_client(fake, answer_seconds=0.5).fetch_stations(BBOX)

    # Three calls: the first goes at once, and each later one waits only for what is left of 1.2
    # seconds after the previous call started (0.7), not a further 1.2 after it finished.
    assert [round(s, 2) for s in fake.sleeps] == [0.7, 0.7]


async def test_a_slow_answer_adds_no_pause_of_its_own() -> None:
    fake = FakeTime()

    await paced_client(fake, answer_seconds=5.0).fetch_stations(BBOX)

    assert fake.sleeps == []


async def test_a_transient_failure_is_retried_with_a_growing_wait_then_gives_up() -> None:
    fake = FakeTime()
    calls: list[int] = []

    def always_500(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        return httpx.Response(500)

    http = httpx.AsyncClient(
        transport=httpx.MockTransport(always_500), base_url="https://x.test/v3"
    )
    client = OpenAQClient(
        http, max_stations=50, sleep=fake.sleep, retries=2, retry_wait_seconds=2.0
    )

    with pytest.raises(TransientUpstreamError):
        await client.fetch_country_locations(94)

    assert len(calls) == 3
    assert fake.sleeps == [2.0, 4.0]


async def test_a_rejected_key_is_not_retried() -> None:
    calls: list[int] = []

    def rejected(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        return httpx.Response(401)

    http = httpx.AsyncClient(transport=httpx.MockTransport(rejected), base_url="https://x.test/v3")
    client = OpenAQClient(http, max_stations=50, retries=3, retry_wait_seconds=0)

    with pytest.raises(PermanentUpstreamError):
        await client.fetch_country_locations(94)

    assert len(calls) == 1


async def test_a_rate_limit_answer_waits_as_long_as_the_server_says() -> None:
    fake = FakeTime()
    answers = [httpx.Response(429, headers={"x-ratelimit-reset": "7"}), None]

    def limited(request: httpx.Request) -> httpx.Response:
        answer = answers.pop(0)
        return answer or httpx.Response(200, json={"meta": {"found": 0}, "results": []})

    http = httpx.AsyncClient(transport=httpx.MockTransport(limited), base_url="https://x.test/v3")
    client = OpenAQClient(
        http, max_stations=50, sleep=fake.sleep, retries=1, retry_wait_seconds=2.0
    )

    assert await client.fetch_country_locations(94) == []
    assert fake.sleeps == [7.0]
