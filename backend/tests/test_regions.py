from collections.abc import Callable
from typing import Any
from uuid import UUID, uuid4

import psycopg
import pytest
from httpx import AsyncClient

from tests.conftest import TEST_URL, Tenant

BBOX = [4.85, 52.35, 4.95, 52.40]


def create_url(tenant: Tenant) -> str:
    return f"/api/v1/projects/{tenant.project_id}/regions"


async def create_region(
    client: AsyncClient, tenant: Tenant, name: str = "Amsterdam", bbox: list[float] | None = None
) -> dict[str, Any]:
    response = await client.post(
        create_url(tenant), json={"name": name, "bbox": bbox or BBOX}, headers=tenant.headers
    )
    assert response.status_code == 201, response.text
    region: dict[str, Any] = response.json()["region"]
    return region


async def test_create_region_returns_201_with_the_contract_shape(
    client: AsyncClient, make_tenant: Callable[[], Tenant]
) -> None:
    tenant = make_tenant()

    response = await client.post(
        create_url(tenant), json={"name": "Amsterdam", "bbox": BBOX}, headers=tenant.headers
    )

    assert response.status_code == 201
    region = response.json()["region"]
    assert set(region) == {"id", "project_id", "name", "bbox", "created_at"}
    UUID(region["id"])
    assert region["project_id"] == str(tenant.project_id)
    assert region["name"] == "Amsterdam"
    assert region["bbox"] == BBOX
    assert region["created_at"].endswith("Z") or region["created_at"].endswith("+00:00")


@pytest.mark.parametrize(
    "bbox",
    [
        pytest.param([4.95, 52.35, 4.85, 52.40], id="inverted-longitude"),
        pytest.param([4.85, 52.40, 4.95, 52.35], id="inverted-latitude"),
        pytest.param([4.85, 52.35, 4.85, 52.40], id="zero-width"),
        pytest.param([4.85, 52.35, 4.95, 52.35], id="zero-height"),
        pytest.param([-181, 52.0, -180, 52.1], id="longitude-below-range"),
        pytest.param([180, 52.0, 181, 52.1], id="longitude-above-range"),
        pytest.param([4.0, -91, 4.1, -90], id="latitude-below-range"),
        pytest.param([4.0, 90, 4.1, 91], id="latitude-above-range"),
        pytest.param([4.0, 52.0, 6.5, 52.5], id="wider-than-2-degrees"),
        pytest.param([4.0, 50.0, 4.5, 52.5], id="taller-than-2-degrees"),
        pytest.param([179.5, 52.0, -179.5, 52.5], id="crosses-antimeridian"),
        pytest.param([4.85, 52.35, 4.95], id="three-values"),
        pytest.param([4.85, 52.35, 4.95, 52.40, 1.0], id="five-values"),
        pytest.param(["a", "b", "c", "d"], id="not-numbers"),
        pytest.param(["4.85", "52.35", "4.95", "52.40"], id="numeric-strings"),
        pytest.param([True, 52.35, 4.95, 52.40], id="boolean"),
        pytest.param("4.85,52.35,4.95,52.40", id="not-a-list"),
    ],
)
async def test_invalid_bbox_is_a_validation_error_and_stores_nothing(
    client: AsyncClient, make_tenant: Callable[[], Tenant], bbox: Any
) -> None:
    tenant = make_tenant()

    response = await client.post(
        create_url(tenant), json={"name": "Bad", "bbox": bbox}, headers=tenant.headers
    )

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "validation_failed"
    listing = await client.get(create_url(tenant), headers=tenant.headers)
    assert listing.json()["regions"] == []


@pytest.mark.parametrize(
    "body",
    [{"bbox": BBOX}, {"name": "", "bbox": BBOX}, {"name": "   ", "bbox": BBOX}, {"name": "x"}],
)
async def test_missing_or_empty_fields_are_validation_errors(
    client: AsyncClient, make_tenant: Callable[[], Tenant], body: dict[str, Any]
) -> None:
    tenant = make_tenant()

    response = await client.post(create_url(tenant), json=body, headers=tenant.headers)

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "validation_failed"


async def test_region_in_another_organisations_project_is_not_found_and_not_created(
    client: AsyncClient, make_tenant: Callable[[], Tenant]
) -> None:
    owner, intruder = make_tenant(), make_tenant()

    response = await client.post(
        create_url(owner), json={"name": "Nope", "bbox": BBOX}, headers=intruder.headers
    )

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"
    owner_list = await client.get(create_url(owner), headers=owner.headers)
    assert owner_list.json()["regions"] == []


@pytest.mark.parametrize("project_id", [str(uuid4()), "not-a-uuid"])
async def test_unknown_project_is_not_found(client: AsyncClient, project_id: str) -> None:
    response = await client.post(
        f"/api/v1/projects/{project_id}/regions", json={"name": "x", "bbox": BBOX}
    )

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"


async def test_creating_a_region_writes_an_audit_event(
    client: AsyncClient, make_tenant: Callable[[], Tenant]
) -> None:
    tenant = make_tenant()

    region = await create_region(client, tenant)

    with psycopg.connect(TEST_URL) as conn:
        rows = conn.execute(
            "SELECT action, entity_type, entity_id, organisation_id, actor_id "
            "FROM audit_events WHERE entity_id = %s",
            (UUID(region["id"]),),
        ).fetchall()
    assert len(rows) == 1
    action, entity_type, entity_id, organisation_id, actor_id = rows[0]
    assert (action, entity_type) == ("region.created", "region")
    assert entity_id == UUID(region["id"])
    assert organisation_id == tenant.organisation_id
    assert actor_id == UUID("00000000-0000-4000-8000-0000000000a1")


