/** Names for the pollutant keys the sources report (OpenAQ's, and Luchtmeetnet's extras, ADR 0017). */
const POLLUTANT_NAMES: Record<string, string> = {
  pm25: 'PM2.5',
  pm10: 'PM10',
  no2: 'Nitrogen dioxide',
  no: 'Nitrogen monoxide',
  o3: 'Ozone',
  so2: 'Sulphur dioxide',
  co: 'Carbon monoxide',
  nh3: 'Ammonia',
  h2s: 'Hydrogen sulphide',
  c6h6: 'Benzene',
  c7h8: 'Toluene',
  c8h10: 'Xylene',
  fn: 'Soot (black smoke)',
  bcwb: 'Black carbon (wood burning)',
  ps: 'Ultrafine particles',
}

/** The text of a pollutant choice: its name and key, or just the key when there is no name. */
export function pollutantLabel(key: string): string {
  // hasOwn: a key such as "constructor" must not find something on the object's prototype.
  const name = Object.hasOwn(POLLUTANT_NAMES, key) ? POLLUTANT_NAMES[key] : undefined
  return name === undefined ? key : `${name} (${key})`
}
