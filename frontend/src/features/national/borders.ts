import { useEffect, useState } from 'react'

type Border = GeoJSON.Feature<GeoJSON.MultiPolygon>

// One file per country (Natural Earth 1:10m, public domain, simplified), loaded when the country
// is shown so the first page does not carry all of them.
const loaders = import.meta.glob<Border>('./borders/*.json', { import: 'default' })

/** The real border of a country, or null while it loads or when there is none to draw. */
export function useCountryBorder(code: string | null): Border | null {
  const [loaded, setLoaded] = useState<{ code: string; border: Border } | null>(null)

  useEffect(() => {
    const load = code ? loaders[`./borders/${code}.json`] : undefined
    if (!code || !load) return
    let current = true
    // A border that cannot be loaded is only decoration lost; the stations are still shown.
    void load()
      .then((border) => {
        if (current) setLoaded({ code, border })
      })
      .catch(() => undefined)
    return () => {
      current = false
    }
  }, [code])

  return loaded && loaded.code === code ? loaded.border : null
}
