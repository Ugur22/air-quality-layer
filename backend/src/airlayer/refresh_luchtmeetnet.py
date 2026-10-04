"""Rewrites the Luchtmeetnet station snapshot (ADR 0017): `python -m airlayer.refresh_luchtmeetnet`.

Coordinates cost one call per station and the API allows 100 calls per 5 minutes, so this paces
itself and takes a few minutes. It is run by hand, never by a sync."""

import json
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx

BASE_URL = "https://api.luchtmeetnet.nl/open_api"
# 100 calls per 5 minutes, with a little room.
PAUSE_SECONDS = 3.1
OUT = Path(__file__).with_name("luchtmeetnet_stations.json")


def main() -> None:
    with httpx.Client(base_url=BASE_URL, timeout=30) as http:

        def get(path: str, **params: object) -> Any:
            time.sleep(PAUSE_SECONDS)
            response = http.get(path, params={k: str(v) for k, v in params.items()})
            response.raise_for_status()
            return response.json()

        numbers: list[str] = []
        page = 1
        while True:
            body = get("/stations", page=page)
            numbers += [s["number"] for s in body["data"]]
            if page >= body["pagination"]["last_page"]:
                break
            page += 1
        stations = []
        for number in numbers:
            data = get(f"/stations/{number}")["data"]
            lon, lat = data["geometry"]["coordinates"]
            stations.append(
                {
                    "number": number,
                    "name": data["location"],
                    "longitude": lon,
                    "latitude": lat,
                    "components": sorted(data["components"]),
                }
            )
    stations.sort(key=lambda s: str(s["number"]))
    snapshot = {"fetched_at": datetime.now(UTC).isoformat(), "stations": stations}
    OUT.write_text(json.dumps(snapshot, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"Wrote {len(stations)} stations to {OUT}")


if __name__ == "__main__":
    main()
