from datetime import UTC, datetime

from airlayer.merge import MATCH_METRES, distance_metres, merge_stations
from airlayer.openaq import Reading, StationSnapshot

T0 = datetime(2026, 10, 4, 6, 0, tzinfo=UTC)
T1 = datetime(2026, 10, 4, 8, 0, tzinfo=UTC)


def oaq(
    location_id: int,
    lon: float = 4.9,
    lat: float = 52.37,
    readings: dict[str, Reading] | None = None,
    name: str | None = None,
) -> StationSnapshot:
    return StationSnapshot(
        location_id=location_id,
        name=name or f"OpenAQ {location_id}",
        longitude=lon,
        latitude=lat,
        readings=readings or {},
    )


def lmn(
    number: str,
    lon: float = 4.9,
    lat: float = 52.37,
    readings: dict[str, Reading] | None = None,
) -> StationSnapshot:
    return StationSnapshot(
        location_id=None,
        name=f"Luchtmeetnet {number}",
        longitude=lon,
        latitude=lat,
        readings=readings or {},
        luchtmeetnet_number=number,
        sources=("luchtmeetnet",),
    )


def reading(value: float, at: datetime, source: str, unit: str = "µg/m³") -> Reading:
    return Reading(value, unit, at, source=source)


def test_distance_is_in_metres() -> None:
    # A hundredth of a degree of latitude is about 1.11 km.
    assert 1100 < distance_metres(4.9, 52.37, 4.9, 52.38) < 1120


def test_stations_at_the_same_spot_become_one_that_lists_both_sources() -> None:
    merged = merge_stations([oaq(1)], [lmn("NL1")])

    assert len(merged) == 1
    assert merged[0].sources == ("openaq", "luchtmeetnet")
    assert merged[0].location_id == 1
    assert merged[0].luchtmeetnet_number == "NL1"


def test_a_merged_station_keeps_the_primary_name_and_point() -> None:
    merged = merge_stations(
        [oaq(1, 4.9, 52.37, name="Amsterdam-Hoogtij")], [lmn("NL1", 4.9001, 52.37)]
    )

    assert merged[0].name == "Amsterdam-Hoogtij"
    assert merged[0].longitude == 4.9


def test_stations_further_apart_than_the_threshold_stay_separate() -> None:
    far = 52.37 + (MATCH_METRES * 3) / 111_320

    merged = merge_stations([oaq(1)], [lmn("NL1", lat=far)])

    assert [s.sources for s in merged] == [("openaq",), ("luchtmeetnet",)]


def test_a_station_only_the_second_source_has_is_added_after_the_first_sources_stations() -> None:
    merged = merge_stations([oaq(1), oaq(2, lon=5.0)], [lmn("NL9", lon=5.5)])

    assert [s.location_id for s in merged] == [1, 2, None]
    assert merged[2].luchtmeetnet_number == "NL9"


def test_the_newer_reading_wins_per_pollutant() -> None:
    merged = merge_stations(
        [
            oaq(
                1,
                readings={
                    "pm25": reading(9.0, T0, "openaq"),
                    "no2": reading(20.0, T1, "openaq"),
                },
            )
        ],
        [
            lmn(
                "NL1",
                readings={
                    "pm25": reading(4.0, T1, "luchtmeetnet"),
                    "no2": reading(25.0, T0, "luchtmeetnet"),
                },
            )
        ],
    )

    readings = merged[0].readings
    assert (readings["pm25"].value, readings["pm25"].source) == (4.0, "luchtmeetnet")
    assert (readings["no2"].value, readings["no2"].source) == (20.0, "openaq")


def test_the_second_source_wins_a_tie() -> None:
    merged = merge_stations(
        [oaq(1, readings={"pm25": reading(9.0, T1, "openaq")})],
        [lmn("NL1", readings={"pm25": reading(4.0, T1, "luchtmeetnet")})],
    )

    assert merged[0].readings["pm25"].source == "luchtmeetnet"


def test_pollutants_only_the_second_source_has_are_added() -> None:
    merged = merge_stations(
        [oaq(1, readings={"pm25": reading(9.0, T0, "openaq")})],
        [lmn("NL1", readings={"bcwb": reading(0.09, T1, "luchtmeetnet")})],
    )

    assert set(merged[0].readings) == {"pm25", "bcwb"}


def test_a_reading_in_a_different_unit_is_not_swapped_in() -> None:
    merged = merge_stations(
        [oaq(1, readings={"co": reading(0.3, T0, "openaq", unit="ppm")})],
        [lmn("NL1", readings={"co": reading(315.0, T1, "luchtmeetnet")})],
    )

    assert (merged[0].readings["co"].value, merged[0].readings["co"].unit) == (0.3, "ppm")


def test_the_greek_mu_and_the_micro_sign_are_the_same_unit() -> None:
    merged = merge_stations(
        [oaq(1, readings={"pm25": reading(9.0, T0, "openaq", unit="μg/m³")})],
        [lmn("NL1", readings={"pm25": reading(4.0, T1, "luchtmeetnet")})],
    )

    assert merged[0].readings["pm25"].value == 4.0


def test_one_second_source_station_is_folded_into_only_the_nearest_first_source_station() -> None:
    # Two OpenAQ stations next to each other, one Luchtmeetnet station: the nearer one gets it.
    merged = merge_stations([oaq(1, lon=4.9), oaq(2, lon=4.90005)], [lmn("NL1", lon=4.90004)])

    assert [s.sources for s in merged] == [("openaq",), ("openaq", "luchtmeetnet")]


def test_no_second_source_leaves_the_first_untouched() -> None:
    first = [oaq(1), oaq(2, lon=5.0)]

    assert merge_stations(first, []) == first


def north_of(lat: float, metres: float) -> float:
    return lat + metres / 111_320


def test_the_threshold_sits_between_49_and_51_metres() -> None:
    near = merge_stations([oaq(1)], [lmn("NL1", lat=north_of(52.37, 49))])
    far = merge_stations([oaq(1)], [lmn("NL1", lat=north_of(52.37, 51))])

    assert len(near) == 1
    assert len(far) == 2


def test_a_first_source_station_takes_at_most_one_second_source_station() -> None:
    merged = merge_stations([oaq(1)], [lmn("NL1", lon=4.90002), lmn("NL2", lon=4.90004)])

    assert [s.luchtmeetnet_number for s in merged] == ["NL1", "NL2"]
    assert [s.sources for s in merged] == [("openaq", "luchtmeetnet"), ("luchtmeetnet",)]
