from collections.abc import Iterator
from typing import Any

import httpx
import pytest
from httpx import AsyncClient

from airlayer.config import Settings, get_settings
from airlayer.main import app
from airlayer.places import PlaceSearch, get_place_search
from tests.test_places import Clock, feature, photon

URL = "/api/v1/places"


def serve(handler: Any, **options: Any) -> PlaceSearch:
    http = httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url="https://photon.test")
    search = PlaceSearch(http, clock=Clock(), **options)
    app.dependency_overrides[get_place_search] = lambda: search
    return search


@pytest.fixture(autouse=True)
def clean_override() -> Iterator[None]:
    yield
    app.dependency_overrides.pop(get_place_search, None)
    app.dependency_overrides.pop(get_settings, None)


async def test_returns_places_in_the_contract_shape(client: AsyncClient) -> None:
    serve(photon(feature()))

    response = await client.get(URL, params={"q": "amsterdam"})

    assert response.status_code == 200
    assert response.json() == {
        "places": [
            {
                "id": "R271110",
                "name": "Amsterdam",
                "detail": "North Holland, Netherlands",
                "kind": "city",
                "point": [4.8979755, 52.3745403],
                "bbox": [4.7288, 52.2782, 5.0792, 52.4311],
            }
        ]
    }


async def test_a_place_that_is_too_large_has_a_null_bbox(client: AsyncClient) -> None:
    serve(photon(feature("Netherlands", extent=[3.3, 53.6, 7.2, 50.7])))

    place = (await client.get(URL, params={"q": "netherlands"})).json()["places"][0]

    assert place["bbox"] is None
    assert place["name"] == "Netherlands"


async def test_no_matches_is_an_empty_list_not_an_error(client: AsyncClient) -> None:
    serve(photon())

    response = await client.get(URL, params={"q": "qqqqqq"})

    assert response.status_code == 200
    assert response.json() == {"places": []}


async def test_trims_the_text_before_searching(client: AsyncClient) -> None:
    seen: list[str] = []

    def handle(request: httpx.Request) -> httpx.Response:
        seen.append(request.url.params["q"])
        return photon()(request)

    serve(handle)

    await client.get(URL, params={"q": "   amsterdam  "})

    assert seen == ["amsterdam"]


@pytest.mark.parametrize(
    "params",
    [
        pytest.param({}, id="missing"),
        pytest.param({"q": ""}, id="empty"),
        pytest.param({"q": "ab"}, id="two-characters"),
        pytest.param({"q": "  ab  "}, id="two-characters-with-spaces"),
        pytest.param({"q": "     "}, id="only-spaces"),
        pytest.param({"q": "x" * 101}, id="too-long"),
    ],
)
async def test_rejects_a_missing_or_badly_sized_query_without_asking_photon(
    client: AsyncClient, params: dict[str, str]
) -> None:
    calls: list[httpx.Request] = []

    def handle(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return photon()(request)

    serve(handle)

    response = await client.get(URL, params=params)

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "validation_failed"
    assert calls == []


async def test_accepts_the_shortest_and_longest_allowed_query(client: AsyncClient) -> None:
    serve(photon())

    assert (await client.get(URL, params={"q": "abc"})).status_code == 200
    assert (await client.get(URL, params={"q": "x" * 100})).status_code == 200


async def test_the_dev_identity_is_required_outside_development(client: AsyncClient) -> None:
    serve(photon())
    prod: Settings = get_settings().model_copy(update={"environment": "production"})
    app.dependency_overrides[get_settings] = lambda: prod

    response = await client.get(URL, params={"q": "amsterdam"})

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "unauthorized"


@pytest.mark.parametrize("status", [500, 503, 429, 404])
async def test_a_provider_failure_is_a_503_that_says_what_to_do_instead(
    client: AsyncClient, status: int
) -> None:
    serve(lambda request: httpx.Response(status, text="internal photon detail"))

    response = await client.get(URL, params={"q": "amsterdam"})

    assert response.status_code == 503
    error = response.json()["error"]
    assert error["code"] == "service_unavailable"
    assert "photon" not in error["message"].lower()
    assert "coordinates" in error["message"].lower()


async def test_a_provider_timeout_is_a_503(client: AsyncClient) -> None:
    def slow(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("slow", request=request)

    serve(slow)

    assert (await client.get(URL, params={"q": "amsterdam"})).status_code == 503


async def test_too_many_searches_is_a_429(client: AsyncClient) -> None:
    serve(photon(), max_upstream=1, window_seconds=10)
    assert (await client.get(URL, params={"q": "first"})).status_code == 200

    response = await client.get(URL, params={"q": "second"})

    assert response.status_code == 429
    assert response.json()["error"]["code"] == "rate_limited"


async def test_a_repeated_search_is_served_from_the_cache_even_over_the_limit(
    client: AsyncClient,
) -> None:
    serve(photon(feature()), max_upstream=1, window_seconds=10)
    await client.get(URL, params={"q": "amsterdam"})

    response = await client.get(URL, params={"q": "Amsterdam"})

    assert response.status_code == 200
    assert len(response.json()["places"]) == 1


async def test_the_endpoint_documents_every_response_it_can_give(client: AsyncClient) -> None:
    schema = (await client.get("/openapi.json")).json()

    codes = set(schema["paths"]["/api/v1/places"]["get"]["responses"])

    assert {"200", "400", "401", "429", "503"} <= codes
