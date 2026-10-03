import os
from collections.abc import AsyncIterator, Callable, Iterator
from dataclasses import dataclass
from uuid import UUID, uuid4

import psycopg
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from psycopg import sql

ADMIN_URL = os.environ.get(
    "AIRLAYER_TEST_ADMIN_URL", "postgresql://airlayer:airlayer@127.0.0.1:5434/airlayer"
)
TEST_DB = "airlayer_test"
TEST_URL = ADMIN_URL.rsplit("/", 1)[0] + f"/{TEST_DB}"

# Must be set before any airlayer module is imported: settings and the queue app read them at
# import time. Tests never touch the development database.
os.environ["AIRLAYER_DATABASE_URL"] = TEST_URL
os.environ["AIRLAYER_ENVIRONMENT"] = "development"
os.environ["AIRLAYER_OPENAQ_API_KEY"] = "test-key-not-a-secret"
os.environ["AIRLAYER_SYNC_RETRY_WAIT_SECONDS"] = "0"


@pytest.fixture(scope="session", autouse=True)
def database() -> Iterator[None]:
    with psycopg.connect(ADMIN_URL, autocommit=True) as conn:
        conn.execute(
            sql.SQL("DROP DATABASE IF EXISTS {} WITH (FORCE)").format(sql.Identifier(TEST_DB))
        )
        conn.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(TEST_DB)))
    with psycopg.connect(TEST_URL, autocommit=True) as conn:
        conn.execute("CREATE EXTENSION IF NOT EXISTS postgis")

    from airlayer.migrate import main

    main()
    yield


@pytest_asyncio.fixture(scope="session", autouse=True)
async def queue(database: None) -> AsyncIterator[None]:
    from airlayer.jobs import app

    async with app.open_async():
        yield


@pytest_asyncio.fixture
async def client(queue: None) -> AsyncIterator[AsyncClient]:
    from airlayer.main import app

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


@dataclass(frozen=True)
class Tenant:
    organisation_id: UUID
    project_id: UUID

    @property
    def headers(self) -> dict[str, str]:
        return {"X-Dev-Organisation-Id": str(self.organisation_id)}


@pytest.fixture
def make_tenant(database: None) -> Callable[[], Tenant]:
    """Each call inserts a fresh organisation and project, so tests never share rows."""

    def make() -> Tenant:
        tenant = Tenant(uuid4(), uuid4())
        with psycopg.connect(TEST_URL, autocommit=True) as conn:
            conn.execute(
                "INSERT INTO organisations (id, name) VALUES (%s, %s)",
                (tenant.organisation_id, "Test organisation"),
            )
            conn.execute(
                "INSERT INTO projects (id, organisation_id, name) VALUES (%s, %s, %s)",
                (tenant.project_id, tenant.organisation_id, "Test project"),
            )
        return tenant

    return make
