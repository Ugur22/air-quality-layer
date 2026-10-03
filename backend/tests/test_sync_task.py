import asyncio
from collections.abc import Callable, Iterator
from typing import Any
from uuid import UUID, uuid4

import httpx
import psycopg
import pytest
from pydantic import SecretStr

from airlayer import sync
from airlayer.config import get_settings
from airlayer.jobs import app as jobs_app
from airlayer.jobs import sync_region
from airlayer.openaq import TransientUpstreamError
from tests.conftest import TEST_URL, Tenant
from tests.test_openaq_client import Upstream, latest, location, sensor

Handler = Callable[[httpx.Request], httpx.Response]


def fake_openaq(monkeypatch: pytest.MonkeyPatch, handler: Handler) -> None:
    def factory(**_: Any) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            transport=httpx.MockTransport(handler), base_url="https://openaq.test/v3"
        )

    monkeypatch.setattr(sync, "make_http_client", factory)


def two_stations() -> Upstream:
    return Upstream(
        [location(1, [sensor(11, "pm25"), sensor(12, "no2")]), location(2)],
        {1: [latest(11, 1, 12.4), latest(12, 1, 30.0)], 2: [latest(20, 2, 4.2)]},
    )


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


def job_row(job_id: UUID) -> dict[str, Any]:
    with psycopg.connect(TEST_URL) as conn:
        row = conn.execute(
            "SELECT status, started_at, finished_at, station_count, errors FROM sync_jobs "
            "WHERE id = %s",
            (job_id,),
        ).fetchone()
    assert row is not None
    status, started_at, finished_at, station_count, errors = row
    return {
        "status": status,
        "started_at": started_at,
        "finished_at": finished_at,
        "station_count": station_count,
        "errors": errors,
    }


def reading_count(job_id: UUID) -> int:
    with psycopg.connect(TEST_URL) as conn:
        row = conn.execute(
            "SELECT count(*) FROM station_readings WHERE sync_job_id = %s", (job_id,)
        ).fetchone()
    assert row is not None
    return int(row[0])


async def test_success_stores_readings_and_the_terminal_status_together(
    make_job: Callable[..., UUID], monkeypatch: pytest.MonkeyPatch
) -> None:
    job_id = make_job()
    fake_openaq(monkeypatch, two_stations())

    await sync.run_sync(job_id, final_attempt=False)

    job = job_row(job_id)
    assert job["status"] == "succeeded"
    assert job["station_count"] == 2
    assert job["errors"] == []
    assert job["started_at"] is not None
    assert job["finished_at"] is not None
    with psycopg.connect(TEST_URL) as conn:
        rows = conn.execute(
            "SELECT openaq_location_id, name, ST_X(geom), ST_Y(geom), ST_SRID(geom), readings "
            "FROM station_readings WHERE sync_job_id = %s ORDER BY openaq_location_id",
            (job_id,),
        ).fetchall()
    assert [r[0] for r in rows] == [1, 2]
    assert rows[0][1:5] == ("Station 1", 4.9, 52.37, 4326)
    assert rows[0][5]["pm25"] == {
        "value": 12.4,
        "unit": "µg/m³",
        "observed_at": "2026-10-03T08:00:00Z",
    }
    assert rows[0][5]["no2"]["value"] == 30.0


async def test_a_region_with_no_stations_succeeds_with_zero(
    make_job: Callable[..., UUID], monkeypatch: pytest.MonkeyPatch
) -> None:
    job_id = make_job()
    fake_openaq(monkeypatch, Upstream([]))

    await sync.run_sync(job_id, final_attempt=False)

    assert job_row(job_id)["status"] == "succeeded"
    assert job_row(job_id)["station_count"] == 0
    assert reading_count(job_id) == 0


async def test_a_malformed_response_fails_the_job_and_leaves_no_partial_readings(
    make_job: Callable[..., UUID], monkeypatch: pytest.MonkeyPatch
) -> None:
    job_id = make_job()
    # Station 1 is fine; station 2's latest value is malformed, so nothing may be stored.
    upstream = Upstream(
        [location(1), location(2)], {1: [latest(10, 1)], 2: [latest(20, 2, value="high")]}
    )
    fake_openaq(monkeypatch, upstream)

    await sync.run_sync(job_id, final_attempt=False)

    job = job_row(job_id)
    assert job["status"] == "failed"
    assert [e["code"] for e in job["errors"]] == ["upstream_invalid_response"]
    assert job["finished_at"] is not None
    assert job["station_count"] is None
    assert reading_count(job_id) == 0


