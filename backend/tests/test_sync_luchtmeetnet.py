"""A sync with a second source (ADR 0017): merged stations, and what a Luchtmeetnet failure does."""

import asyncio
from collections.abc import Callable
from typing import Any
from uuid import UUID

import httpx
import psycopg
import pytest

from airlayer import luchtmeetnet, sync
from airlayer.config import get_settings
from tests.conftest import TEST_URL
from tests.test_openaq_client import Upstream, latest, location, sensor
from tests.test_sync_task import fake_openaq, job_row, reading_count, two_stations

# Both OpenAQ test stations sit at (4.9, 52.37).
HERE = luchtmeetnet.CatalogueStation("NL1", "Here", 4.9, 52.37)
ELSEWHERE = luchtmeetnet.CatalogueStation("NL2", "Elsewhere", 4.86, 52.36)


def measurements(**values: float) -> dict[str, Any]:
    return {
        "data": [
            {
                "value": value,
                "formula": formula.upper(),
                "timestamp_measured": "2026-10-03T09:00:00+00:00",
            }
            for formula, value in values.items()
        ]
    }


def fake_luchtmeetnet(
    monkeypatch: pytest.MonkeyPatch,
    handler: Callable[[httpx.Request], httpx.Response],
    stations: tuple[luchtmeetnet.CatalogueStation, ...] = (HERE, ELSEWHERE),
) -> list[httpx.Request]:
    calls: list[httpx.Request] = []

    def recording(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return handler(request)

    def factory(**_: Any) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            transport=httpx.MockTransport(recording), base_url="https://luchtmeetnet.test/open_api"
        )

    monkeypatch.setattr(luchtmeetnet, "make_http_client", factory)
    monkeypatch.setattr(luchtmeetnet, "load_catalogue", lambda: stations)
    return calls


def answers_by_station(request: httpx.Request) -> httpx.Response:
    number = request.url.path.split("/")[-2]
    body = {"NL1": measurements(pm25=3.1, bcwb=0.09), "NL2": measurements(pm25=5.0)}[number]
    return httpx.Response(200, json=body)


def stored(job_id: UUID) -> list[tuple[Any, ...]]:
    with psycopg.connect(TEST_URL) as conn:
        return conn.execute(
            "SELECT openaq_location_id, luchtmeetnet_number, sources, readings "
            "FROM station_readings WHERE sync_job_id = %s "
            "ORDER BY openaq_location_id NULLS LAST, luchtmeetnet_number",
            (job_id,),
        ).fetchall()


async def test_stations_of_both_sources_are_merged_into_one_layer(
    make_job: Callable[..., UUID], monkeypatch: pytest.MonkeyPatch
) -> None:
    job_id = make_job()
    fake_openaq(monkeypatch, two_stations())
    fake_luchtmeetnet(monkeypatch, answers_by_station)

    await sync.run_sync(job_id, final_attempt=False)

    job = job_row(job_id)
    assert job["status"] == "succeeded"
    assert job["station_count"] == 3
    rows = stored(job_id)
    # Station 1 absorbed Luchtmeetnet's NL1; station 2 is OpenAQ only; NL2 is Luchtmeetnet only.
    assert [(r[0], r[1], r[2]) for r in rows] == [
        (1, "NL1", ["openaq", "luchtmeetnet"]),
        (2, None, ["openaq"]),
        (None, "NL2", ["luchtmeetnet"]),
    ]
    merged = rows[0][3]
    assert merged["pm25"]["value"] == 3.1
    assert merged["pm25"]["source"] == "luchtmeetnet"
    assert merged["no2"]["source"] == "openaq"
    assert merged["bcwb"] == {
        "value": 0.09,
        "unit": "µg/m³",
        "observed_at": "2026-10-03T09:00:00Z",
        "source": "luchtmeetnet",
    }


async def test_a_luchtmeetnet_failure_leaves_a_warning_and_openaqs_stations(
    make_job: Callable[..., UUID], monkeypatch: pytest.MonkeyPatch
) -> None:
    job_id = make_job()
    fake_openaq(monkeypatch, two_stations())
    fake_luchtmeetnet(monkeypatch, lambda request: httpx.Response(503))

    await sync.run_sync(job_id, final_attempt=False)

    job = job_row(job_id)
    assert job["status"] == "succeeded"
    assert job["station_count"] == 2
    assert job["errors"] == []
    with psycopg.connect(TEST_URL) as conn:
        warnings = conn.execute(
            "SELECT warnings FROM sync_jobs WHERE id = %s", (job_id,)
        ).fetchone()
    assert warnings is not None
    assert [w["code"] for w in warnings[0]] == ["luchtmeetnet_unavailable"]
    assert [r[2] for r in stored(job_id)] == [["openaq"], ["openaq"]]


