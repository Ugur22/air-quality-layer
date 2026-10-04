"""The countries that have a national layer (ADR 0019): every European country in OpenAQ's list,
plus Turkey. The list is shipped data, generated once from OpenAQ's `/countries` and Natural Earth
borders, so a request never asks an upstream for it."""

import json
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

DATA = Path(__file__).with_name("countries.json")
# Luchtmeetnet is the Dutch national network (ADR 0017): only the Netherlands has a second source.
LUCHTMEETNET_COUNTRIES = frozenset({"NL"})
DEFAULT_COUNTRY = "NL"


@dataclass(frozen=True)
class Country:
    code: str
    name: str
    openaq_id: int
    # west, south, east, north of the mainland and islands: a frame for the camera, not a region.
    bbox: list[float]


@lru_cache
def load_countries() -> tuple[Country, ...]:
    rows = json.loads(DATA.read_text(encoding="utf-8"))
    return tuple(Country(r["code"], r["name"], r["openaq_id"], r["bbox"]) for r in rows)


def find_country(code: str) -> Country | None:
    wanted = code.upper()
    return next((c for c in load_countries() if c.code == wanted), None)