@pytest.mark.parametrize(
    ("status", "code"), [(401, "upstream_unauthorized"), (403, "upstream_unauthorized")]
)
async def test_a_rejected_key_fails_immediately(
    make_job: Callable[..., UUID], monkeypatch: pytest.MonkeyPatch, status: int, code: str
) -> None:
    job_id = make_job()
    fake_openaq(monkeypatch, lambda request: httpx.Response(status, json={}))

    await sync.run_sync(job_id, final_attempt=False)

    assert job_row(job_id)["status"] == "failed"
    assert job_row(job_id)["errors"][0]["code"] == code


async def test_too_many_stations_fails_with_its_own_code(
    make_job: Callable[..., UUID], monkeypatch: pytest.MonkeyPatch
) -> None:
    job_id = make_job()
    fake_openaq(monkeypatch, Upstream([location(1)], found=51))

    await sync.run_sync(job_id, final_attempt=False)

    assert job_row(job_id)["errors"][0]["code"] == "too_many_stations"


async def test_a_missing_api_key_fails_the_job_without_calling_openaq(
    make_job: Callable[..., UUID], monkeypatch: pytest.MonkeyPatch
) -> None:
    job_id = make_job()
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(200, json={})

    fake_openaq(monkeypatch, handler)
    no_key = get_settings().model_copy(update={"openaq_api_key": SecretStr("")})
    monkeypatch.setattr(sync, "get_settings", lambda: no_key)

    await sync.run_sync(job_id, final_attempt=False)

    assert job_row(job_id)["errors"][0]["code"] == "upstream_unauthorized"
    assert calls == []


async def test_a_transient_failure_before_the_last_attempt_leaves_the_job_for_a_retry(
    make_job: Callable[..., UUID], monkeypatch: pytest.MonkeyPatch
) -> None:
    job_id = make_job()
    fake_openaq(monkeypatch, lambda request: httpx.Response(503, json={}))

    with pytest.raises(TransientUpstreamError):
        await sync.run_sync(job_id, final_attempt=False)

    assert job_row(job_id)["status"] == "processing"


async def test_a_transient_failure_on_the_last_attempt_fails_the_job(
    make_job: Callable[..., UUID], monkeypatch: pytest.MonkeyPatch
) -> None:
    job_id = make_job()
    fake_openaq(monkeypatch, lambda request: httpx.Response(503, json={}))

    await sync.run_sync(job_id, final_attempt=True)

    job = job_row(job_id)
    assert job["status"] == "failed"
    assert job["errors"][0]["code"] == "upstream_unavailable"


async def test_an_unexpected_error_fails_the_job_without_leaking_internals(
    make_job: Callable[..., UUID], monkeypatch: pytest.MonkeyPatch
) -> None:
    job_id = make_job()

    def boom(request: httpx.Request) -> httpx.Response:
        raise RuntimeError("secret internal detail")

    fake_openaq(monkeypatch, boom)

    await sync.run_sync(job_id, final_attempt=False)

    job = job_row(job_id)
    assert job["status"] == "failed"
    assert job["errors"][0]["code"] == "processing_error"
    assert "secret internal detail" not in job["errors"][0]["message"]


async def test_a_finished_job_is_not_processed_again(
    make_job: Callable[..., UUID], monkeypatch: pytest.MonkeyPatch
) -> None:
    job_id = make_job()
    upstream = two_stations()
    fake_openaq(monkeypatch, upstream)
    await sync.run_sync(job_id, final_attempt=False)
    calls_after_first_run = len(upstream.calls)

    await sync.run_sync(job_id, final_attempt=False)

    assert len(upstream.calls) == calls_after_first_run
    assert reading_count(job_id) == 2


async def test_an_unknown_job_id_is_ignored(monkeypatch: pytest.MonkeyPatch) -> None:
    upstream = Upstream([])
    fake_openaq(monkeypatch, upstream)

    await sync.run_sync(uuid4(), final_attempt=False)

    assert upstream.calls == []