async def test_a_malformed_luchtmeetnet_answer_is_a_warning_too(
    make_job: Callable[..., UUID], monkeypatch: pytest.MonkeyPatch
) -> None:
    job_id = make_job()
    fake_openaq(monkeypatch, two_stations())
    fake_luchtmeetnet(monkeypatch, lambda request: httpx.Response(200, json={"data": "x"}))

    await sync.run_sync(job_id, final_attempt=False)

    assert job_row(job_id)["status"] == "succeeded"
    assert reading_count(job_id) == 2


async def test_openaq_failing_still_fails_the_job_even_when_luchtmeetnet_is_fine(
    make_job: Callable[..., UUID], monkeypatch: pytest.MonkeyPatch
) -> None:
    job_id = make_job()
    fake_openaq(monkeypatch, lambda request: httpx.Response(403, json={}))
    fake_luchtmeetnet(monkeypatch, answers_by_station)

    await sync.run_sync(job_id, final_attempt=False)

    assert job_row(job_id)["status"] == "failed"
    assert reading_count(job_id) == 0


async def test_a_region_without_luchtmeetnet_stations_never_calls_it(
    make_job: Callable[..., UUID], monkeypatch: pytest.MonkeyPatch
) -> None:
    job_id = make_job()
    fake_openaq(monkeypatch, two_stations())
    calls = fake_luchtmeetnet(monkeypatch, answers_by_station, stations=())

    await sync.run_sync(job_id, final_attempt=False)

    assert calls == []
    assert job_row(job_id)["station_count"] == 2


async def test_the_station_cap_applies_to_the_merged_result(
    make_job: Callable[..., UUID], monkeypatch: pytest.MonkeyPatch
) -> None:
    job_id = make_job()
    fake_openaq(monkeypatch, two_stations())
    fake_luchtmeetnet(monkeypatch, answers_by_station)
    capped = get_settings().model_copy(update={"max_stations_per_sync": 2})
    monkeypatch.setattr(sync, "get_settings", lambda: capped)

    await sync.run_sync(job_id, final_attempt=False)

    assert job_row(job_id)["errors"][0]["code"] == "too_many_stations"
    assert reading_count(job_id) == 0


async def test_a_slow_luchtmeetnet_costs_a_warning_not_the_sync(
    make_job: Callable[..., UUID], monkeypatch: pytest.MonkeyPatch
) -> None:
    job_id = make_job()
    fake_openaq(monkeypatch, two_stations())

    async def never_answers(request: httpx.Request) -> httpx.Response:
        await asyncio.sleep(5)
        return httpx.Response(200, json=measurements(pm25=1.0))

    fake_luchtmeetnet(monkeypatch, never_answers)  # type: ignore[arg-type]
    impatient = get_settings().model_copy(update={"luchtmeetnet_budget_seconds": 0.05})
    monkeypatch.setattr(sync, "get_settings", lambda: impatient)

    await sync.run_sync(job_id, final_attempt=False)

    job = job_row(job_id)
    assert job["status"] == "succeeded"
    assert job["station_count"] == 2
    assert reading_count(job_id) == 2


async def test_a_region_over_the_cap_by_luchtmeetnet_stations_alone_fails_before_any_call(
    make_job: Callable[..., UUID], monkeypatch: pytest.MonkeyPatch
) -> None:
    job_id = make_job()
    fake_openaq(monkeypatch, Upstream([]))
    calls = fake_luchtmeetnet(monkeypatch, answers_by_station)
    capped = get_settings().model_copy(update={"max_stations_per_sync": 1})
    monkeypatch.setattr(sync, "get_settings", lambda: capped)

    await sync.run_sync(job_id, final_attempt=False)

    assert job_row(job_id)["errors"][0]["code"] == "too_many_stations"
    assert calls == []


async def test_the_greek_mu_is_stored_as_the_micro_sign(
    make_job: Callable[..., UUID], monkeypatch: pytest.MonkeyPatch
) -> None:
    job_id = make_job()
    greek = Upstream([location(1, [sensor(11, "pm25", units="μg/m³")])], {1: [latest(11, 1, 12.4)]})
    fake_openaq(monkeypatch, greek)

    await sync.run_sync(job_id, final_attempt=False)

    assert stored(job_id)[0][3]["pm25"]["unit"] == "µg/m³"
