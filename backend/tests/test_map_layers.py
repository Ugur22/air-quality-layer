from collections.abc import Callable
from dataclasses import dataclass
from typing import Any
from uuid import UUID, uuid4

import psycopg
import pytest
from httpx import AsyncClient

from airlayer.jobs import app as jobs_app
from tests.conftest import TEST_URL, Tenant
from tests.test_regions import BBOX, create_region
from tests.test_sync_task import fake_openaq, two_stations
from tests.test_syncs_api import start_sync


def reading(value: float, unit: str = "µg/m³") -> dict[str, Any]:
    return {"value": value, "unit": unit, "observed_at": "2026-10-03T08:00:00Z"}


# location id -> (name, lon, lat, readings)
STATIONS: dict[int, tuple[str, float, float, dict[str, Any]]] = {
    1: ("Low", 4.86, 52.36, {"pm25": reading(4.2), "no2": reading(20.0)}),
    2: ("Mid", 4.90, 52.37, {"pm25": reading(10.0)}),
    3: ("High", 4.94, 52.39, {"pm25": reading(26.1), "no2": reading(-1.5)}),
    4: ("NoPm", 4.88, 52.38, {"no2": reading(33.0)}),
}


@dataclass(frozen=True)
class Layer:
    tenant: Tenant
    region_id: UUID
    job_id: UUID

    @property
    def url(self) -> str:
        return f"/api/v1/map-layers/{self.job_id}"


@pytest.fixture
def make_layer(make_tenant: Callable[[], Tenant]) -> Callable[..., Layer]:
    """A region with a sync job in the given status and, for succeeded jobs, its readings."""

    def make(
        status: str = "succeeded",
        stations: dict[int, tuple[str, float, float, dict[str, Any]]] | None = None,
        tenant: Tenant | None = None,
    ) -> Layer:
        tenant = tenant or make_tenant()
        stations = STATIONS if stations is None else stations
        region_id, job_id = uuid4(), uuid4()
        with psycopg.connect(TEST_URL, autocommit=True) as conn:
            conn.execute(
                "INSERT INTO regions (id, project_id, organisation_id, name, geom) VALUES "
                "(%s, %s, %s, 'r', ST_MakeEnvelope(4.85, 52.35, 4.95, 52.40, 4326))",
                (region_id, tenant.project_id, tenant.organisation_id),
            )
            conn.execute(
                "INSERT INTO sync_jobs (id, organisation_id, region_id, status, station_count) "
                "VALUES (%s, %s, %s, %s, %s)",
                (
                    job_id,
                    tenant.organisation_id,
                    region_id,
                    status,
                    len(stations) if status == "succeeded" else None,
                ),
            )
            if status == "succeeded":
                for location_id, (name, lon, lat, readings) in stations.items():
                    conn.execute(
                        "INSERT INTO station_readings "
                        "(id, sync_job_id, openaq_location_id, name, geom, readings) VALUES "
                        "(%s, %s, %s, %s, ST_SetSRID(ST_MakePoint(%s, %s), 4326), %s::jsonb)",
                        (
                            uuid4(),
                            job_id,
                            location_id,
                            name,
                            lon,
                            lat,
                            psycopg.types.json.Jsonb(readings),
                        ),
                    )
        return Layer(tenant, region_id, job_id)

    return make


def names(body: dict[str, Any]) -> list[str]:
    return [f["properties"]["name"] for f in body["stations"]["features"]]


async def get_layer(
    client: AsyncClient,
    layer: Layer,
    params: dict[str, str] | None = None,
    tenant: Tenant | None = None,
) -> Any:
    return await client.get(layer.url, params=params, headers=(tenant or layer.tenant).headers)


