# 0013. Place search for defining a region

- Status: accepted
- Date: 2026-10-03

## Context
Defining a region means typing four coordinates or drawing a rectangle (ADR 0011). The user wants to search by place name instead. This adds a third-party geocoding service and sends what users type to it, so it needs a decision. This is also new scope: `product.md` defines the first slice's region as a typed bounding box.

Facts checked on 2026-10-03:

- **Nominatim** (the public OpenStreetMap geocoder): maximum 1 request per second; search-as-you-type is explicitly forbidden; requests must identify the app (User-Agent, Referer); results must be cached; user-triggered use from a web app is acceptable at moderate volume; ODbL attribution is required.
- **Photon** (`photon.komoot.io`): built for search-as-you-type, no API key, "extensive usage will be throttled" with no stated number; GeoJSON results with OpenStreetMap data (attribution to OpenStreetMap and komoot).
- A live request to each returned `Access-Control-Allow-Origin: *`, so a browser may call either directly.
- Areas come with a bounding box: Photon's `extent` is `[west, north, east, south]`; Nominatim's `boundingbox` is `[south, north, west, east]`. Photon's "Amsterdam" extent is 4.7288 to 5.0792 east, 52.2782 to 52.4311 north (about 0.35 by 0.15 degrees). Streets and parks have small extents; a country is far over the 2-degree region limit (`schemas.py`).
- `architecture.md`: the frontend talks only to the API, and the OpenAPI contract is the only coupling.
- The OpenAQ response is treated as untrusted input and validated on the server (ADR 0002); a geocoder response is the same kind of input.

## Decision
Add a backend endpoint that searches places through **Photon**, and use it from a search box above the region form.

1. **Endpoint** (shape settled in `api-contracts.md` through `api-contract-review` before code): `GET /api/v1/places?q=<text>` returns up to 5 places, each with a name, a short detail line (for example "Noord-Holland, Netherlands"), a kind, its point, and a `bbox` already fitted to the region rules. A place larger than 2 degrees per side gets `bbox: null` (the UI shows it as too large); a place with only a point gets a box of 0.1 degrees around it (about 7 by 11 km at this latitude).
2. **Server side:** the Photon response is validated strictly like OpenAQ's; query length 3 to 100 characters; an identifying User-Agent; a small in-memory cache; a provider failure is `503 service_unavailable`. Tests mock the HTTP boundary.
3. **UI:** a combobox ("Search a place") that fills the name and the four coordinate fields (rounded to 4 decimals) and moves the camera. The form stays the single source of truth; typing and drawing remain. Results show "Search by Photon, © OpenStreetMap contributors".
4. **Combobox component:** the shadcn `Command` (cmdk) combobox, consistent with ADR 0004. Hand-rolling an accessible combobox is the alternative if the dependency is not wanted.

## Alternatives considered
- **Browser calls Photon directly** — least code, but every keystroke sends the user's IP and query to a third party, ties the frontend to one provider, and breaks the "frontend only talks to the API" rule.
- **Nominatim** — the most standard OSM geocoder, but typeahead is forbidden, so only press-Enter search would be allowed. Kept as the self-hostable fallback.
- **The `@maplibre/maplibre-gl-geocoder` control** — a ready-made map control (it also works with Nominatim). Its own UI would sit beside our form instead of filling it, and MapLibre 6 compatibility is unverified.
- **Mapbox, MapTiler or Geoapify geocoding** — good quality, but need an account and a key, and usage-based terms.

## Consequences
- New backend endpoint, contract section, tests and one cache; roughly the size of the OpenAQ client's boundary work, but smaller.
- The public Photon instance has no stated limit and may throttle. That is acceptable for a portfolio project; before the project is shown widely, self-host Photon or switch provider (a server-side change only).
- The provider sees queries from our server's address, not from each user's browser.
- A new dependency (`cmdk`) if the shadcn combobox is used. Its size is unmeasured.
- Place search quality is whatever OpenStreetMap has for the name; ambiguous names ("Amsterdam" also matches a US city) show a detail line so the user can choose.
- Real-browser behaviour (keyboard navigation, focus, the map moving) is verified by Playwright or by hand, not by jsdom.
