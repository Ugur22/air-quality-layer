from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any

import httpx
import pytest

from airlayer.luchtmeetnet import (
    CALLS_PER_WINDOW,
    WINDOW_SECONDS,
    CallPacer,
    CatalogueStation,
    LuchtmeetnetClient,
    load_catalogue,
    make_http_client,
    stations_in,
)
from airlayer.openaq import PermanentUpstreamError, TransientUpstreamError

NOW = datetime(2026, 10, 4, 9, 0, tzinfo=UTC)
STATION = CatalogueStation("NL49014", "Amsterdam-Vondelpark", 4.866, 52.3597)
Handler = Callable[[httpx.Request], httpx.Response]


def measurement(formula: str, value: Any, at: str = "2026-10-04T08:00:00+00:00") -> dict[str, Any]:
    return {
        "value": value,
        "timestamp_measured": at,
        "formula": formula,
        "timestamp_measured_start": at,
        "timestamp_measured_end": at,
    }


def client_for(handler: Handler, **kwargs: Any) -> LuchtmeetnetClient:
    http = httpx.AsyncClient(
        transport=httpx.MockTransport(handler), base_url="https://luchtmeetnet.test/open_api"
    )
    return LuchtmeetnetClient(http, now=lambda: NOW, **kwargs)


def answering(data: list[dict[str, Any]]) -> Handler:
    return lambda _request: httpx.Response(200, json={"data": data})


async def test_the_newest_value_of_each_pollutant_becomes_the_stations_readings() -> None:
    data = [
        measurement("PM25", 4.3, "2026-10-04T08:00:00+00:00"),
        measurement("PM25", 3.5, "2026-10-04T07:00:00+00:00"),
        measurement("BCWB", 0.09),
        measurement("PS", 6200.0),
    ]

    [station] = await client_for(answering(data)).fetch_stations([STATION])

    assert station.luchtmeetnet_number == "NL49014"
    assert station.location_id is None
    assert station.sources == ("luchtmeetnet",)
    assert {k: (r.value, r.unit) for k, r in station.readings.items()} == {
        "pm25": (4.3, "µg/m³"),
        "bcwb": (0.09, "µg/m³"),
        "ps": (6200.0, "particles/cm³"),
    }
    assert station.readings["pm25"].source == "luchtmeetnet"
    assert station.readings["pm25"].observed_at == datetime(2026, 10, 4, 8, tzinfo=UTC)


async def test_a_pollutant_it_does_not_know_is_dropped_not_guessed() -> None:
    [station] = await client_for(
        answering([measurement("XYZ", 1.0), measurement("PM10", 9.0)])
    ).fetch_stations([STATION])

    assert set(station.readings) == {"pm10"}


async def test_missing_value_markers_are_dropped() -> None:
    [station] = await client_for(
        answering([measurement("NO2", -999.0), measurement("PM10", 9.0)])
    ).fetch_stations([STATION])

    assert set(station.readings) == {"pm10"}


async def test_asks_once_per_station_without_a_formula() -> None:
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(200, json={"data": []})

    other = CatalogueStation("NL10", "Other", 4.9, 52.4)
    await client_for(handler).fetch_stations([STATION, other])

    assert [c.url.path.split("/")[-2] for c in calls] == ["NL10", "NL49014"]
    assert all("formula" not in c.url.params for c in calls)


@pytest.mark.parametrize(
    "body",
    [
        {"data": [measurement("PM25", "4.3")]},
        {"data": [measurement("PM25", True)]},
        {"data": [measurement("PM25", 4.3, "2026-10-04T08:00:00")]},
        {"data": "nothing"},
        {"nodata": []},
    ],
)
async def test_a_response_of_the_wrong_shape_fails_the_fetch(body: dict[str, Any]) -> None:
    with pytest.raises(PermanentUpstreamError) as caught:
        await client_for(lambda _r: httpx.Response(200, json=body)).fetch_stations([STATION])

    assert caught.value.code == "upstream_invalid_response"


