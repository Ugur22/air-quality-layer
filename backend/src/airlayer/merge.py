"""Merging the stations of two sources into one list (ADR 0017). Pure: no I/O, so it is tested
with plain data."""

import math
from dataclasses import replace

from airlayer.openaq import Reading, StationSnapshot

# Two stations this close are the same site. Names differ between sources, so distance decides.
# An Assumption from one city (ADR 0017); every true match there was under 20 m.
MATCH_METRES = 50.0
_EARTH_RADIUS_METRES = 6_371_000.0


def distance_metres(lon_a: float, lat_a: float, lon_b: float, lat_b: float) -> float:
    phi_a, phi_b = math.radians(lat_a), math.radians(lat_b)
    half = (
        math.sin((phi_b - phi_a) / 2) ** 2
        + math.cos(phi_a) * math.cos(phi_b) * math.sin(math.radians(lon_b - lon_a) / 2) ** 2
    )
    return 2 * _EARTH_RADIUS_METRES * math.asin(math.sqrt(half))


def _same_unit(a: str, b: str) -> bool:
    # OpenAQ spells micro with either the micro sign or the Greek mu.
    return a.replace("μ", "µ") == b.replace("μ", "µ")


def _merge_readings(
    primary: dict[str, Reading], secondary: dict[str, Reading]
) -> dict[str, Reading]:
    merged = dict(primary)
    for name, candidate in secondary.items():
        current = merged.get(name)
        if current is None:
            merged[name] = candidate
        elif _same_unit(current.unit, candidate.unit) and (
            # The secondary source wins a tie: it is the reference network.
            candidate.observed_at >= current.observed_at
        ):
            merged[name] = candidate
    return merged


def merge_stations(
    primary: list[StationSnapshot], secondary: list[StationSnapshot]
) -> list[StationSnapshot]:
    """The primary source's stations, with any secondary station within `MATCH_METRES` folded into
    it (one secondary station per primary one, nearest pairs first), then the secondary stations
    that matched nothing."""
    pairs = sorted(
        (
            (distance_metres(p.longitude, p.latitude, s.longitude, s.latitude), i, j)
            for i, p in enumerate(primary)
            for j, s in enumerate(secondary)
        ),
    )
    match: dict[int, int] = {}
    taken: set[int] = set()
    for distance, i, j in pairs:
        if distance > MATCH_METRES:
            break
        if i not in match and j not in taken:
            match[i] = j
            taken.add(j)
    merged = []
    for i, station in enumerate(primary):
        matched = match.get(i)
        if matched is None:
            merged.append(station)
            continue
        other = secondary[matched]
        merged.append(
            replace(
                station,
                readings=_merge_readings(station.readings, other.readings),
                luchtmeetnet_number=other.luchtmeetnet_number,
                sources=tuple(dict.fromkeys((*station.sources, *other.sources))),
            )
        )
    merged.extend(s for j, s in enumerate(secondary) if j not in taken)
    return merged
