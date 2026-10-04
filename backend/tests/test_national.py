"""The national layers (ADR 0018, 0019): the refresh that builds one per country and the
endpoints that serve them."""

import asyncio
from collections.abc import Callable, Iterator
from typing import Any
from uuid import uuid4

import httpx
import psycopg
import pytest
from httpx import AsyncClient
from pydantic import SecretStr

from airlayer import luchtmeetnet, national, openaq, repositories
from airlayer.config import get_settings
from airlayer.countries import find_country, load_countries
from airlayer.db import get_sessionmaker
from airlayer.identity import RequestContext
from tests.conftest import TEST_URL, Tenant
from tests.test_identity_and_projects import production_settings  # noqa: F401
from tests.test_openaq_client import Bulk, latest, location, sensor_of
from tests.test_sync_luchtmeetnet import answers_by_station, fake_luchtmeetnet

NETHERLANDS_ID, TURKEY_ID = 94, 66


@pytest.fixture(autouse=True)
def clean_national_tables() -> Iterator[None]:
    """The national layers are global, so tests must not see each other's refreshes."""

    def clear() -> None:
        with psycopg.connect(TEST_URL, autocommit=True) as conn:
            conn.execute("DELETE FROM station_readings WHERE national_refresh_id IS NOT NULL")
            conn.execute("DELETE FROM national_refreshes")

    clear()
    yield
    clear()


@pytest.fixture(autouse=True)
def no_openaq_pause(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(get_settings(), "national_openaq_interval_seconds", 0.0)
    monkeypatch.setattr(get_settings(), "national_openaq_retry_wait_seconds", 0.0)


def openaq_world(*, turkey: bool = False, only_one_dutch_station: bool = False) -> Bulk:
    """What OpenAQ knows. Two Dutch stations (station 1 reports pm25 and no2, station 2 only pm25),
    and optionally one Turkish. Latest values are world-wide, as the real endpoint's are, so the
    Turkish sensor's value is in the answer whether or not Turkey is asked for."""
    dutch = [
        location(1, [sensor_of(11, "pm25", 2), sensor_of(12, "no2", 7)]),
        location(2, [sensor_of(20, "pm25", 2)]),
    ]
    locations = {NETHERLANDS_ID: dutch[:1] if only_one_dutch_station else dutch}
    if turkey:
        coordinates = {"latitude": 39.9, "longitude": 32.8}
        locations[TURKEY_ID] = [
            location(7, [sensor_of(70, "pm25", 2)], name="Ankara", coordinates=coordinates)
        ]
    return Bulk(
        locations,
        {
            2: [latest(11, 1, 12.4), latest(20, 2, 4.2), latest(70, 7, 8.0)],
            7: [latest(12, 1, 30.0)],
        },
    )


def refreshes(country: str = "NL") -> list[tuple[Any, ...]]:
    with psycopg.connect(TEST_URL) as conn:
        return conn.execute(
            "SELECT status, station_count, errors, warnings FROM national_refreshes "
            "WHERE country_code = %s ORDER BY created_at, id",
            (country,),
        ).fetchall()


def stored_names(country: str | None = None) -> list[str]:
    with psycopg.connect(TEST_URL) as conn:
        rows = conn.execute(
            "SELECT s.name FROM station_readings s JOIN national_refreshes r "
            "ON r.id = s.national_refresh_id WHERE %(c)s::text IS NULL OR r.country_code = %(c)s "
            "ORDER BY s.name",
            {"c": country},
        ).fetchall()
    return [r[0] for r in rows]


async def refresh_with(
    monkeypatch: pytest.MonkeyPatch,
    openaq: Callable[[httpx.Request], httpx.Response],
    lmn: Callable[[httpx.Request], httpx.Response] = answers_by_station,
) -> None:

    def factory(**_: Any) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            transport=httpx.MockTransport(openaq), base_url="https://openaq.test/v3"
        )

    monkeypatch.setattr(national, "make_http_client", factory)
    fake_luchtmeetnet(monkeypatch, lmn)
    await national.run_refresh()


def country_ids(upstream: Bulk) -> list[str]:
    return [
        c.url.params["countries_id"] for c in upstream.calls if c.url.path.endswith("/locations")
    ]