async def test_a_value_that_is_not_a_number_fails_the_fetch() -> None:
    # Python's JSON parser accepts NaN, which no real reading is.
    body = (
        b'{"data": [{"value": NaN, "formula": "PM25", '
        b'"timestamp_measured": "2026-10-04T08:00:00+00:00"}]}'
    )

    with pytest.raises(PermanentUpstreamError):
        await client_for(lambda _r: httpx.Response(200, content=body)).fetch_stations([STATION])


async def test_a_measurement_from_the_future_fails_the_fetch() -> None:
    with pytest.raises(PermanentUpstreamError):
        await client_for(
            answering([measurement("PM25", 4.3, "2026-10-04T10:00:00+00:00")])
        ).fetch_stations([STATION])


async def test_a_body_that_is_not_json_fails_the_fetch() -> None:
    with pytest.raises(PermanentUpstreamError):
        await client_for(lambda _r: httpx.Response(200, text="<html>")).fetch_stations([STATION])


@pytest.mark.parametrize("status", [429, 500, 503])
async def test_rate_limiting_and_server_errors_are_transient(status: int) -> None:
    with pytest.raises(TransientUpstreamError):
        await client_for(lambda _r: httpx.Response(status)).fetch_stations([STATION])


async def test_a_network_failure_is_transient() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectTimeout("slow")

    with pytest.raises(TransientUpstreamError):
        await client_for(handler).fetch_stations([STATION])


async def test_other_client_errors_are_permanent() -> None:
    with pytest.raises(PermanentUpstreamError):
        await client_for(lambda _r: httpx.Response(404)).fetch_stations([STATION])


def pacer_with_clock() -> tuple[CallPacer, list[float]]:
    slept: list[float] = []
    clock = {"now": 1000.0}

    async def sleep(seconds: float) -> None:
        slept.append(seconds)
        clock["now"] += seconds

    return CallPacer(sleep=sleep, clock=lambda: clock["now"]), slept


async def test_it_waits_instead_of_going_over_the_call_limit() -> None:
    pacer, slept = pacer_with_clock()
    client = client_for(answering([]), pacer=pacer)
    await client.fetch_stations([STATION] * CALLS_PER_WINDOW)
    assert slept == []

    await client.fetch_stations([STATION])

    assert slept == [pytest.approx(WINDOW_SECONDS)]


async def test_clients_sharing_a_pacer_share_the_limit() -> None:
    # Two syncs close together are two clients; together they still stay under the limit.
    pacer, slept = pacer_with_clock()
    await client_for(answering([]), pacer=pacer).fetch_stations([STATION] * CALLS_PER_WINDOW)

    await client_for(answering([]), pacer=pacer).fetch_stations([STATION])

    assert slept == [pytest.approx(WINDOW_SECONDS)]


def test_the_request_carries_no_api_key() -> None:
    # The OpenAQ key must never reach another service.
    http = make_http_client(base_url="https://x.test", timeout=5, user_agent="AirLayer test")

    assert "x-api-key" not in {k.lower() for k in http.headers}
    assert http.headers["user-agent"] == "AirLayer test"


def test_stations_inside_the_box_are_picked_from_the_catalogue() -> None:
    catalogue = (STATION, CatalogueStation("NL1", "Far", 6.5, 51.5))

    assert stations_in([4.85, 52.35, 4.95, 52.40], catalogue) == [STATION]
    assert stations_in([6.0, 51.0, 7.0, 52.0], catalogue)[0].number == "NL1"
    assert stations_in([0.0, 0.0, 1.0, 1.0], catalogue) == []


def test_a_catalogue_number_that_is_not_plain_is_refused() -> None:
    from pydantic import ValidationError

    from airlayer.luchtmeetnet import _Catalogue

    entry = {"number": "NL1/../x", "name": "Bad", "longitude": 4.9, "latitude": 52.3}

    with pytest.raises(ValidationError):
        _Catalogue.model_validate({"stations": [entry]})


def test_the_bundled_snapshot_is_valid_and_has_unique_numbers() -> None:
    load_catalogue.cache_clear()
    catalogue = load_catalogue()

    assert len(catalogue) > 50
    assert len({s.number for s in catalogue}) == len(catalogue)
    assert all(3 < s.longitude < 8 and 50 < s.latitude < 54 for s in catalogue)
