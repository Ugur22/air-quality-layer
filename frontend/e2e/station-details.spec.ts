import { expect, test, type Page } from '@playwright/test'

/**
 * The station dialog and its trend chart in a real browser: Recharts needs real layout, which
 * jsdom does not have. The API is stubbed so the test does not depend on OpenAQ or a synced
 * database; the endpoints themselves are covered by the backend tests.
 */

const OBSERVED = new Date(Date.now() - 60 * 60 * 1000).toISOString()
const reading = (value: number) => ({ value, unit: 'µg/m³', observed_at: OBSERVED })

const LAYER = {
  map_layer: {
    id: 'layer-1',
    region_id: 'region-1',
    station_count: 2,
    bbox: [4.85, 52.35, 4.95, 52.4],
    property_keys: ['pm25'],
  },
  stations: {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        id: 'station-low',
        geometry: { type: 'Point', coordinates: [4.88, 52.38] },
        properties: { name: 'Low Street', readings: { pm25: reading(4.2) } },
      },
      {
        type: 'Feature',
        id: 'station-high',
        geometry: { type: 'Point', coordinates: [4.92, 52.39] },
        properties: { name: 'High Street', readings: { pm25: reading(26.1) } },
      },
    ],
  },
}

const HOURS = Array.from({ length: 24 }, (_, i) => ({
  at: new Date(Date.now() - (24 - i) * 3_600_000).toISOString(),
  value: 10 + 8 * Math.sin(i / 3),
}))

async function stubApi(page: Page, history: () => { status: number; body: unknown }) {
  const job = {
    id: 'layer-1',
    region_id: 'region-1',
    status: 'succeeded',
    created_at: OBSERVED,
    started_at: OBSERVED,
    finished_at: OBSERVED,
    station_count: 2,
    map_layer_id: 'layer-1',
    errors: [],
  }
  await page.route('**/api/v1/projects', (r) =>
    r.fulfill({ json: { projects: [{ id: 'project-1', name: 'Demo' }] } }),
  )
  await page.route('**/api/v1/projects/*/regions', (r) =>
    r.fulfill({
      status: 201,
      json: {
        region: {
          id: 'region-1',
          project_id: 'project-1',
          name: 'Amsterdam centre',
          bbox: [4.85, 52.35, 4.95, 52.4],
          created_at: OBSERVED,
        },
      },
    }),
  )
  await page.route('**/api/v1/regions/*/syncs', (r) =>
    r.fulfill({ status: 202, json: { sync_job: job } }),
  )
  await page.route('**/api/v1/syncs/*', (r) => r.fulfill({ json: { sync_job: job } }))
  await page.route('**/api/v1/map-layers/layer-1', (r) => r.fulfill({ json: LAYER }))
  await page.route('**/api/v1/map-layers/layer-1/stations/*/history*', (r) => {
    const { status, body } = history()
    return r.fulfill({ status, json: body })
  })
}

test.beforeEach(({ page }) => {
  const errors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(error.message))
  ;(page as Page & { errors?: string[] }).errors = errors
})

test.afterEach(({ page }) => {
  // The browser logs every failed request; the 503 of the unavailable-trend test is expected.
  const errors = (page as Page & { errors?: string[] }).errors ?? []
  expect(errors.filter((e) => !/status of 503/.test(e))).toEqual([])
})

async function openDialog(page: Page, station: string) {
  await page.goto('/')
  // The app opens with no area, so one is typed under "Custom area".
  await page.getByRole('button', { name: 'Custom area' }).click()
  await page.getByLabel('Name').fill('Amsterdam centre')
  await page.getByLabel(/^West/).fill('4.85')
  await page.getByLabel(/^South/).fill('52.35')
  await page.getByLabel(/^East/).fill('4.95')
  await page.getByLabel(/^North/).fill('52.4')
  await page.getByRole('button', { name: /create region and sync/i }).click()
  await page.getByRole('button', { name: new RegExp(station) }).click()
  return page.getByRole('dialog', { name: station })
}

test('a station opens a dialog whose trend tab draws the last day', async ({ page }) => {
  let asked = 0
  await stubApi(page, () => {
    asked += 1
    return {
      status: 200,
      body: {
        history: {
          property: 'pm25',
          unit: 'µg/m³',
          interval: 'hour',
          from: HOURS[0]?.at,
          to: new Date().toISOString(),
          points: HOURS,
        },
      },
    }
  })

  const dialog = await openDialog(page, 'High Street')
  await expect(dialog).toContainText('1st highest')
  await expect(dialog.locator('.recharts-scatter')).not.toHaveCount(0)
  expect(asked).toBe(0) // the trend is only asked for when its tab is opened

  await dialog.getByRole('tab', { name: 'Trend' }).click()

  await expect(dialog.locator('.recharts-area-curve')).toBeVisible()
  await expect(dialog.getByText('Latest', { exact: true })).toBeVisible()
  expect(asked).toBe(1)

  // A chart is not keyboard-operable and is described in text, so it must not be a Tab stop that
  // assistive technology cannot see (Recharts adds tabindex=0 unless accessibilityLayer is off;
  // its tabindex=-1 layer groups are not in the Tab order).
  await expect(dialog.locator('svg[tabindex="0"], svg [tabindex="0"]')).toHaveCount(0)
  await dialog.getByRole('tab', { name: 'Overview' }).click()
  await expect(dialog.locator('svg[tabindex="0"], svg [tabindex="0"]')).toHaveCount(0)
  await dialog.getByRole('tab', { name: 'Trend' }).click()

  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('an unavailable trend says so and can be retried', async ({ page }) => {
  let healthy = false
  await stubApi(page, () =>
    healthy
      ? {
          status: 200,
          body: {
            history: {
              property: 'pm25',
              unit: 'µg/m³',
              interval: 'hour',
              from: HOURS[0]?.at,
              to: new Date().toISOString(),
              points: HOURS,
            },
          },
        }
      : {
          status: 503,
          body: {
            error: {
              code: 'service_unavailable',
              message: 'The trend is unavailable right now. Try again in a moment.',
              details: [],
            },
          },
        },
  )

  const dialog = await openDialog(page, 'Low Street')
  await dialog.getByRole('tab', { name: 'Trend' }).click()
  await expect(dialog.getByRole('alert')).toContainText('The trend is unavailable right now')

  healthy = true
  await dialog.getByRole('button', { name: 'Try again' }).click()

  await expect(dialog.locator('.recharts-area-curve')).toBeVisible()
})
