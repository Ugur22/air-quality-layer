import type { MapLayerResponse } from '@/features/layers/types'
import { apiError, jsonResponse, type RecordedCall } from './mockApi'

const COMPARE: Record<string, (a: number, b: number) => boolean> = {
  '=': (a, b) => a === b,
  '>': (a, b) => a > b,
  '>=': (a, b) => a >= b,
  '<': (a, b) => a < b,
  '<=': (a, b) => a <= b,
}
const NUMBER = /^-?[0-9]+(\.[0-9]+)?$/

// The last value wins when a parameter is repeated (docs/api-contracts.md section 4).
const last = (params: URLSearchParams, key: string) => params.getAll(key).at(-1) ?? null

/**
 * A stand-in for GET /map-layers/{id} that follows the backend's rules (backend/src/airlayer/
 * layers.py and docs/api-contracts.md section 4): the filter grammar and comparators are checked
 * (400), property and value come together, an unknown property is a 400 that lists the valid keys,
 * a station without the property is excluded, and the layer-wide `station_count` and
 * `property_keys` never change.
 */
export function layerServer(layer: MapLayerResponse) {
  return (call: RecordedCall) => {
    const params = new URLSearchParams(call.search)
    const property = last(params, 'property')
    const value = last(params, 'value')
    const comparator = last(params, 'comparator')
    if (property === null && value === null && comparator === null) {
      return jsonResponse(200, layer)
    }
    const invalid = (message: string) => apiError(400, 'validation_failed', message)
    if (property === null && value === null) return invalid('comparator needs property and value.')
    if (!property || value === null) return invalid('property and value must be given together.')
    if (comparator !== null && !(comparator in COMPARE)) return invalid('bad comparator.')
    if (!NUMBER.test(value) || !Number.isFinite(Number(value))) return invalid('bad value.')
    const keys = layer.map_layer.property_keys
    if (!keys.includes(property)) {
      return invalid(`property must be one of: ${keys.join(', ') || '(none)'}.`)
    }
    const compare = COMPARE[comparator ?? '=']
    const features = layer.stations.features.filter((f) => {
      const reading = f.properties.readings[property]
      return reading !== undefined && compare?.(reading.value, Number(value)) === true
    })
    return jsonResponse(200, { ...layer, stations: { ...layer.stations, features } })
  }
}
