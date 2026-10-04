import asyncio
from collections.abc import Callable
from typing import Any
from uuid import UUID, uuid4

import httpx
import psycopg
import pytest
from httpx import AsyncClient

from airlayer import sync
from airlayer.config import Settings, get_settings
from airlayer.jobs import app as jobs_app
from airlayer.jobs import sync_region
from airlayer.main import app
from tests.conftest import TEST_URL, Tenant
from tests.test_regions import BBOX, create_region
from tests.test_sync_task import fake_openaq, two_stations

SYNC_KEYS = {
    "id",
    "region_id",
    "status",
    "created_at",
    "started_at",
    "finished_at",
    "station_count",
    "map_layer_id",
    "errors",
    "warnings",
}


async def start_sync(client: AsyncClient, tenant: Tenant, region_id: str) -> httpx.Response:
    return await client.post(f"/api/v1/regions/{region_id}/syncs", headers=tenant.headers)


def set_status(job_id: str, status: str) -> None:
    with psycopg.connect(TEST_URL, autocommit=True) as conn:
        conn.execute(
            "UPDATE sync_jobs SET status = %s, finished_at = now() WHERE id = %s",
            (status, UUID(job_id)),
        )


def queued_task_args(job_id: str) -> list[dict[str, Any]]:
    with psycopg.connect(TEST_URL) as conn:
        rows = conn.execute(
            "SELECT args FROM procrastinate_jobs WHERE task_name = 'sync_region' "
            "AND args->>'sync_job_id' = %s",
            (job_id,),
        ).fetchall()
    return [r[0] for r in rows]


async def test_starting_a_sync_returns_202_a_queued_job_and_enqueues_it(
    client: AsyncClient, make_tenant: Callable[[], Tenant], monkeypatch: pytest.MonkeyPatch
) -> None:
    tenant = make_tenant()
    region = await create_region(client, tenant)

    def must_not_be_called(**_: Any) -> httpx.AsyncClient:
        raise AssertionError("the request must return before OpenAQ is called")

    monkeypatch.setattr(sync, "make_http_client", must_not_be_called)

    response = await start_sync(client, tenant, region["id"])

    assert response.status_code == 202
    job = response.json()["sync_job"]
    assert set(job) == SYNC_KEYS
    assert job["region_id"] == region["id"]
    assert job["status"] == "queued"
    assert job["started_at"] is None
    assert job["finished_at"] is None
    assert job["station_count"] is None
    assert job["map_layer_id"] is None
    assert job["errors"] == []
    assert job["warnings"] == []
    assert queued_task_args(job["id"]) == [{"sync_job_id": job["id"]}]


async def test_a_second_sync_while_one_is_in_flight_is_a_conflict(
    client: AsyncClient, make_tenant: Callable[[], Tenant]
) -> None:
    tenant = make_tenant()
    region = await create_region(client, tenant)
    first = (await start_sync(client, tenant, region["id"])).json()["sync_job"]

    second = await start_sync(client, tenant, region["id"])

    assert second.status_code == 409
    assert second.json()["error"]["code"] == "conflict"
    assert queued_task_args(first["id"]) != []


async def test_a_new_sync_is_allowed_once_the_previous_one_has_finished(
    client: AsyncClient, make_tenant: Callable[[], Tenant]
) -> None:
    tenant = make_tenant()
    region = await create_region(client, tenant)
    first = (await start_sync(client, tenant, region["id"])).json()["sync_job"]
    set_status(first["id"], "failed")

    second = await start_sync(client, tenant, region["id"])

    assert second.status_code == 202
    assert second.json()["sync_job"]["id"] != first["id"]


async def test_two_regions_can_sync_at_the_same_time(
    client: AsyncClient, make_tenant: Callable[[], Tenant]
) -> None:
    tenant = make_tenant()
    a = await create_region(client, tenant, name="a")
    b = await create_region(client, tenant, name="b")

    assert (await start_sync(client, tenant, a["id"])).status_code == 202
    assert (await start_sync(client, tenant, b["id"])).status_code == 202


async def test_starting_a_sync_for_another_organisations_region_is_not_found(
    client: AsyncClient, make_tenant: Callable[[], Tenant]
) -> None:
    owner, intruder = make_tenant(), make_tenant()
    region = await create_region(client, owner)

    response = await start_sync(client, intruder, region["id"])

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"
    with psycopg.connect(TEST_URL) as conn:
        row = conn.execute(
            "SELECT count(*) FROM sync_jobs WHERE region_id = %s", (UUID(region["id"]),)
        ).fetchone()
    assert row is not None
    assert row[0] == 0


@pytest.mark.parametrize("region_id", [str(uuid4()), "not-a-uuid"])
async def test_starting_a_sync_for_an_unknown_region_is_not_found(
    client: AsyncClient, region_id: str
) -> None:
    response = await client.post(f"/api/v1/regions/{region_id}/syncs")

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"