async def test_a_job_reaped_during_the_fetch_is_not_overwritten_and_stores_nothing(
    make_job: Callable[..., UUID], monkeypatch: pytest.MonkeyPatch
) -> None:
    job_id = make_job()
    upstream = two_stations()

    def reaped_midway(request: httpx.Request) -> httpx.Response:
        with psycopg.connect(TEST_URL, autocommit=True) as conn:
            conn.execute(
                "UPDATE sync_jobs SET status = 'failed', finished_at = now(), "
                'errors = \'[{"code": "timed_out", "message": "x"}]\' WHERE id = %s',
                (job_id,),
            )
        return upstream(request)

    fake_openaq(monkeypatch, reaped_midway)

    await sync.run_sync(job_id, final_attempt=False)

    assert job_row(job_id)["errors"][0]["code"] == "timed_out"
    assert reading_count(job_id) == 0


async def test_reaper_fails_abandoned_jobs_and_leaves_the_rest(
    make_job: Callable[..., UUID],
) -> None:
    minutes = get_settings().sync_timeout_minutes
    stuck_processing = make_job("processing", age_minutes=minutes + 1)
    never_picked_up = make_job("queued", age_minutes=minutes + 1)
    recent = make_job("processing", age_minutes=1)
    finished = make_job("succeeded", age_minutes=minutes + 60)

    reaped = await sync.reap_stale_jobs()

    assert reaped >= 2
    for job_id in (stuck_processing, never_picked_up):
        job = job_row(job_id)
        assert job["status"] == "failed"
        assert job["errors"][0]["code"] == "timed_out"
        assert job["finished_at"] is not None
    assert job_row(recent)["status"] == "processing"
    assert job_row(finished)["status"] == "succeeded"


def test_a_database_refuses_two_in_flight_syncs_for_one_region(
    make_job: Callable[..., UUID],
) -> None:
    job_id = make_job("queued")
    with psycopg.connect(TEST_URL, autocommit=True) as conn:
        organisation_id, region_id = conn.execute(
            "SELECT organisation_id, region_id FROM sync_jobs WHERE id = %s", (job_id,)
        ).fetchone() or (None, None)
        with pytest.raises(psycopg.errors.UniqueViolation):
            conn.execute(
                "INSERT INTO sync_jobs (id, organisation_id, region_id, status) "
                "VALUES (%s, %s, %s, 'processing')",
                (uuid4(), organisation_id, region_id),
            )


# --- through the real Procrastinate worker (docs/quality.md) -------------------------------


@pytest.fixture
def empty_queue() -> Iterator[None]:
    with psycopg.connect(TEST_URL, autocommit=True) as conn:
        conn.execute("DELETE FROM procrastinate_jobs")
    yield


async def run_worker() -> None:
    await jobs_app.run_worker_async(wait=False)


