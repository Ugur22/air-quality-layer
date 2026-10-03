from collections.abc import Callable, Iterator

import pytest
from httpx import AsyncClient

from airlayer.config import Settings, get_settings
from airlayer.main import app
from tests.conftest import Tenant

DEV_ORG = "00000000-0000-4000-8000-000000000001"


@pytest.fixture
def production_settings() -> Iterator[None]:
    prod: Settings = get_settings().model_copy(update={"environment": "production"})
    app.dependency_overrides[get_settings] = lambda: prod
    yield
    app.dependency_overrides.pop(get_settings, None)


async def test_projects_lists_the_seeded_dev_project_for_the_default_organisation(
    client: AsyncClient,
) -> None:
    response = await client.get("/api/v1/projects")

    assert response.status_code == 200
    projects = response.json()["projects"]
    assert len(projects) == 1
    assert projects[0]["name"] == "Development project"
    assert set(projects[0]) == {"id", "name"}


async def test_projects_only_lists_the_callers_organisation(
    client: AsyncClient, make_tenant: Callable[[], Tenant]
) -> None:
    tenant = make_tenant()

    response = await client.get("/api/v1/projects", headers=tenant.headers)

    assert response.status_code == 200
    assert response.json() == {"projects": [{"id": str(tenant.project_id), "name": "Test project"}]}


async def test_unknown_organisation_sees_no_projects(client: AsyncClient) -> None:
    response = await client.get(
        "/api/v1/projects",
        headers={"X-Dev-Organisation-Id": "11111111-1111-4111-8111-111111111111"},
    )

    assert response.status_code == 200
    assert response.json() == {"projects": []}


async def test_malformed_organisation_header_is_a_validation_error(client: AsyncClient) -> None:
    response = await client.get("/api/v1/projects", headers={"X-Dev-Organisation-Id": "nope"})

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "validation_failed"


@pytest.mark.usefixtures("production_settings")
async def test_placeholder_identity_is_rejected_outside_development(client: AsyncClient) -> None:
    for path in ("/api/v1/projects", f"/api/v1/regions/{DEV_ORG}"):
        response = await client.get(path)

        assert response.status_code == 401
        assert response.json()["error"]["code"] == "unauthorized"


@pytest.mark.usefixtures("production_settings")
async def test_dev_header_does_not_bypass_the_environment_check(client: AsyncClient) -> None:
    response = await client.get("/api/v1/projects", headers={"X-Dev-Organisation-Id": DEV_ORG})

    assert response.status_code == 401


@pytest.mark.usefixtures("production_settings")
async def test_unauthenticated_write_with_an_invalid_body_is_401_not_400(
    client: AsyncClient,
) -> None:
    response = await client.post(f"/api/v1/projects/{DEV_ORG}/regions", json={"bbox": "bad"})

    assert response.status_code == 401