async def test_layer_is_a_geojson_feature_collection_with_the_documented_shape(
    client: AsyncClient, make_layer: Callable[..., Layer]
) -> None:
    layer = make_layer()

    response = await get_layer(client, layer)

    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"map_layer", "stations"}
    assert body["map_layer"] == {
        "id": str(layer.job_id),
        "region_id": str(layer.region_id),
        "station_count": 4,
        "bbox": BBOX,
        "property_keys": ["no2", "pm25"],
    }
    assert body["stations"]["type"] == "FeatureCollection"
    assert names(body) == ["Low", "Mid", "High", "NoPm"]
    low = body["stations"]["features"][0]
    assert set(low) == {"type", "id", "geometry", "properties"}
    assert low["type"] == "Feature"
    UUID(low["id"])
    # [longitude, latitude], not [latitude, longitude]
    assert low["geometry"] == {"type": "Point", "coordinates": [4.86, 52.36]}
    # A layer stored before there was a second source reads as OpenAQ's (ADR 0017).
    assert low["properties"] == {
        "name": "Low",
        "sources": ["openaq"],
        "readings": {
            "no2": {
                "value": 20.0,
                "unit": "µg/m³",
                "observed_at": "2026-10-03T08:00:00Z",
                "source": "openaq",
            },
            "pm25": {
                "value": 4.2,
                "unit": "µg/m³",
                "observed_at": "2026-10-03T08:00:00Z",
                "source": "openaq",
            },
        },
    }


async def test_an_empty_layer_is_valid(
    client: AsyncClient, make_layer: Callable[..., Layer]
) -> None:
    layer = make_layer(stations={})

    body = (await get_layer(client, layer)).json()

    assert body["map_layer"]["station_count"] == 0
    assert body["map_layer"]["property_keys"] == []
    assert body["stations"]["features"] == []


@pytest.mark.parametrize("status", ["queued", "processing", "failed"])
async def test_only_a_succeeded_sync_is_a_layer(
    client: AsyncClient, make_layer: Callable[..., Layer], status: str
) -> None:
    layer = make_layer(status=status)

    response = await get_layer(client, layer)

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"


async def test_a_layer_of_another_organisation_is_not_found(
    client: AsyncClient, make_layer: Callable[..., Layer], make_tenant: Callable[[], Tenant]
) -> None:
    layer = make_layer()

    response = await get_layer(client, layer, tenant=make_tenant())

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"


async def test_another_organisation_learns_nothing_from_a_bad_filter_on_a_foreign_layer(
    client: AsyncClient, make_layer: Callable[..., Layer], make_tenant: Callable[[], Tenant]
) -> None:
    layer = make_layer()

    response = await get_layer(
        client, layer, {"property": "nope", "value": "1"}, tenant=make_tenant()
    )

    # 404, not the 400 that would list this layer's property keys
    assert response.status_code == 404
    assert "pm25" not in response.text


@pytest.mark.parametrize("layer_id", [str(uuid4()), "not-a-uuid"])
async def test_an_unknown_layer_is_not_found(client: AsyncClient, layer_id: str) -> None:
    response = await client.get(f"/api/v1/map-layers/{layer_id}")

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"


@pytest.mark.parametrize(
    ("comparator", "value", "expected"),
    [
        (">", "10", ["High"]),
        (">=", "10", ["Mid", "High"]),
        ("<", "10", ["Low"]),
        ("<=", "10", ["Low", "Mid"]),
        ("=", "10", ["Mid"]),
        ("=", "10.0", ["Mid"]),
        ("=", "4.2", ["Low"]),
        (">", "-5", ["Low", "Mid", "High"]),
        (">", "1000", []),
    ],
)
async def test_filter_compares_the_reading_value_with_each_comparator(
    client: AsyncClient,
    make_layer: Callable[..., Layer],
    comparator: str,
    value: str,
    expected: list[str],
) -> None:
    layer = make_layer()

    response = await get_layer(
        client, layer, {"property": "pm25", "value": value, "comparator": comparator}
    )

    assert response.status_code == 200
    assert names(response.json()) == expected


async def test_comparator_defaults_to_equals(
    client: AsyncClient, make_layer: Callable[..., Layer]
) -> None:
    layer = make_layer()

    response = await get_layer(client, layer, {"property": "pm25", "value": "10"})

    assert names(response.json()) == ["Mid"]


async def test_negative_readings_can_be_filtered(
    client: AsyncClient, make_layer: Callable[..., Layer]
) -> None:
    layer = make_layer()

    response = await get_layer(client, layer, {"property": "no2", "value": "-1", "comparator": "<"})

    assert names(response.json()) == ["High"]


async def test_a_station_without_the_property_is_excluded_not_an_error(
    client: AsyncClient, make_layer: Callable[..., Layer]
) -> None:
    layer = make_layer()

    response = await get_layer(client, layer, {"property": "pm25", "value": "0", "comparator": ">"})

    assert response.status_code == 200
    assert names(response.json()) == ["Low", "Mid", "High"]


