import asyncio
import random
from collections.abc import Callable
from typing import Any

import httpx
import pytest
from pydantic import ValidationError

from airlayer.places import (
    PlaceSearch,
    ProviderUnavailable,
    RateLimited,
    fit_bbox,
    make_places_http_client,
)
from airlayer.schemas import RegionCreate

Handler = Callable[[httpx.Request], httpx.Response]


def feature(
    name: Any = "Amsterdam",
    *,
    lon: float = 4.8979755,
    lat: float = 52.3745403,
    extent: list[float] | None = None,
    osm_type: str = "R",
    osm_id: Any = 271110,
    **props: Any,
) -> dict[str, Any]:
    properties: dict[str, Any] = {
        "osm_type": osm_type,
        "osm_id": osm_id,
        "name": name,
        "type": "city",
        "country": "Netherlands",
        "state": "North Holland",
        # Photon order: [west, north, east, south]
        "extent": [4.7288, 52.4311, 5.0792, 52.2782] if extent is None else extent,
    } | props
    return {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [lon, lat]},
        "properties": properties,
    }


def photon(*features: dict[str, Any]) -> Handler:
    def handle(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"type": "FeatureCollection", "features": list(features)})

    return handle


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


def search_for(handler: Handler, clock: Clock | None = None, **options: Any) -> PlaceSearch:
    http = httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url="https://photon.test")
    return PlaceSearch(http, clock=clock or Clock(), **options)