async def test_a_failed_enqueue_fails_the_job_instead_of_leaving_it_queued(
    client: AsyncClient, make_tenant: Callable[[], Tenant], monkeypatch: pytest.MonkeyPatch
) -> None:
    tenant = make_tenant()
    region = await create_region(client, tenant)

    async def broken(**_: Any) -> None:
        raise RuntimeError("queue down")

    monkeypatch.setattr(sync_region, "defer_async", broken)

    response = await start_sync(client, tenant, region["id"])

    assert response.status_code == 503
    assert response.json()["error"]["code"] == "service_unavailable"

    with psycopg.connect(TEST_URL) as conn:
        row = conn.execute(
            "SELECT status, errors->0->>'code' FROM sync_jobs WHERE region_id = %s",
            (UUID(region["id"]),),
        ).fetchone()
    assert row == ("failed", "processing_error")
    # and the region is not blocked from syncing again
    monkeypatch.undo()
    assert (await start_sync(client, tenant, region["id"])).status_code == 202


async def test_get_sync_returns_the_job(
    client: AsyncClient, make_tenant: Callable[[], Tenant]
) -> None:
    tenant = make_tenant()
    region = await create_region(client, tenant)
    started = (await start_sync(client, tenant, region["id"])).json()["sync_job"]

    response = await client.get(f"/api/v1/syncs/{started['id']}", headers=tenant.headers)

    assert response.status_code == 200
    assert response.json() == {"sync_job": started}


async def test_get_sync_from_another_organisation_is_not_found(
    client: AsyncClient, make_tenant: Callable[[], Tenant]
) -> None:
    owner, intruder = make_tenant(), make_tenant()
    region = await create_region(client, owner)
    job = (await start_sync(client, owner, region["id"])).json()["sync_job"]

    response = await client.get(f"/api/v1/syncs/{job['id']}", headers=intruder.headers)

    assert response.status_code == 404


@pytest.mark.parametrize("job_id", [str(uuid4()), "not-a-uuid"])
async def test_get_unknown_sync_is_not_found(client: AsyncClient, job_id: str) -> None:
    response = await client.get(f"/api/v1/syncs/{job_id}")

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"


async def test_sync_endpoints_reject_the_placeholder_identity_outside_development(
    client: AsyncClient,
) -> None:
    prod: Settings = get_settings().model_copy(update={"environment": "production"})
    app.dependency_overrides[get_settings] = lambda: prod
    try:
        started = await client.post(f"/api/v1/regions/{uuid4()}/syncs")
        read = await client.get(f"/api/v1/syncs/{uuid4()}")
    finally:
        app.dependency_overrides.pop(get_settings, None)

    assert started.status_code == 401
    assert read.status_code == 401


async def test_whole_flow_through_the_api_and_the_real_worker(
    client: AsyncClient, make_tenant: Callable[[], Tenant], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Region -> start sync -> worker pulls (mocked) OpenAQ -> poll shows succeeded."""
    with psycopg.connect(TEST_URL, autocommit=True) as conn:
        conn.execute("DELETE FROM procrastinate_jobs")
    fake_openaq(monkeypatch, two_stations())
    tenant = make_tenant()
    region = await create_region(client, tenant, bbox=BBOX)
    job = (await start_sync(client, tenant, region["id"])).json()["sync_job"]
    assert job["status"] == "queued"

    await jobs_app.run_worker_async(wait=False)

    done = (await client.get(f"/api/v1/syncs/{job['id']}", headers=tenant.headers)).json()[
        "sync_job"
    ]
    assert done["status"] == "succeeded"
    assert done["station_count"] == 2
    assert done["map_layer_id"] == job["id"]
    assert done["errors"] == []
    assert done["warnings"] == []
    assert done["started_at"] is not None
    assert done["finished_at"] is not None


async def test_a_failed_sync_is_reported_with_its_error_code(
    client: AsyncClient, make_tenant: Callable[[], Tenant], monkeypatch: pytest.MonkeyPatch
) -> None:
    with psycopg.connect(TEST_URL, autocommit=True) as conn:
        conn.execute("DELETE FROM procrastinate_jobs")
    fake_openaq(monkeypatch, lambda request: httpx.Response(401, json={}))
    tenant = make_tenant()
    region = await create_region(client, tenant)
    job = (await start_sync(client, tenant, region["id"])).json()["sync_job"]

    await jobs_app.run_worker_async(wait=False)

    done = (await client.get(f"/api/v1/syncs/{job['id']}", headers=tenant.headers)).json()[
        "sync_job"
    ]
    assert done["status"] == "failed"
    assert done["station_count"] is None
    assert done["map_layer_id"] is None
    assert [e["code"] for e in done["errors"]] == ["upstream_unauthorized"]
    # the region can be synced again after a failure
    assert (await start_sync(client, tenant, region["id"])).status_code == 202


async def test_two_simultaneous_starts_give_exactly_one_job_and_one_conflict(
    client: AsyncClient, make_tenant: Callable[[], Tenant]
) -> None:
    tenant = make_tenant()
    region = await create_region(client, tenant)

    responses = await asyncio.gather(
        start_sync(client, tenant, region["id"]), start_sync(client, tenant, region["id"])
    )

    assert sorted(r.status_code for r in responses) == [202, 409]
