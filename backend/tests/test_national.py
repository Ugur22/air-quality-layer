"""The national layer (ADR 0018): the refresh that builds it and the endpoint that serves it."""

from collections.abc import Callable, Iterator
from typing import Any
from uuid import uuid4

import httpx
import psycopg
import pytest
from httpx import AsyncClient

from airlayer import national, repositories
from airlayer.config import NATIONAL_BBOX, get_settings
from airlayer.db import get_sessionmaker
from airlayer.identity import RequestContext
from tests.conftest import TEST_URL, Tenant
from tests.test_openaq_client import Upstream, latest, location, sensor
from tests.test_sync_luchtmeetnet import answers_by_station, fake_luchtmeetnet
from tests.test_sync_task import two_stations


@pytest.fixture(autouse=True)
def clean_national_tables() -> Iterator[None]:
    """The national layer is global, so tests must not see each other's refreshes."""

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


def refreshes() -> list[tuple[Any, ...]]:
    with psycopg.connect(TEST_URL) as conn:
        return conn.execute(
            "SELECT status, station_count, errors, warnings FROM national_refreshes "
            "ORDER BY created_at"
        ).fetchall()


def stored_names() -> list[str]:
    with psycopg.connect(TEST_URL) as conn:
        rows = conn.execute(
            "SELECT name FROM station_readings WHERE national_refresh_id IS NOT NULL ORDER BY name"
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


async def test_a_refresh_stores_the_merged_stations_of_both_sources(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    upstream = two_stations()
    await refresh_with(monkeypatch, upstream)

    assert refreshes() == [("succeeded", 3, [], [])]
    assert stored_names() == ["Elsewhere", "Station 1", "Station 2"]
    locations_call = next(r for r in upstream.calls if r.url.path.endswith("/locations"))
    # The country, not a box: neighbours' stations inside a rectangle must stay out.
    assert locations_call.url.params["countries_id"] == "94"
    assert "bbox" not in locations_call.url.params


async def test_the_endpoint_serves_the_newest_succeeded_refresh(
    client: AsyncClient, make_tenant: Callable[[], Tenant], monkeypatch: pytest.MonkeyPatch
) -> None:
    tenant = make_tenant()
    await refresh_with(monkeypatch, two_stations())

    response = await client.get("/api/v1/national-layer", headers=tenant.headers)

    assert response.status_code == 200
    body = response.json()
    layer = body["map_layer"]
    assert layer["region_id"] is None
    assert layer["refreshed_at"] is not None
    assert layer["station_count"] == 3
    assert layer["bbox"] == NATIONAL_BBOX
    assert layer["property_keys"] == ["bcwb", "no2", "pm25"]
    assert len(body["stations"]["features"]) == 3


async def test_there_is_no_layer_before_a_refresh_has_succeeded(
    client: AsyncClient, make_tenant: Callable[[], Tenant]
) -> None:
    response = await client.get("/api/v1/national-layer", headers=make_tenant().headers)

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"


async def test_the_filter_works_as_on_a_region_layer(
    client: AsyncClient, make_tenant: Callable[[], Tenant], monkeypatch: pytest.MonkeyPatch
) -> None:
    tenant = make_tenant()
    await refresh_with(monkeypatch, two_stations())

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
    await refresh_with(monkeypatch, two_stations())
    await refresh_with(monkeypatch, lambda request: httpx.Response(401))

    assert [r[0] for r in refreshes()] == ["succeeded", "failed"]
    assert refreshes()[1][2][0]["code"] == "upstream_unauthorized"
    response = await client.get("/api/v1/national-layer", headers=tenant.headers)
    assert response.status_code == 200
    assert response.json()["map_layer"]["station_count"] == 3
    # The failed refresh stored no readings of its own.
    assert len(stored_names()) == 3


async def test_a_newer_refresh_replaces_the_layer(
    client: AsyncClient, make_tenant: Callable[[], Tenant], monkeypatch: pytest.MonkeyPatch
) -> None:
    tenant = make_tenant()
    await refresh_with(monkeypatch, two_stations())
    first = (await client.get("/api/v1/national-layer", headers=tenant.headers)).json()

    only_one = Upstream([location(1, [sensor(11, "pm25")])], {1: [latest(11, 1, 9.0)]})
    await refresh_with(monkeypatch, only_one, lambda request: httpx.Response(503))
    second = (await client.get("/api/v1/national-layer", headers=tenant.headers)).json()

    assert second["map_layer"]["id"] != first["map_layer"]["id"]
    assert second["map_layer"]["station_count"] == 1


async def test_luchtmeetnet_failing_is_a_warning_not_a_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    await refresh_with(monkeypatch, two_stations(), lambda request: httpx.Response(503))

    [(status, count, errors, warnings)] = refreshes()
    assert (status, count, errors) == ("succeeded", 2, [])
    assert [w["code"] for w in warnings] == ["luchtmeetnet_unavailable"]


async def test_more_stations_than_the_national_cap_fails_the_refresh(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(get_settings(), "max_stations_national", 1)
    await refresh_with(monkeypatch, two_stations())

    [(status, _, errors, _)] = refreshes()
    assert status == "failed"
    assert errors[0]["code"] == "too_many_stations"
    assert stored_names() == []


async def test_a_refresh_does_not_start_while_another_is_running(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with psycopg.connect(TEST_URL, autocommit=True) as conn:
        conn.execute(
            "INSERT INTO national_refreshes (id, status) VALUES (%s, 'processing')", (uuid4(),)
        )
    upstream = two_stations()

    await refresh_with(monkeypatch, upstream)

    assert [r[0] for r in refreshes()] == ["processing"]
    assert upstream.calls == []


async def test_an_abandoned_refresh_is_failed_so_it_cannot_block_the_next(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with psycopg.connect(TEST_URL, autocommit=True) as conn:
        conn.execute(
            "INSERT INTO national_refreshes (id, status, created_at) "
            "VALUES (%s, 'processing', now() - interval '3 hours')",
            (uuid4(),),
        )

    await refresh_with(monkeypatch, two_stations())

    statuses = [(r[0], r[2][0]["code"] if r[2] else None) for r in refreshes()]
    assert statuses == [("failed", "timed_out"), ("succeeded", None)]


async def test_a_missing_api_key_fails_without_calling_openaq(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from pydantic import SecretStr

    monkeypatch.setattr(get_settings(), "openaq_api_key", SecretStr(""))
    upstream = two_stations()
    await refresh_with(monkeypatch, upstream)

    assert refreshes()[0][0] == "failed"
    assert upstream.calls == []


async def test_history_is_available_for_a_national_station(
    make_tenant: Callable[[], Tenant], monkeypatch: pytest.MonkeyPatch
) -> None:
    tenant = make_tenant()
    await refresh_with(monkeypatch, two_stations())
    ctx = RequestContext(organisation_id=tenant.organisation_id, actor_id=uuid4())

    async with get_sessionmaker()() as session:
        layer = await repositories.get_national_layer(session, None)
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