class TestFitBbox:
    def test_keeps_a_city_sized_extent_as_it_is(self) -> None:
        assert fit_bbox(
            (4.8979755, 52.3745403), [4.7287776, 52.4310638, 5.0791622, 52.2781742]
        ) == (
            4.7288,
            52.2782,
            5.0792,
            52.4311,
        )

    def test_widens_a_small_place_around_its_centre(self) -> None:
        # Vondelpark: about 0.027 by 0.009 degrees
        box = fit_bbox((4.868, 52.357), [4.8550184, 52.3618299, 4.8821453, 52.3525805])

        assert box is not None
        west, south, east, north = box
        assert round(east - west, 4) == 0.1
        assert round(north - south, 4) == 0.1
        assert round((west + east) / 2, 3) == round((4.8550184 + 4.8821453) / 2, 3)

    def test_gives_a_place_with_only_a_point_a_box_of_0_1_degrees(self) -> None:
        assert fit_bbox((4.9, 52.37), None) == (4.85, 52.32, 4.95, 52.42)

    def test_widens_only_the_side_that_is_too_small(self) -> None:
        box = fit_bbox((4.9, 52.37), [4.5, 52.40, 5.5, 52.37])

        assert box is not None
        assert (box[0], box[2]) == (4.5, 5.5)
        assert round(box[3] - box[1], 4) == 0.1

    @pytest.mark.parametrize(
        "extent",
        [
            [1.0, 52.0, 5.0, 51.0],  # 4 degrees wide
            [4.0, 55.0, 4.5, 52.0],  # 3 degrees high
            [-10.0, 60.0, 5.0, 40.0],  # a country
        ],
    )
    def test_is_none_for_a_place_larger_than_two_degrees(self, extent: list[float]) -> None:
        assert fit_bbox((4.0, 52.0), extent) is None

    def test_accepts_exactly_two_degrees(self) -> None:
        assert fit_bbox((4.0, 52.0), [3.0, 53.0, 5.0, 51.0]) == (3.0, 51.0, 5.0, 53.0)

    @pytest.mark.parametrize(
        "extent",
        [
            [5.0, 52.4, 4.0, 52.3],  # west east of east (crosses the date line)
            [4.0, 52.3, 5.0, 52.4],  # north south of south
            [4.0, 52.4, 5.0],  # three numbers
        ],
    )
    def test_is_none_for_an_extent_that_makes_no_box(self, extent: list[float]) -> None:
        assert fit_bbox((4.5, 52.35), extent) is None

    def test_is_none_for_an_extent_with_non_finite_numbers(self) -> None:
        assert fit_bbox((4.5, 52.35), [float("nan"), 52.4, 5.0, 52.3]) is None

    def test_shifts_a_box_that_would_leave_the_world_back_inside(self) -> None:
        west, south, east, north = fit_bbox((179.99, 89.99), None) or (0, 0, 0, 0)

        assert (west, east) == (179.9, 180.0)
        assert (south, north) == (89.9, 90.0)

    def test_rounds_to_four_decimals(self) -> None:
        box = fit_bbox((4.9, 52.37), [4.123456789, 52.5, 4.923456789, 52.3])

        assert box == (4.1235, 52.3, 4.9235, 52.5)

    @pytest.mark.parametrize(
        "extent",
        [
            [1e17, 1.0, 1e17, 0.0],  # nonsense longitudes
            [-200.0, 1.0, 5.0, 0.0],
            [4.0, 95.0, 5.0, 94.0],  # latitudes outside the world
            [4.0, 1.0, 1e300, 0.0],
        ],
    )
    def test_is_none_for_an_extent_outside_the_world(self, extent: list[float]) -> None:
        assert fit_bbox((4.5, 0.5), extent) is None

    @pytest.mark.parametrize(
        "extent",
        [
            [
                143.7473,
                1.0,
                145.7473,
                0.5,
            ],  # exactly 2 degrees, but 145.7473 - 143.7473 is 2.0000000000000284
            [10.0, 1.0, 12.0001, 0.0],
            [3.0, 53.0, 5.00004, 51.0],
        ],
    )
    def test_a_box_near_two_degrees_is_either_usable_as_a_region_or_none(
        self, extent: list[float]
    ) -> None:
        box = fit_bbox((extent[0] + 0.5, 0.5), extent)

        if box is not None:
            RegionCreate(name="x", bbox=list(box))

    def test_every_fitted_box_passes_the_region_validation(self) -> None:
        # The promise of the contract: a non-null bbox can always be used as a region. Checked on
        # many random places, most of them close to the 0.1 and 2 degree limits where float
        # rounding bites, with the 7 decimals Photon sends.
        rng = random.Random(20261003)  # noqa: S311 - fixed seed, test data only
        for _ in range(20_000):
            west = round(rng.uniform(-179.9, 178.0), 7)
            south = round(rng.uniform(-89.9, 88.0), 7)
            width = rng.choice(
                [0.0, 0.05, 0.0999, 0.1, 1.9999, 2.0, 2.00004, 2.0001, rng.uniform(0, 2.2)]
            )
            height = rng.choice(
                [0.0, 0.05, 0.0999, 0.1, 1.9999, 2.0, 2.00004, 2.0001, rng.uniform(0, 2.2)]
            )
            extent = [west, round(south + height, 7), round(west + width, 7), south]
            box = fit_bbox((west, south), extent)
            if box is None:
                continue
            try:
                RegionCreate(name="x", bbox=list(box))
            except ValidationError as exc:  # pragma: no cover - failure message only
                pytest.fail(f"{extent} -> {box} is not a valid region: {exc}")
            assert box[2] - box[0] >= 0.1 - 1e-9
            assert box[3] - box[1] >= 0.1 - 1e-9


def test_the_region_rule_tolerates_float_noise_in_an_exactly_two_degree_box() -> None:
    RegionCreate(name="x", bbox=[143.7473, 0.0, 145.7473, 1.0])
    RegionCreate(name="x", bbox=[4.0, 50.0, 5.0, 52.0])


def test_the_region_rule_still_rejects_a_box_really_over_two_degrees() -> None:
    with pytest.raises(ValidationError):
        RegionCreate(name="x", bbox=[143.7473, 0.0, 145.7475, 1.0])