async def test_filtering_keeps_feature_ids_and_describes_the_whole_layer(
    client: AsyncClient, make_layer: Callable[..., Layer]
) -> None:
    layer = make_layer()
    unfiltered = (await get_layer(client, layer)).json()
    filtered = (
        await get_layer(client, layer, {"property": "pm25", "value": "10", "comparator": ">="})
    ).json()

    id_by_name = {f["properties"]["name"]: f["id"] for f in unfiltered["stations"]["features"]}
    assert [f["id"] for f in filtered["stations"]["features"]] == [
        id_by_name["Mid"],
        id_by_name["High"],
    ]
    # station_count and property_keys keep describing the whole layer, so a filter UI is stable.
    assert filtered["map_layer"] == unfiltered["map_layer"]


@pytest.mark.parametrize(
    "params",
    [
        pytest.param({"property": "pm25"}, id="property-without-value"),
        pytest.param({"value": "10"}, id="value-without-property"),
        pytest.param({"comparator": ">"}, id="comparator-alone"),
        pytest.param({"property": "pm25", "value": "10", "comparator": "!="}, id="bad-comparator"),
        pytest.param({"property": "pm25", "value": "abc"}, id="text-value"),
        pytest.param({"property": "pm25", "value": ""}, id="empty-value"),
        pytest.param({"property": "pm25", "value": "1e3"}, id="exponent"),
        pytest.param({"property": "pm25", "value": "+5"}, id="plus-sign"),
        pytest.param({"property": "pm25", "value": ".5"}, id="no-leading-digit"),
        pytest.param({"property": "pm25", "value": "5."}, id="trailing-dot"),
        pytest.param({"property": "pm25", "value": "١٢"}, id="non-ascii-digits"),
        pytest.param({"property": "pm25", "value": "9" * 400}, id="overflows-to-infinity"),
        pytest.param({"property": "nope", "value": "1"}, id="unknown-property"),
        pytest.param({"property": "", "value": "1"}, id="empty-property"),
    ],
)
async def test_bad_filters_are_validation_errors(
    client: AsyncClient, make_layer: Callable[..., Layer], params: dict[str, str]
) -> None:
    layer = make_layer()

    response = await get_layer(client, layer, params)

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "validation_failed"