@pytest.mark.usefixtures("empty_queue")
async def test_worker_retries_a_transient_failure_then_succeeds(
    make_job: Callable[..., UUID], monkeypatch: pytest.MonkeyPatch
) -> None:
    job_id = make_job()
    upstream = two_stations()
    attempts = {"locations": 0}

    def flaky(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/locations"):
            attempts["locations"] += 1
            if attempts["locations"] == 1:
                return httpx.Response(503, json={})
        return upstream(request)

    fake_openaq(monkeypatch, flaky)
    await sync_region.defer_async(sync_job_id=str(job_id))

    await run_worker()

    assert attempts["locations"] == 2
    assert job_row(job_id)["status"] == "succeeded"
    assert reading_count(job_id) == 2


@pytest.mark.usefixtures("empty_queue")
async def test_worker_ends_the_job_failed_when_retries_are_exhausted(
    make_job: Callable[..., UUID], monkeypatch: pytest.MonkeyPatch
) -> None:
    job_id = make_job()
    calls: list[httpx.Request] = []

    def always_down(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(503, json={})

    fake_openaq(monkeypatch, always_down)
    await sync_region.defer_async(sync_job_id=str(job_id))

    await run_worker()

    assert len(calls) == 1 + get_settings().max_sync_retries
    job = job_row(job_id)
    assert job["status"] == "failed"
    assert job["errors"][0]["code"] == "upstream_unavailable"
    assert reading_count(job_id) == 0


@pytest.mark.usefixtures("empty_queue")
async def test_worker_does_not_retry_a_permanent_failure(
    make_job: Callable[..., UUID], monkeypatch: pytest.MonkeyPatch
) -> None:
    job_id = make_job()
    calls: list[httpx.Request] = []

    def rejected(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(401, json={})

    fake_openaq(monkeypatch, rejected)
    await sync_region.defer_async(sync_job_id=str(job_id))

    await run_worker()

    assert len(calls) == 1
    assert job_row(job_id)["errors"][0]["code"] == "upstream_unauthorized"


@pytest.mark.usefixtures("empty_queue")
async def test_worker_running_the_same_job_twice_does_not_duplicate_readings(
    make_job: Callable[..., UUID], monkeypatch: pytest.MonkeyPatch
) -> None:
    job_id = make_job()
    fake_openaq(monkeypatch, two_stations())
    await sync_region.defer_async(sync_job_id=str(job_id))
    await sync_region.defer_async(sync_job_id=str(job_id))

    await run_worker()

    assert job_row(job_id)["status"] == "succeeded"
    assert reading_count(job_id) == 2


async def test_a_429_waits_out_the_rate_limit_window_before_the_retry(
    make_job: Callable[..., UUID], monkeypatch: pytest.MonkeyPatch
) -> None:
    job_id = make_job()
    fake_openaq(
        monkeypatch, lambda r: httpx.Response(429, headers={"x-ratelimit-reset": "30"}, json={})
    )
    slept: list[float] = []

    async def record(seconds: float) -> None:
        slept.append(seconds)

    monkeypatch.setattr(sync, "_sleep", record)

    with pytest.raises(TransientUpstreamError):
        await sync.run_sync(job_id, final_attempt=False)

    assert slept == [30]
    assert job_row(job_id)["status"] == "processing"


async def test_an_error_while_starting_the_job_fails_it_instead_of_leaving_it_stuck(
    make_job: Callable[..., UUID], monkeypatch: pytest.MonkeyPatch
) -> None:
    job_id = make_job()

    async def broken_start(_: UUID) -> list[float]:
        raise RuntimeError("database hiccup")

    monkeypatch.setattr(sync, "_start", broken_start)

    await sync.run_sync(job_id, final_attempt=False)

    job = job_row(job_id)
    assert job["status"] == "failed"
    assert job["errors"][0]["code"] == "processing_error"


async def test_a_fetch_that_runs_past_its_deadline_fails_with_timed_out(
    make_job: Callable[..., UUID], monkeypatch: pytest.MonkeyPatch
) -> None:
    job_id = make_job()

    async def slow(request: httpx.Request) -> httpx.Response:
        await asyncio.sleep(1)
        return httpx.Response(200, json={})

    fake_openaq(monkeypatch, slow)  # type: ignore[arg-type]
    monkeypatch.setattr(sync, "_fetch_deadline_seconds", lambda settings: 0.05)

    await sync.run_sync(job_id, final_attempt=False)

    job = job_row(job_id)
    assert job["status"] == "failed"
    assert job["errors"][0]["code"] == "timed_out"


async def test_stored_error_messages_never_contain_the_key_or_the_upstream_url(
    make_job: Callable[..., UUID], monkeypatch: pytest.MonkeyPatch
) -> None:
    key = get_settings().openaq_api_key.get_secret_value()
    leaky = (
        httpx.Response(403, text=f"bad key {key} at https://openaq.test/v3/locations", json=None)
        if False
        else None
    )
    assert leaky is None
    for handler in (
        lambda r: httpx.Response(401, text=f"{key} https://openaq.test/v3/locations"),
        lambda r: httpx.Response(200, text=f"{key} not json"),
        lambda r: httpx.Response(503, text=f"{key}"),
    ):
        job_id = make_job()
        fake_openaq(monkeypatch, handler)

        await sync.run_sync(job_id, final_attempt=True)

        message = job_row(job_id)["errors"][0]["message"]
        assert key not in message
        assert "openaq.test" not in message