class TestSearch:
    async def test_returns_places_in_the_documented_shape(self) -> None:
        search = search_for(photon(feature()))

        (place,) = await search.search("amsterdam")

        assert place.id == "R271110"
        assert place.name == "Amsterdam"
        assert place.detail == "North Holland, Netherlands"
        assert place.kind == "city"
        assert place.point == (4.8979755, 52.3745403)
        assert place.bbox == (4.7288, 52.2782, 5.0792, 52.4311)

    async def test_asks_photon_for_the_text_and_nothing_else_of_the_users(self) -> None:
        seen: list[httpx.Request] = []

        def handle(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            return photon()(request)

        await search_for(handle).search("Zürich & co=1&limit=999")

        (request,) = seen
        assert request.url.path == "/api/"
        assert set(request.url.params.keys()) == {"q", "limit"}
        assert request.url.params["q"] == "Zürich & co=1&limit=999"
        assert request.url.params["limit"] == "10"

    async def test_builds_the_detail_line_without_repeats_or_the_name_itself(self) -> None:
        f = feature(
            "Noord-Holland", city="Noord-Holland", state="Noord-Holland", country="Netherlands"
        )
        g = feature(
            "Vondelpark", osm_id=2, city="Amsterdam", county="Amsterdam", state="North Holland"
        )

        first, second = await search_for(photon(f, g)).search("x" * 3)

        assert first.detail == "Netherlands"
        assert second.detail == "Amsterdam, North Holland, Netherlands"

    async def test_detail_is_empty_when_nothing_is_known(self) -> None:
        f = feature(country=None, state=None)
        del f["properties"]["country"], f["properties"]["state"]

        (place,) = await search_for(photon(f)).search("abc")

        assert place.detail == ""

    async def test_collapses_results_with_the_same_name_and_detail(self) -> None:
        city = feature(osm_id=1)
        boundary = feature(osm_id=2, type="boundary")
        other = feature(osm_id=3, country="United States", state="New York")

        places = await search_for(photon(city, boundary, other)).search("amsterdam")

        assert [p.id for p in places] == ["R1", "R3"]

    async def test_returns_at_most_five_places(self) -> None:
        many = [feature(f"Place {i}", osm_id=i) for i in range(10)]

        places = await search_for(photon(*many)).search("place")

        assert len(places) == 5
        assert places[0].name == "Place 0"

    async def test_marks_a_too_large_place_with_no_box_but_keeps_it(self) -> None:
        country = feature("Netherlands", extent=[3.3, 53.6, 7.2, 50.7], osm_id=9)

        (place,) = await search_for(photon(country)).search("netherlands")

        assert place.bbox is None
        assert place.name == "Netherlands"

    async def test_gives_a_place_without_an_extent_a_box_around_its_point(self) -> None:
        f = feature("Some Cafe", lon=4.9, lat=52.37, osm_id=5)
        del f["properties"]["extent"]

        (place,) = await search_for(photon(f)).search("some cafe")

        assert place.bbox == (4.85, 52.32, 4.95, 52.42)

    @pytest.mark.parametrize(
        "broken",
        [
            pytest.param({"type": "Feature"}, id="no-geometry-or-properties"),
            pytest.param(feature(lon=181.0), id="longitude-out-of-range"),
            pytest.param(feature(lat=-91.0), id="latitude-out-of-range"),
            pytest.param(feature(name=""), id="empty-name"),
            pytest.param(feature(osm_type="X"), id="unknown-osm-type"),
            pytest.param(feature(osm_id="12"), id="string-osm-id"),
            pytest.param(feature(name=7), id="numeric-name"),
        ],
    )
    async def test_drops_a_result_in_an_unexpected_shape_and_keeps_the_rest(
        self, broken: dict[str, Any]
    ) -> None:
        good = feature("Good", osm_id=77)

        places = await search_for(photon(broken, good)).search("abc")

        assert [p.name for p in places] == ["Good"]

    async def test_caps_a_very_long_name(self) -> None:
        (place,) = await search_for(photon(feature("N" * 500))).search("abc")

        assert len(place.name) == 200

    async def test_an_answer_with_no_places_is_an_empty_list(self) -> None:
        assert await search_for(photon()).search("nowhere") == []

    @pytest.mark.parametrize(
        "make",
        [
            pytest.param(lambda: httpx.Response(200, text="<html>nope"), id="not-json"),
            pytest.param(lambda: httpx.Response(200, json=["a"]), id="not-an-object"),
            pytest.param(lambda: httpx.Response(200, json={}), id="no-features"),
            pytest.param(
                lambda: httpx.Response(200, json={"features": "x"}), id="features-not-a-list"
            ),
            pytest.param(lambda: httpx.Response(500, json={}), id="server-error"),
            pytest.param(lambda: httpx.Response(503, text="busy"), id="unavailable"),
            pytest.param(lambda: httpx.Response(429, json={}), id="throttled"),
            pytest.param(lambda: httpx.Response(404, json={}), id="not-found"),
            pytest.param(lambda: httpx.Response(400, json={}), id="bad-request"),
        ],
    )
    async def test_an_unusable_answer_is_a_provider_failure(
        self, make: Callable[[], httpx.Response]
    ) -> None:
        with pytest.raises(ProviderUnavailable):
            await search_for(lambda request: make()).search("abc")

    async def test_timeouts_and_connection_failures_are_provider_failures(self) -> None:
        def timeout(request: httpx.Request) -> httpx.Response:
            raise httpx.ReadTimeout("slow", request=request)

        def refused(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("down", request=request)

        for handler in (timeout, refused):
            with pytest.raises(ProviderUnavailable):
                await search_for(handler).search("abc")

    async def test_a_failure_message_does_not_carry_provider_details(self) -> None:
        leaky_url = "https://photon.test/api/?q=abc&token=hunter2"

        def boom(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError(leaky_url, request=request)

        with pytest.raises(ProviderUnavailable) as caught:
            await search_for(boom).search("abc")

        assert "hunter2" not in str(caught.value)
        assert "photon.test" not in str(caught.value)

    async def test_kind_falls_back_to_the_osm_value_and_then_to_place(self) -> None:
        a = feature("A", osm_id=1)
        del a["properties"]["type"]
        a["properties"]["osm_value"] = "park"
        b = feature("B", osm_id=2)
        del b["properties"]["type"]

        first, second = await search_for(photon(a, b)).search("abc")

        assert (first.kind, second.kind) == ("park", "place")

    async def test_caps_the_length_of_every_text_it_hands_on(self) -> None:
        f = feature("N", osm_id=1, type="k" * 500, city="c" * 1000)

        (place,) = await search_for(photon(f)).search("abc")

        assert len(place.kind) <= 50
        assert len(place.detail) <= 300

    async def test_drops_a_result_whose_extent_is_not_four_numbers(self) -> None:
        bad = feature("Bad", osm_id=1, extent=[1.0, 2.0])
        good = feature("Good", osm_id=2)

        places = await search_for(photon(bad, good)).search("abc")

        assert [p.name for p in places] == ["Bad", "Good"] or [p.name for p in places] == ["Good"]

    async def test_two_people_asking_at_once_cost_one_request(self) -> None:
        calls = 0
        release = asyncio.Event()

        async def slow(request: httpx.Request) -> httpx.Response:
            nonlocal calls
            calls += 1
            await release.wait()
            return photon(feature())(request)

        http = httpx.AsyncClient(
            transport=httpx.MockTransport(slow), base_url="https://photon.test"
        )
        search = PlaceSearch(http, clock=Clock(), max_upstream=1000)

        first = asyncio.create_task(search.search("amsterdam"))
        second = asyncio.create_task(search.search("Amsterdam"))
        await asyncio.sleep(0.01)
        release.set()

        a, b = await asyncio.gather(first, second)
        assert calls == 1
        assert [p.id for p in a] == [p.id for p in b] == ["R271110"]

    async def test_a_failure_reaches_everyone_who_was_waiting_for_the_same_answer(self) -> None:
        release = asyncio.Event()

        async def failing(request: httpx.Request) -> httpx.Response:
            await release.wait()
            return httpx.Response(503, text="busy")

        http = httpx.AsyncClient(
            transport=httpx.MockTransport(failing), base_url="https://photon.test"
        )
        search = PlaceSearch(http, clock=Clock(), max_upstream=1000)

        first = asyncio.create_task(search.search("amsterdam"))
        second = asyncio.create_task(search.search("amsterdam"))
        await asyncio.sleep(0.01)
        release.set()

        results = await asyncio.gather(first, second, return_exceptions=True)
        assert all(isinstance(r, ProviderUnavailable) for r in results)


class TestCooldown:
    async def test_after_a_failure_photon_is_left_alone_for_a_while(self) -> None:
        clock = Clock()
        calls = 0

        def handle(request: httpx.Request) -> httpx.Response:
            nonlocal calls
            calls += 1
            return httpx.Response(503, text="busy")

        search = search_for(handle, clock, max_upstream=1000, cooldown_seconds=30)

        with pytest.raises(ProviderUnavailable):
            await search.search("amsterdam")
        for query in ("rotterdam", "utrecht"):
            with pytest.raises(ProviderUnavailable):
                await search.search(query)

        assert calls == 1

    async def test_photon_is_asked_again_once_the_cooldown_is_over(self) -> None:
        clock = Clock()
        answers: list[Handler] = [lambda r: httpx.Response(503, text="busy"), photon(feature())]
        calls = 0

        def handle(request: httpx.Request) -> httpx.Response:
            nonlocal calls
            calls += 1
            return answers[min(calls - 1, 1)](request)

        search = search_for(handle, clock, max_upstream=1000, cooldown_seconds=30)
        with pytest.raises(ProviderUnavailable):
            await search.search("amsterdam")

        clock.now += 31

        assert len(await search.search("amsterdam")) == 1

    async def test_answers_already_cached_are_still_served_during_the_cooldown(self) -> None:
        clock = Clock()
        ok = True

        def handle(request: httpx.Request) -> httpx.Response:
            return photon(feature())(request) if ok else httpx.Response(503, text="busy")

        search = search_for(handle, clock, max_upstream=1000, cooldown_seconds=30)
        await search.search("amsterdam")
        ok = False
        with pytest.raises(ProviderUnavailable):
            await search.search("rotterdam")

        assert len(await search.search("amsterdam")) == 1

    async def test_a_cooldown_refusal_does_not_use_up_the_rate_limit(self) -> None:
        clock = Clock()
        search = search_for(
            lambda r: httpx.Response(503), clock, max_upstream=2, cooldown_seconds=30
        )
        with pytest.raises(ProviderUnavailable):
            await search.search("one")

        for query in ("two", "three", "four"):
            with pytest.raises(ProviderUnavailable):  # not RateLimited
                await search.search(query)


class TestCache:
    async def test_the_same_query_is_asked_once_whatever_its_case_and_spacing(self) -> None:
        calls: list[httpx.Request] = []

        def handle(request: httpx.Request) -> httpx.Response:
            calls.append(request)
            return photon(feature())(request)

        search = search_for(handle)

        await search.search("Amsterdam")
        await search.search("  amsterdam ")
        await search.search("AMSTERDAM")

        assert len(calls) == 1

    async def test_different_queries_are_asked_separately(self) -> None:
        calls: list[httpx.Request] = []

        def handle(request: httpx.Request) -> httpx.Response:
            calls.append(request)
            return photon()(request)

        search = search_for(handle)

        await search.search("amsterdam")
        await search.search("rotterdam")

        assert len(calls) == 2

    async def test_repeated_inner_spaces_count_as_one(self) -> None:
        calls: list[httpx.Request] = []

        def handle(request: httpx.Request) -> httpx.Response:
            calls.append(request)
            return photon()(request)

        search = search_for(handle)

        await search.search("new york")
        await search.search("new   york")

        assert len(calls) == 1

    async def test_an_answer_with_no_places_is_cached_too(self) -> None:
        calls: list[httpx.Request] = []

        def handle(request: httpx.Request) -> httpx.Response:
            calls.append(request)
            return photon()(request)

        search = search_for(handle)

        await search.search("nowhere")
        await search.search("nowhere")

        assert len(calls) == 1

    async def test_an_answer_expires_after_the_ttl(self) -> None:
        clock = Clock()
        calls: list[httpx.Request] = []

        def handle(request: httpx.Request) -> httpx.Response:
            calls.append(request)
            return photon()(request)

        search = search_for(handle, clock, ttl_seconds=600)
        await search.search("amsterdam")

        clock.now += 599
        await search.search("amsterdam")
        assert len(calls) == 1
        clock.now += 2
        await search.search("amsterdam")
        assert len(calls) == 2

    async def test_a_failure_is_not_cached(self) -> None:
        clock = Clock()
        answers: list[Handler] = [lambda r: httpx.Response(503, text="busy"), photon(feature())]
        calls = 0

        def handle(request: httpx.Request) -> httpx.Response:
            nonlocal calls
            calls += 1
            return answers[calls - 1](request)

        search = search_for(handle, clock)

        with pytest.raises(ProviderUnavailable):
            await search.search("amsterdam")
        clock.now += (
            31  # past the cooldown, so Photon is asked again instead of the failure replayed
        )
        places = await search.search("amsterdam")

        assert calls == 2
        assert len(places) == 1

    async def test_the_cache_does_not_grow_without_limit_and_forgets_the_oldest_first(self) -> None:
        calls: list[str] = []

        def handle(request: httpx.Request) -> httpx.Response:
            calls.append(request.url.params["q"])
            return photon()(request)

        search = search_for(handle, max_entries=3, max_upstream=1000)

        for i in range(5):
            await search.search(f"place {i}")
        assert search.cached_queries == 3
        calls.clear()

        await search.search("place 4")  # newest: still cached
        await search.search("place 0")  # oldest: was forgotten

        assert calls == ["place 0"]


class TestRateLimit:
    async def test_refuses_upstream_calls_beyond_the_limit_inside_the_window(self) -> None:
        search = search_for(photon(), max_upstream=3, window_seconds=10)

        for i in range(3):
            await search.search(f"place {i}")
        with pytest.raises(RateLimited):
            await search.search("one more")

    async def test_cached_answers_do_not_count_against_the_limit(self) -> None:
        search = search_for(photon(), max_upstream=1, window_seconds=10)
        await search.search("amsterdam")

        for _ in range(5):
            await search.search("amsterdam")

    async def test_allows_calls_again_once_the_window_has_passed(self) -> None:
        clock = Clock()
        search = search_for(photon(), clock, max_upstream=1, window_seconds=10)
        await search.search("one")
        with pytest.raises(RateLimited):
            await search.search("two")

        clock.now += 10.5

        assert await search.search("two") == []

    async def test_a_refused_call_does_not_use_up_the_allowance(self) -> None:
        clock = Clock()
        search = search_for(photon(), clock, max_upstream=1, window_seconds=10)
        await search.search("one")  # at t=0
        clock.now += 8
        for _ in range(3):
            with pytest.raises(RateLimited):
                await search.search("two")  # refused at t=8

        clock.now += (
            2.5  # t=10.5: the first call has left the window, the refused ones never counted
        )

        assert await search.search("two") == []


async def test_the_http_client_identifies_the_app_and_has_a_timeout() -> None:
    http = make_places_http_client(
        base_url="https://photon.test", timeout=4.0, user_agent="AirLayer-test/1.0 (dev)"
    )

    assert http.headers["user-agent"] == "AirLayer-test/1.0 (dev)"
    assert http.timeout.read == 4.0
    await http.aclose()