async def test_a_refresh_stores_the_merged_stations_of_both_sources(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    upstream = openaq_world()
    await refresh_with(monkeypatch, upstream)

    assert refreshes() == [("succeeded", 3, [], [])]
    assert stored_names("NL") == ["Elsewhere", "Station 1", "Station 2"]
    # The country, not a box: neighbours' stations inside a rectangle must stay out.
    assert not any("bbox" in c.url.params for c in upstream.calls)


async def test_every_country_gets_its_own_refresh_from_one_pass(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    upstream = openaq_world(turkey=True)
    await refresh_with(monkeypatch, upstream)

    assert sorted(country_ids(upstream), key=int) == sorted(
        (str(c.openaq_id) for c in load_countries()), key=int
    )
    assert refreshes("TR") == [("succeeded", 1, [], [])]
    assert refreshes("NL")[0][:2] == ("succeeded", 3)
    # Turkey has no second source, so it has nothing to warn about.
    assert stored_names("TR") == ["Ankara"]
    assert len(stored_names()) == 4


async def test_latest_values_are_pulled_per_parameter_not_per_station(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    upstream = openaq_world(turkey=True)
    await refresh_with(monkeypatch, upstream)

    paths = [c.url.path.removeprefix("/v3") for c in upstream.calls]
    assert [p for p in paths if "latest" in p] == ["/parameters/2/latest", "/parameters/7/latest"]


async def test_the_endpoint_serves_the_newest_succeeded_refresh(
    client: AsyncClient, make_tenant: Callable[[], Tenant], monkeypatch: pytest.MonkeyPatch
) -> None:
    tenant = make_tenant()
    await refresh_with(monkeypatch, openaq_world())

    response = await client.get("/api/v1/national-layer", headers=tenant.headers)

    assert response.status_code == 200
    body = response.json()
    layer = body["map_layer"]
    assert layer["region_id"] is None
    assert layer["country"] == "NL"
    assert layer["refreshed_at"] is not None
    assert layer["station_count"] == 3
    assert layer["bbox"] == find_country("NL").bbox  # type: ignore[union-attr]
    assert layer["property_keys"] == ["bcwb", "no2", "pm25"]
    assert len(body["stations"]["features"]) == 3


async def test_another_country_is_served_by_its_code_and_holds_only_its_stations(
    client: AsyncClient, make_tenant: Callable[[], Tenant], monkeypatch: pytest.MonkeyPatch
) -> None:
    tenant = make_tenant()
    await refresh_with(monkeypatch, openaq_world(turkey=True))

    # The code is case-insensitive.
    response = await client.get(
        "/api/v1/national-layer", params={"country": "tr"}, headers=tenant.headers
    )

    body = response.json()
    assert response.status_code == 200
    assert body["map_layer"]["country"] == "TR"
    assert body["map_layer"]["bbox"] == find_country("TR").bbox  # type: ignore[union-attr]
    assert [f["properties"]["name"] for f in body["stations"]["features"]] == ["Ankara"]
    assert body["stations"]["features"][0]["properties"]["sources"] == ["openaq"]


async def test_an_unknown_country_is_a_validation_error(
    client: AsyncClient, make_tenant: Callable[[], Tenant]
) -> None:
    headers = make_tenant().headers

    for code in ("XX", "RU", ""):
        response = await client.get(
            "/api/v1/national-layer", params={"country": code}, headers=headers
        )
        assert response.status_code == 400, code
        assert response.json()["error"]["code"] == "validation_failed"


async def test_there_is_no_layer_before_a_refresh_has_succeeded(
    client: AsyncClient, make_tenant: Callable[[], Tenant]
) -> None:
    response = await client.get("/api/v1/national-layer", headers=make_tenant().headers)

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"


async def test_a_country_without_a_refresh_has_no_layer_while_another_has(
    client: AsyncClient, make_tenant: Callable[[], Tenant], monkeypatch: pytest.MonkeyPatch
) -> None:
    headers = make_tenant().headers
    await refresh_with(monkeypatch, openaq_world())
    with psycopg.connect(TEST_URL, autocommit=True) as conn:
        conn.execute("DELETE FROM national_refreshes WHERE country_code = 'TR'")

    nl = await client.get("/api/v1/national-layer", headers=headers)
    tr = await client.get("/api/v1/national-layer", params={"country": "TR"}, headers=headers)

    assert (nl.status_code, tr.status_code) == (200, 404)


async def test_the_countries_endpoint_lists_every_country_by_name(
    client: AsyncClient, make_tenant: Callable[[], Tenant], monkeypatch: pytest.MonkeyPatch
) -> None:
    headers = make_tenant().headers

    before = (await client.get("/api/v1/countries", headers=headers)).json()["countries"]
    await refresh_with(monkeypatch, openaq_world(turkey=True))
    after = {
        c["code"]: c
        for c in (await client.get("/api/v1/countries", headers=headers)).json()["countries"]
    }

    names = [c["name"] for c in before]
    assert names == sorted(names)
    assert len(before) == len(load_countries())
    assert {"NL", "TR", "FR", "DE"} <= {c["code"] for c in before}
    assert "RU" not in {c["code"] for c in before}
    assert all(c["refreshed_at"] is None and c["station_count"] is None for c in before)
    assert after["NL"]["station_count"] == 3
    assert after["TR"]["station_count"] == 1
    assert after["TR"]["refreshed_at"] is not None
    assert after["TR"]["bbox"] == find_country("TR").bbox  # type: ignore[union-attr]


@pytest.mark.usefixtures("production_settings")
async def test_the_countries_endpoint_needs_an_identity(client: AsyncClient) -> None:
    response = await client.get("/api/v1/countries")

    assert response.status_code == 401


async def test_the_filter_works_as_on_a_region_layer(
    client: AsyncClient, make_tenant: Callable[[], Tenant], monkeypatch: pytest.MonkeyPatch
) -> None:
    tenant = make_tenant()
    await refresh_with(monkeypatch, openaq_world())

    over = await client.get(
        "/api/v1/national-layer",
        params={"property": "no2", "value": "10", "comparator": ">"},
        headers=tenant.headers,
    )
    unknown = await client.get(
        "/api/v1/national-layer", params={"property": "xx", "value": "1"}, headers=tenant.headers
    )

    body = over.json()
    assert [f["properties"]["name"] for f in body["stations"]["features"]] == ["Station 1"]
    assert body["map_layer"]["station_count"] == 3
    assert unknown.status_code == 400


async def test_a_failed_refresh_leaves_the_previous_layer_in_place(
    client: AsyncClient, make_tenant: Callable[[], Tenant], monkeypatch: pytest.MonkeyPatch
) -> None:
    tenant = make_tenant()
    await refresh_with(monkeypatch, openaq_world())
    await refresh_with(monkeypatch, lambda request: httpx.Response(401))

    assert [r[0] for r in refreshes()] == ["succeeded", "failed"]
    assert refreshes()[1][2][0]["code"] == "upstream_unauthorized"
    response = await client.get("/api/v1/national-layer", headers=tenant.headers)
    assert response.status_code == 200
    assert response.json()["map_layer"]["station_count"] == 3
    # The failed refresh stored no readings of its own.
    assert len(stored_names("NL")) == 3


async def test_a_failure_of_the_shared_latest_values_fails_every_country(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    upstream = openaq_world(turkey=True)

    def latest_is_down(request: httpx.Request) -> httpx.Response:
        if "/parameters/" in request.url.path:
            return httpx.Response(503)
        return upstream(request)

    await refresh_with(monkeypatch, latest_is_down)

    assert refreshes("NL")[0][0] == "failed"
    assert refreshes("TR")[0][0] == "failed"
    assert refreshes("TR")[0][2][0]["code"] == "upstream_unavailable"
    assert stored_names() == []


async def test_one_failed_call_is_retried_instead_of_failing_every_country(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    upstream = openaq_world(turkey=True)
    failures = {"left": 2}

    def flaky(request: httpx.Request) -> httpx.Response:
        if "/parameters/2/" in request.url.path and failures["left"] > 0:
            failures["left"] -= 1
            return httpx.Response(500)
        return upstream(request)

    await refresh_with(monkeypatch, flaky)

    assert refreshes("NL")[0][:2] == ("succeeded", 3)
    assert refreshes("TR")[0][0] == "succeeded"
    assert failures["left"] == 0


async def test_a_newer_refresh_replaces_the_layer(
    client: AsyncClient, make_tenant: Callable[[], Tenant], monkeypatch: pytest.MonkeyPatch
) -> None:
    tenant = make_tenant()
    await refresh_with(monkeypatch, openaq_world())
    first = (await client.get("/api/v1/national-layer", headers=tenant.headers)).json()

    await refresh_with(
        monkeypatch, openaq_world(only_one_dutch_station=True), lambda request: httpx.Response(503)
    )
    second = (await client.get("/api/v1/national-layer", headers=tenant.headers)).json()

    assert second["map_layer"]["id"] != first["map_layer"]["id"]
    assert second["map_layer"]["station_count"] == 1


async def test_luchtmeetnet_failing_is_a_warning_not_a_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    await refresh_with(monkeypatch, openaq_world(turkey=True), lambda request: httpx.Response(503))

    [(status, count, errors, warnings)] = refreshes("NL")
    assert (status, count, errors) == ("succeeded", 2, [])
    assert [w["code"] for w in warnings] == ["luchtmeetnet_unavailable"]
    # The other countries never asked Luchtmeetnet, so it cannot be a problem for them.
    assert refreshes("TR") == [("succeeded", 1, [], [])]


async def test_a_country_over_the_cap_fails_alone(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(get_settings(), "max_stations_national", 1)
    await refresh_with(monkeypatch, openaq_world(turkey=True))

    [(status, _, errors, _)] = refreshes("NL")
    assert status == "failed"
    assert errors[0]["code"] == "too_many_stations"
    assert stored_names("NL") == []
    assert refreshes("TR") == [("succeeded", 1, [], [])]


async def test_the_cap_counts_the_merged_stations_of_the_netherlands(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Two OpenAQ stations fit under 2, but Luchtmeetnet's station elsewhere makes three.
    monkeypatch.setattr(get_settings(), "max_stations_national", 2)
    await refresh_with(monkeypatch, openaq_world())

    [(status, _, errors, _)] = refreshes("NL")
    assert (status, errors[0]["code"]) == ("failed", "too_many_stations")


async def test_a_country_is_not_refreshed_while_its_previous_refresh_is_running(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with psycopg.connect(TEST_URL, autocommit=True) as conn:
        conn.execute(
            "INSERT INTO national_refreshes (id, country_code, status) "
            "VALUES (%s, 'NL', 'processing')",
            (uuid4(),),
        )
    upstream = openaq_world(turkey=True)

    await refresh_with(monkeypatch, upstream)

    assert [r[0] for r in refreshes("NL")] == ["processing"]
    assert str(NETHERLANDS_ID) not in country_ids(upstream)
    assert refreshes("TR")[0][0] == "succeeded"


async def test_nothing_runs_when_every_country_is_already_being_refreshed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with psycopg.connect(TEST_URL, autocommit=True) as conn:
        for country in load_countries():
            conn.execute(
                "INSERT INTO national_refreshes (id, country_code, status) "
                "VALUES (%s, %s, 'processing')",
                (uuid4(), country.code),
            )
    upstream = openaq_world()

    await refresh_with(monkeypatch, upstream)

    assert upstream.calls == []


async def test_an_abandoned_refresh_is_failed_so_it_cannot_block_the_next(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with psycopg.connect(TEST_URL, autocommit=True) as conn:
        conn.execute(
            "INSERT INTO national_refreshes (id, country_code, status, created_at) "
            "VALUES (%s, 'NL', 'processing', now() - interval '3 hours')",
            (uuid4(),),
        )

    # A failing next run, so retention (which drops failures older than a success) stays out of it.
    await refresh_with(monkeypatch, lambda request: httpx.Response(401))

    codes = [(r[0], r[2][0]["code"]) for r in refreshes()]
    assert codes == [("failed", "timed_out"), ("failed", "upstream_unauthorized")]


async def test_a_missing_api_key_fails_without_calling_openaq(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(get_settings(), "openaq_api_key", SecretStr(""))
    upstream = openaq_world()
    await refresh_with(monkeypatch, upstream)

    assert refreshes()[0][0] == "failed"
    assert refreshes("TR")[0][0] == "failed"
    assert upstream.calls == []


async def test_only_the_newest_succeeded_refreshes_of_a_country_are_kept(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    for _ in range(5):
        await refresh_with(monkeypatch, openaq_world(turkey=True))

    assert [r[0] for r in refreshes("NL")] == ["succeeded"] * 3
    assert [r[0] for r in refreshes("TR")] == ["succeeded"] * 3
    # The deleted refreshes took their readings with them: 3 refreshes of 3 and of 1 stations.
    assert len(stored_names("NL")) == 9
    assert len(stored_names("TR")) == 3


async def test_a_recent_failure_survives_pruning_but_an_old_one_does_not(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    await refresh_with(monkeypatch, openaq_world())  # succeeded, will be pruned
    await refresh_with(monkeypatch, lambda request: httpx.Response(401))  # failed, then old
    for _ in range(3):
        await refresh_with(monkeypatch, openaq_world())
    await refresh_with(monkeypatch, lambda request: httpx.Response(401))  # failed, still newest
    await refresh_with(monkeypatch, openaq_world())

    # Kept: the three newest successes, and the failure that came after the oldest of them.
    assert [r[0] for r in refreshes()] == ["succeeded", "succeeded", "failed", "succeeded"]


async def test_pruning_never_deletes_the_only_layer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    await refresh_with(monkeypatch, openaq_world())

    assert [r[0] for r in refreshes()] == ["succeeded"]
    assert len(stored_names("NL")) == 3


async def test_one_countrys_bad_answer_fails_only_that_country(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    upstream = openaq_world(turkey=True)

    def turkey_is_broken(request: httpx.Request) -> httpx.Response:
        if request.url.params.get("countries_id") == str(TURKEY_ID):
            return httpx.Response(400)
        return upstream(request)

    await refresh_with(monkeypatch, turkey_is_broken)

    assert refreshes("TR")[0][0] == "failed"
    assert refreshes("TR")[0][2][0]["code"] == "upstream_invalid_response"
    assert refreshes("NL")[0][:2] == ("succeeded", 3)
    assert refreshes("FR")[0][0] == "succeeded"


async def test_a_value_of_someone_elses_sensor_cannot_fail_our_layers(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    upstream = openaq_world()
    # The world-wide page carries a sensor of no country we list, with a value of null.
    upstream.latest[2].append({"sensorsId": 999999, "value": None, "datetime": None})

    await refresh_with(monkeypatch, upstream)

    assert refreshes("NL")[0][:2] == ("succeeded", 3)


async def test_luchtmeetnet_crashing_is_a_warning_not_a_failure_of_every_country(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def crash(self: luchtmeetnet.LuchtmeetnetClient, stations: Any) -> Any:
        raise RuntimeError("a bug in the parser")

    monkeypatch.setattr(luchtmeetnet.LuchtmeetnetClient, "fetch_stations", crash)

    await refresh_with(monkeypatch, openaq_world(turkey=True))

    [(status, count, _, warnings)] = refreshes("NL")
    assert (status, count) == ("succeeded", 2)
    assert [w["code"] for w in warnings] == ["luchtmeetnet_unavailable"]
    assert refreshes("TR")[0][0] == "succeeded"


async def test_luchtmeetnet_runs_alongside_openaq_not_after_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    started = asyncio.Event()

    async def second_source(settings: Any) -> Any:
        started.set()
        return [], []

    real_fetch_latest = openaq.OpenAQClient.fetch_latest

    async def latest_waits_for_the_second_source(self: Any, locations: Any) -> Any:
        # Sequential code would never set the event before OpenAQ is done, and this would time out.
        await asyncio.wait_for(started.wait(), timeout=2)
        return await real_fetch_latest(self, locations)

    monkeypatch.setattr(openaq.OpenAQClient, "fetch_latest", latest_waits_for_the_second_source)
    upstream = openaq_world()
    monkeypatch.setattr(
        national,
        "make_http_client",
        lambda **_: httpx.AsyncClient(
            transport=httpx.MockTransport(upstream), base_url="https://openaq.test/v3"
        ),
    )
    monkeypatch.setattr(national, "_fetch_luchtmeetnet", second_source)

    await national.run_refresh()

    assert refreshes("NL")[0][:2] == ("succeeded", 2)


async def test_luchtmeetnet_is_stopped_when_openaq_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    running = asyncio.Event()
    stopped = asyncio.Event()

    async def slow_second_source(settings: Any) -> Any:
        running.set()
        try:
            await asyncio.sleep(30)
        except asyncio.CancelledError:
            stopped.set()
            raise
        return [], []

    async def rejected_after_the_second_source_started(self: Any, countries_id: int) -> Any:
        await asyncio.wait_for(running.wait(), timeout=2)
        raise openaq.PermanentUpstreamError("upstream_unauthorized", "rejected")

    monkeypatch.setattr(national, "_fetch_luchtmeetnet", slow_second_source)
    monkeypatch.setattr(
        openaq.OpenAQClient, "fetch_country_locations", rejected_after_the_second_source_started
    )

    await national.run_refresh()

    assert stopped.is_set()
    assert refreshes("NL")[0][0] == "failed"


async def test_a_pruning_failure_does_not_fail_a_refresh_that_stored_its_layer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def broken(country_code: str, kept: int) -> None:
        raise RuntimeError("lock timeout")

    monkeypatch.setattr(national, "_prune", broken)

    await refresh_with(monkeypatch, openaq_world(turkey=True))

    assert refreshes("NL")[0][:2] == ("succeeded", 3)
    assert refreshes("TR")[0][0] == "succeeded"


async def test_a_cancelled_run_fails_what_it_opened_instead_of_leaving_it_processing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def cancelled(*_: Any) -> Any:
        raise asyncio.CancelledError

    monkeypatch.setattr(national, "_fetch", cancelled)

    with pytest.raises(asyncio.CancelledError):
        await national.run_refresh()

    assert refreshes("NL")[0][0] == "failed"
    assert refreshes("TR")[0][0] == "failed"


def seed_succeeded(country: str, count: int) -> None:
    with psycopg.connect(TEST_URL, autocommit=True) as conn:
        for age in range(count):
            conn.execute(
                "INSERT INTO national_refreshes (id, country_code, status, finished_at, "
                "station_count) VALUES (%s, %s, 'succeeded', now() - make_interval(mins => %s), 0)",
                (uuid4(), country, age + 1),
            )


async def test_pruning_one_country_leaves_the_others_and_a_running_refresh_alone() -> None:
    seed_succeeded("NL", 5)
    seed_succeeded("TR", 5)
    with psycopg.connect(TEST_URL, autocommit=True) as conn:
        conn.execute(
            "INSERT INTO national_refreshes (id, country_code, status, created_at) "
            "VALUES (%s, 'NL', 'processing', now() - interval '1 hour')",
            (uuid4(),),
        )

    await national._prune("NL", 3)

    assert [r[0] for r in refreshes("NL")].count("succeeded") == 3
    assert [r[0] for r in refreshes("NL")].count("processing") == 1
    assert [r[0] for r in refreshes("TR")] == ["succeeded"] * 5


async def test_history_is_available_for_a_national_station(
    make_tenant: Callable[[], Tenant], monkeypatch: pytest.MonkeyPatch
) -> None:
    tenant = make_tenant()
    await refresh_with(monkeypatch, openaq_world())
    ctx = RequestContext(organisation_id=tenant.organisation_id, actor_id=uuid4())
    netherlands = find_country("NL")
    assert netherlands is not None

    async with get_sessionmaker()() as session:
        layer = await repositories.get_national_layer(session, netherlands, None)
        assert layer is not None
        by_name = {f.properties.name: f.id for f in layer.stations.features}
        station = await repositories.get_history_target(
            session, ctx, layer.map_layer.id, by_name["Station 1"]
        )
        only_lmn = await repositories.get_history_target(
            session, ctx, layer.map_layer.id, by_name["Elsewhere"]
        )
        unknown = await repositories.get_history_target(session, ctx, uuid4(), by_name["Station 1"])

    assert station is not None
    assert station.openaq_location_id == 1
    assert only_lmn is not None
    assert only_lmn.openaq_location_id is None
    assert unknown is None


def test_a_reading_must_belong_to_exactly_one_parent() -> None:
    with (
        psycopg.connect(TEST_URL, autocommit=True) as conn,
        pytest.raises(psycopg.errors.CheckViolation),
    ):
        conn.execute(
            "INSERT INTO station_readings (id, openaq_location_id, name, geom, readings) VALUES "
            "(%s, 1, 'x', ST_SetSRID(ST_MakePoint(4.9, 52.37), 4326), '{}'::jsonb)",
            (uuid4(),),
        )


def test_two_refreshes_of_one_country_cannot_run_at_once() -> None:
    with psycopg.connect(TEST_URL, autocommit=True) as conn:
        conn.execute(
            "INSERT INTO national_refreshes (id, country_code, status) "
            "VALUES (%s, 'NL', 'processing')",
            (uuid4(),),
        )
        conn.execute(
            "INSERT INTO national_refreshes (id, country_code, status) "
            "VALUES (%s, 'TR', 'processing')",
            (uuid4(),),
        )
        with pytest.raises(psycopg.errors.UniqueViolation):
            conn.execute(
                "INSERT INTO national_refreshes (id, country_code, status) "
                "VALUES (%s, 'NL', 'processing')",
                (uuid4(),),
            )