async def test_the_whole_backend_flow_from_region_to_filtered_layer(
    client: AsyncClient, make_tenant: Callable[[], Tenant], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Region -> sync (real worker, mocked OpenAQ) -> layer with and without a filter."""
    with psycopg.connect(TEST_URL, autocommit=True) as conn:
        conn.execute("DELETE FROM procrastinate_jobs")
    fake_openaq(monkeypatch, two_stations())
    tenant = make_tenant()
    region = await create_region(client, tenant)
    job = (await start_sync(client, tenant, region["id"])).json()["sync_job"]
    await jobs_app.run_worker_async(wait=False)

    layer_url = f"/api/v1/map-layers/{job['id']}"
    everything = (await client.get(layer_url, headers=tenant.headers)).json()
    only_high_no2 = (
        await client.get(
            layer_url,
            params={"property": "no2", "value": "20", "comparator": ">"},
            headers=tenant.headers,
        )
    ).json()

    assert everything["map_layer"]["station_count"] == 2
    assert everything["map_layer"]["property_keys"] == ["no2", "pm25"]
    assert names(everything) == ["Station 1", "Station 2"]
    assert names(only_high_no2) == ["Station 1"]
    station_one = only_high_no2["stations"]["features"][0]
    assert station_one["properties"]["readings"]["no2"]["value"] == 30.0
    assert station_one["geometry"]["coordinates"] == [4.9, 52.37]


async def test_missing_data_markers_stored_before_the_rule_are_not_served(
    client: AsyncClient, make_layer: Callable[..., Layer]
) -> None:
    layer = make_layer(
        stations={
            1: ("A", 4.9, 52.37, {"pm25": reading(-998.0), "no2": reading(7.0)}),
            2: ("B", 4.9, 52.38, {"pm25": reading(-999.0), "pm10": reading(-995.0)}),
            3: ("C", 4.9, 52.39, {"pm25": reading(-989.0)}),
        }
    )

    body = (await get_layer(client, layer)).json()

    assert body["map_layer"]["property_keys"] == ["no2", "pm25"]
    by_name = {
        f["properties"]["name"]: f["properties"]["readings"] for f in body["stations"]["features"]
    }
    assert set(by_name["A"]) == {"no2"}
    assert by_name["B"] == {}
    # Above the threshold: kept, a small-looking negative is not a marker.
    assert by_name["C"]["pm25"]["value"] == -989.0
    assert body["map_layer"]["station_count"] == 3


async def test_a_filter_does_not_match_a_stored_marker_value(
    client: AsyncClient, make_layer: Callable[..., Layer]
) -> None:
    layer = make_layer(
        stations={
            1: ("A", 4.9, 52.37, {"pm25": reading(-998.0)}),
            2: ("B", 4.9, 52.38, {"pm25": reading(3.0)}),
        }
    )

    response = await get_layer(client, layer, {"property": "pm25", "comparator": "<", "value": "5"})

    assert names(response.json()) == ["B"]


def add_luchtmeetnet_station(layer: Layer, number: str, name: str = "Only Luchtmeetnet") -> None:
    readings = reading(0.09) | {"source": "luchtmeetnet"}
    with psycopg.connect(TEST_URL, autocommit=True) as conn:
        conn.execute(
            "INSERT INTO station_readings "
            "(id, sync_job_id, luchtmeetnet_number, sources, name, geom, readings) VALUES "
            "(%s, %s, %s, %s::jsonb, %s, ST_SetSRID(ST_MakePoint(4.87, 52.37), 4326), %s::jsonb)",
            (
                uuid4(),
                layer.job_id,
                number,
                psycopg.types.json.Jsonb(["luchtmeetnet"]),
                name,
                psycopg.types.json.Jsonb({"bcwb": readings}),
            ),
        )


async def test_a_station_only_luchtmeetnet_has_is_served_last_with_its_source_and_pollutants(
    client: AsyncClient, make_layer: Callable[..., Layer]
) -> None:
    layer = make_layer()
    add_luchtmeetnet_station(layer, "NL2")
    add_luchtmeetnet_station(layer, "NL1", name="Also Luchtmeetnet")

    body = (await get_layer(client, layer)).json()

    assert names(body) == ["Low", "Mid", "High", "NoPm", "Also Luchtmeetnet", "Only Luchtmeetnet"]
    last = body["stations"]["features"][-1]["properties"]
    assert last["sources"] == ["luchtmeetnet"]
    assert last["readings"]["bcwb"]["source"] == "luchtmeetnet"
    assert body["map_layer"]["property_keys"] == ["bcwb", "no2", "pm25"]


async def test_the_filter_works_on_a_pollutant_only_luchtmeetnet_reports(
    client: AsyncClient, make_layer: Callable[..., Layer]
) -> None:
    layer = make_layer()
    add_luchtmeetnet_station(layer, "NL1")

    body = (
        await get_layer(client, layer, {"property": "bcwb", "value": "0.05", "comparator": ">"})
    ).json()

    assert names(body) == ["Only Luchtmeetnet"]


def test_a_station_reading_needs_at_least_one_source_id(
    make_layer: Callable[..., Layer],
) -> None:
    layer = make_layer()

    with (
        psycopg.connect(TEST_URL, autocommit=True) as conn,
        pytest.raises(psycopg.errors.CheckViolation),
    ):
        conn.execute(
            "INSERT INTO station_readings (id, sync_job_id, name, geom, readings) VALUES "
            "(%s, %s, 'nobody', ST_SetSRID(ST_MakePoint(4.9, 52.37), 4326), '{}'::jsonb)",
            (uuid4(), layer.job_id),
        )


async def test_a_warning_on_a_succeeded_sync_reaches_the_client(
    client: AsyncClient, make_layer: Callable[..., Layer]
) -> None:
    layer = make_layer()
    warning = {"code": "luchtmeetnet_unavailable", "message": "Luchtmeetnet could not be used."}
    with psycopg.connect(TEST_URL, autocommit=True) as conn:
        conn.execute(
            "UPDATE sync_jobs SET warnings = %s::jsonb WHERE id = %s",
            (psycopg.types.json.Jsonb([warning]), layer.job_id),
        )

    response = await client.get(f"/api/v1/syncs/{layer.job_id}", headers=layer.tenant.headers)

    job = response.json()["sync_job"]
    assert (job["status"], job["errors"], job["warnings"]) == ("succeeded", [], [warning])
