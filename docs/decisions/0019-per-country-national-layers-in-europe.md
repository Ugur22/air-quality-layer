# 0019. Per-country national layers for Europe and Turkey

- Status: proposed
- Date: 2026-10-04

## Context
ADR 0018 gives the Netherlands one national layer, refreshed hourly. The country is hardcoded (`NATIONAL_BBOX`, `national_openaq_country_id = 94`) and the map has a single "Netherlands" switch. The wish is to pick any European country, and Turkey, and to see the country's real border (the Netherlands border is already drawn, bundled Natural Earth data).

Measured against OpenAQ on 2026-10-04:
- Locations per country (`/locations?countries_id=…&limit=1000`): Turkey (id 66) 406, Germany 765, Spain 974, Italy 909, United Kingdom 696, Poland 432, Netherlands 273, France more than 1000. Turkey's data was last updated today, though some of its locations stopped reporting years ago (one in 2016).
- ADR 0018's method costs one call per station at 1.2 s: all of Europe is probably about 10,000 stations, so over three hours per refresh. It cannot run hourly.
- `/parameters/{id}/latest` answers 1000 values per page and **ignores `countries_id`**: world-wide pm25 is 21,213 values, 22 pages. Each value carries `sensorsId`, `locationsId`, coordinates and a timestamp. `/locations` lists each location's sensors with their parameter, so a value can be assigned to a location and a country.
- Luchtmeetnet covers only the Netherlands.

## Decision
1. **A country is a configuration entry**, not code: ISO code, name, OpenAQ `countries_id`, bbox, boundary file, and whether Luchtmeetnet also contributes (Netherlands only). Turkey is an entry like any other. The countries are every European country in OpenAQ's country list plus Turkey, decided by the maintainer on 2026-10-04: Europe is Natural Earth's continent field, Russia is left out (mostly Asia, and its box crosses the antimeridian, an open item in the contract), and Cyprus is added (an EU member Natural Earth files under Asia). Gibraltar has no border file (too small to draw) and is left out. That gives 44 countries.
2. **One hourly refresh run builds every configured country.** It pages `/locations` per country, pages each parameter's world-wide `/latest` once, and assigns values to locations by `sensorsId`. Values for other countries are discarded. Cost is a few hundred calls for all countries at once instead of one per station. The Netherlands uses the same path and keeps its Luchtmeetnet merge (ADR 0017); the maintainer approved moving it onto the bulk path.
3. **Storage:** `national_refreshes` gets a `country_code`; a refresh row, and the layer served, is per country. The newest succeeded refresh per country is served (ADR 0018 item 4). A country that fails keeps its previous layer.
4. **API:** `GET /api/v1/countries` lists the available countries (code, name, bbox, `refreshed_at` or null). `GET /api/v1/national-layer` takes `country` (ISO code), defaulting to `NL` so the current client keeps working. Unknown code is `400 validation_failed`; a configured country with no succeeded refresh is `404 not_found`.
5. **Frontend:** a country picker replaces the "Netherlands" switch. Each country's border is a separate bundled file, loaded when the country is chosen, so the first load does not grow with the number of countries. The camera fits the country's bbox. Regions and their rectangles are unchanged.
6. **Per-country station cap** replaces the single `max_stations_national`, with a starting value above the largest country (France exceeds 1000).
7. **Retention is no longer deferrable** (ADR 0018 item 6 was Open): Europe is about 10,000 stations and roughly 60,000 readings an hour, or 1.4 million a day, against about 400 an hour for the Netherlands alone. Decided by the maintainer on 2026-10-04: keep the newest 3 succeeded refreshes per country; older refreshes and their readings are deleted by the refresh task after a country succeeds. A failed refresh newer than the oldest kept one stays, so a recent failure is still visible.

## Alternatives considered
- **Keep one call per station for every country** — about three hours per refresh for Europe; Turkey alone is 406 calls, about 8 minutes, and the cost multiplies with every country added.
- **Refresh a country only when someone opens it** — blocks the user for minutes, and contradicts ADR 0018's rule that opening a view fetches nothing.
- **Only the countries a user has asked for** — needs a demand signal that does not exist; the bulk method makes all of them cheap.
- **A boundary service at runtime** — a new dependency and rate limit for a file that never changes.

## Consequences
- New migration: `country_code` on `national_refreshes` (existing rows are `NL`), and an index for "newest succeeded per country".
- New OpenAQ client code for bulk latest values; response validation as for every OpenAQ answer (shape, units, coordinates), and values of sensors that are not ours are ignored, so a malformed value elsewhere in the world cannot fail a European layer. Only the sensors we store are validated, strictly.
- World-wide pages are fetched once per parameter and mostly discarded: about 22 pages for pm25, and fewer for rarer parameters. If OpenAQ starts honouring `countries_id` on this endpoint, the code can narrow it.
- Stale stations stay in each layer with their old `observed_at` (ADR 0018). Turkey and some other countries have many; the map already marks them stale.
- Station history (ADR 0014) keeps working per OpenAQ location id.
- Supersedes ADR 0018 items 1, 3 and 5 for the country and endpoint; items 2 (hourly task, own queue, locks) and 4 stay.

## Open
- Whether `/parameters/{id}/latest` supports `datetime_min`, which would drop stale values before they are fetched. Not tested.
- Paging a list that changes while it is read: the same sensor could appear on two pages or be missed. The refresh keeps the newest value per sensor and a missed value is picked up an hour later.
- Failure isolation: each country has its own refresh row and status. A country that is too big for the cap, or that OpenAQ answers oddly for, fails alone. A rejected key, a network or 5xx failure, or a failure of the shared latest-values fetch fails every country (they all depend on it), and each keeps its previous layer. Luchtmeetnet failing, for any reason, is a warning on the Netherlands. A failure to prune old refreshes is logged and does not fail a refresh. There is no retry inside a run: the next hour's run is the retry.

## Measured on 2026-10-04
One full pass against the real APIs: 45 location calls and 118 latest-value calls, 327 seconds, all 44 countries succeeded (France 1010 stations, Spain 974, Italy 909, Germany 765, United Kingdom 696, Netherlands 295, Poland 432, Turkey 406). Luchtmeetnet, running alongside, finished last (323 s), so its limit of 100 calls per 5 minutes is now the floor. Calls to OpenAQ are spaced by start time (1.2 s) and run one at a time. Turkey's 406 stations are mostly stale: 154 have a pm25 value and 8 reported within 24 hours (the Netherlands: 243 of 295 reported within 24 hours).
