import base64
from collections.abc import Callable
from typing import Any
from uuid import UUID, uuid4

import psycopg
import pytest
from httpx import AsyncClient

from tests.conftest import TEST_URL, Tenant
from tests.test_regions import create_region
from tests.test_syncs_api import SYNC_KEYS


def add_job(tenant: Tenant, region_id: str, status: str, minutes_ago: int) -> UUID:
    job_id = uuid4()
    with psycopg.connect(TEST_URL, autocommit=True) as conn:
        conn.execute(
            "INSERT INTO sync_jobs (id, organisation_id, region_id, status, station_count, "
            "created_at) VALUES (%s, %s, %s, %s, %s, now() - make_interval(mins => %s))",
            (
                job_id,
                tenant.organisation_id,
                UUID(region_id),
                status,
                3 if status == "succeeded" else None,
                minutes_ago,
            ),
        )
    return job_id


def list_url(region_id: str) -> str:
    return f"/api/v1/regions/{region_id}/syncs"


async def test_a_region_with_no_syncs_has_an_empty_list(
    client: AsyncClient, make_tenant: Callable[[], Tenant]
) -> None:
    tenant = make_tenant()
    region = await create_region(client, tenant)

    response = await client.get(list_url(region["id"]), headers=tenant.headers)

    assert response.status_code == 200
    assert response.json() == {"sync_jobs": [], "next_cursor": None}


async def test_syncs_are_listed_newest_first_in_the_sync_job_shape(
    client: AsyncClient, make_tenant: Callable[[], Tenant]
) -> None:
    tenant = make_tenant()
    region = await create_region(client, tenant)
    oldest = add_job(tenant, region["id"], "failed", minutes_ago=30)
    middle = add_job(tenant, region["id"], "succeeded", minutes_ago=20)
    newest = add_job(tenant, region["id"], "succeeded", minutes_ago=10)

    response = await client.get(list_url(region["id"]), headers=tenant.headers)

    assert response.status_code == 200
    jobs = response.json()["sync_jobs"]
    assert [j["id"] for j in jobs] == [str(newest), str(middle), str(oldest)]
    assert all(set(j) == SYNC_KEYS for j in jobs)
    # a succeeded job's layer id is its own id; a failed one has none
    assert jobs[0]["map_layer_id"] == str(newest)
    assert jobs[2]["map_layer_id"] is None


async def test_the_list_paginates_without_gaps_or_repeats(
    client: AsyncClient, make_tenant: Callable[[], Tenant]
) -> None:
    tenant = make_tenant()
    region = await create_region(client, tenant)
    created = [add_job(tenant, region["id"], "succeeded", minutes_ago=m) for m in range(10, 60, 10)]
    newest_first = [str(j) for j in created]  # smallest minutes_ago is newest

    seen: list[str] = []
    cursor: str | None = None
    while True:
        params: dict[str, Any] = {"limit": 2}
        if cursor:
            params["cursor"] = cursor
        body = (
            await client.get(list_url(region["id"]), params=params, headers=tenant.headers)
        ).json()
        seen += [j["id"] for j in body["sync_jobs"]]
        cursor = body["next_cursor"]
        if cursor is None:
            break

    assert seen == newest_first


async def test_only_the_regions_own_syncs_are_listed(
    client: AsyncClient, make_tenant: Callable[[], Tenant]
) -> None:
    tenant = make_tenant()
    a = await create_region(client, tenant, name="a")
    b = await create_region(client, tenant, name="b")
    mine = add_job(tenant, a["id"], "succeeded", 5)
    add_job(tenant, b["id"], "succeeded", 5)

    body = (await client.get(list_url(a["id"]), headers=tenant.headers)).json()

    assert [j["id"] for j in body["sync_jobs"]] == [str(mine)]


async def test_another_organisations_region_is_not_found(
    client: AsyncClient, make_tenant: Callable[[], Tenant]
) -> None:
    owner, intruder = make_tenant(), make_tenant()
    region = await create_region(client, owner)

    response = await client.get(list_url(region["id"]), headers=intruder.headers)

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"


@pytest.mark.parametrize("region_id", [str(uuid4()), "not-a-uuid"])
async def test_an_unknown_region_is_not_found(client: AsyncClient, region_id: str) -> None:
    assert (await client.get(list_url(region_id))).status_code == 404


@pytest.mark.parametrize("params", [{"limit": 0}, {"limit": 101}, {"cursor": "garbage"}])
async def test_bad_pagination_params_are_validation_errors(
    client: AsyncClient, make_tenant: Callable[[], Tenant], params: dict[str, Any]
) -> None:
    tenant = make_tenant()
    region = await create_region(client, tenant)

    response = await client.get(list_url(region["id"]), params=params, headers=tenant.headers)

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "validation_failed"


async def test_pagination_has_no_gaps_or_repeats_when_created_at_ties(
    client: AsyncClient, make_tenant: Callable[[], Tenant]
) -> None:
    tenant = make_tenant()
    region = await create_region(client, tenant)
    ids = [uuid4() for _ in range(5)]
    with psycopg.connect(TEST_URL, autocommit=True) as conn:
        for job_id in ids:
            conn.execute(
                "INSERT INTO sync_jobs (id, organisation_id, region_id, status, created_at) "
                "VALUES (%s, %s, %s, 'failed', '2026-01-01T00:00:00Z')",
                (job_id, tenant.organisation_id, UUID(region["id"])),
            )

    seen: list[str] = []
    cursor: str | None = None
    while True:
        params: dict[str, Any] = {"limit": 2}
        if cursor:
            params["cursor"] = cursor
        body = (
            await client.get(list_url(region["id"]), params=params, headers=tenant.headers)
        ).json()
        seen += [j["id"] for j in body["sync_jobs"]]
        cursor = body["next_cursor"]
        if cursor is None:
            break

    assert seen == [str(i) for i in sorted(ids, reverse=True)]


@pytest.mark.parametrize(
    "payload",
    [
        "2026-01-01T00:00:00|" + str(uuid4()),  # no timezone
        "not-a-date|" + str(uuid4()),
        "2026-01-01T00:00:00+00:00|not-a-uuid",
        "2026-01-01T00:00:00+00:00",  # missing id
        "a|b|c",
    ],
)
async def test_a_forged_cursor_is_a_validation_error_never_a_server_error(
    client: AsyncClient, make_tenant: Callable[[], Tenant], payload: str
) -> None:
    tenant = make_tenant()
    region = await create_region(client, tenant)
    cursor = base64.urlsafe_b64encode(payload.encode()).decode()

    response = await client.get(
        list_url(region["id"]), params={"cursor": cursor}, headers=tenant.headers
    )

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "validation_failed"
