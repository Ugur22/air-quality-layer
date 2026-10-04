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


@pytest.fixture(autouse=True)
def no_luchtmeetnet_stations(monkeypatch: pytest.MonkeyPatch) -> None:
    """Syncs in tests never reach the real Luchtmeetnet: its catalogue is empty unless a test
    sets one (ADR 0017)."""
    from airlayer import luchtmeetnet

    monkeypatch.setattr(luchtmeetnet, "load_catalogue", lambda: ())


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


@pytest.fixture
def make_job(make_tenant: Callable[[], Tenant]) -> Callable[..., UUID]:
    def make(status: str = "queued", age_minutes: int = 0) -> UUID:
        tenant = make_tenant()
        region_id, job_id = uuid4(), uuid4()
        with psycopg.connect(TEST_URL, autocommit=True) as conn:
            conn.execute(
                "INSERT INTO regions (id, project_id, organisation_id, name, geom) VALUES "
                "(%s, %s, %s, 'r', ST_MakeEnvelope(4.85, 52.35, 4.95, 52.40, 4326))",
                (region_id, tenant.project_id, tenant.organisation_id),
            )
            conn.execute(
                "INSERT INTO sync_jobs (id, organisation_id, region_id, status, created_at) "
                "VALUES (%s, %s, %s, %s, now() - make_interval(mins => %s))",
                (job_id, tenant.organisation_id, region_id, status, age_minutes),
            )
        return job_id

    return make