async def test_get_region_returns_what_was_created(
    client: AsyncClient, make_tenant: Callable[[], Tenant]
) -> None:
    tenant = make_tenant()
    created = await create_region(client, tenant)

    response = await client.get(f"/api/v1/regions/{created['id']}", headers=tenant.headers)

    assert response.status_code == 200
    assert response.json() == {"region": created}


async def test_get_region_from_another_organisation_is_not_found(
    client: AsyncClient, make_tenant: Callable[[], Tenant]
) -> None:
    owner, intruder = make_tenant(), make_tenant()
    created = await create_region(client, owner)

    response = await client.get(f"/api/v1/regions/{created['id']}", headers=intruder.headers)

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"


@pytest.mark.parametrize("region_id", [str(uuid4()), "not-a-uuid"])
async def test_get_unknown_region_is_not_found(client: AsyncClient, region_id: str) -> None:
    response = await client.get(f"/api/v1/regions/{region_id}")

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"


async def test_list_regions_is_newest_first_and_paginates_with_an_opaque_cursor(
    client: AsyncClient, make_tenant: Callable[[], Tenant]
) -> None:
    tenant = make_tenant()
    created = [await create_region(client, tenant, name=f"r{i}") for i in range(5)]
    newest_first = [r["id"] for r in reversed(created)]

    seen: list[str] = []
    cursor: str | None = None
    pages = 0
    while True:
        params: dict[str, str | int] = {"limit": 2}
        if cursor:
            params["cursor"] = cursor
        response = await client.get(create_url(tenant), params=params, headers=tenant.headers)
        assert response.status_code == 200
        body = response.json()
        seen += [r["id"] for r in body["regions"]]
        pages += 1
        cursor = body["next_cursor"]
        if cursor is None:
            break

    assert seen == newest_first
    assert pages == 3


async def test_list_regions_last_page_has_null_cursor(
    client: AsyncClient, make_tenant: Callable[[], Tenant]
) -> None:
    tenant = make_tenant()
    await create_region(client, tenant)

    response = await client.get(create_url(tenant), headers=tenant.headers)

    assert response.status_code == 200
    assert response.json()["next_cursor"] is None
    assert len(response.json()["regions"]) == 1


async def test_list_regions_only_returns_the_projects_own_regions(
    client: AsyncClient, make_tenant: Callable[[], Tenant]
) -> None:
    a, b = make_tenant(), make_tenant()
    await create_region(client, a, name="mine")
    await create_region(client, b, name="theirs")

    response = await client.get(create_url(a), headers=a.headers)

    assert [r["name"] for r in response.json()["regions"]] == ["mine"]


async def test_list_regions_of_another_organisations_project_is_not_found(
    client: AsyncClient, make_tenant: Callable[[], Tenant]
) -> None:
    owner, intruder = make_tenant(), make_tenant()
    await create_region(client, owner)

    response = await client.get(create_url(owner), headers=intruder.headers)

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"


@pytest.mark.parametrize("params", [{"limit": 0}, {"limit": 101}, {"cursor": "garbage"}])
async def test_list_regions_rejects_bad_pagination_params(
    client: AsyncClient, make_tenant: Callable[[], Tenant], params: dict[str, Any]
) -> None:
    tenant = make_tenant()

    response = await client.get(create_url(tenant), params=params, headers=tenant.headers)

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "validation_failed"


async def test_pagination_has_no_gaps_or_repeats_when_created_at_ties(
    client: AsyncClient, make_tenant: Callable[[], Tenant]
) -> None:
    tenant = make_tenant()
    ids = [uuid4() for _ in range(5)]
    with psycopg.connect(TEST_URL, autocommit=True) as conn:
        for region_id in ids:
            conn.execute(
                "INSERT INTO regions (id, project_id, organisation_id, name, geom, created_at) "
                "VALUES (%s, %s, %s, 'tie', ST_MakeEnvelope(4.85, 52.35, 4.95, 52.40, 4326), "
                "'2026-01-01T00:00:00Z')",
                (region_id, tenant.project_id, tenant.organisation_id),
            )

    seen: list[str] = []
    cursor: str | None = None
    while True:
        params: dict[str, str | int] = {"limit": 2}
        if cursor:
            params["cursor"] = cursor
        body = (await client.get(create_url(tenant), params=params, headers=tenant.headers)).json()
        seen += [r["id"] for r in body["regions"]]
        cursor = body["next_cursor"]
        if cursor is None:
            break

    assert seen == [str(i) for i in sorted(ids, reverse=True)]


async def test_database_refuses_a_region_whose_organisation_differs_from_its_project(
    make_tenant: Callable[[], Tenant],
) -> None:
    owner, other = make_tenant(), make_tenant()

    with (
        psycopg.connect(TEST_URL, autocommit=True) as conn,
        pytest.raises(psycopg.errors.ForeignKeyViolation),
    ):
        conn.execute(
            "INSERT INTO regions (id, project_id, organisation_id, name, geom) "
            "VALUES (%s, %s, %s, 'mismatch', ST_MakeEnvelope(4.85, 52.35, 4.95, 52.40, 4326))",
            (uuid4(), owner.project_id, other.organisation_id),
        )


async def test_id_pasted_with_quotes_is_not_found_with_a_helpful_message(
    client: AsyncClient, make_tenant: Callable[[], Tenant]
) -> None:
    tenant = make_tenant()
    created = await create_region(client, tenant)

    response = await client.get(f'/api/v1/regions/"{created["id"]}"', headers=tenant.headers)

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"
    assert "no quotes" in response.json()["error"]["message"]
