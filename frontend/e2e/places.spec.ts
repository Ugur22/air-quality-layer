import { expect, test, type Page } from '@playwright/test'

/**
 * Place search in a real browser. The API answer for /places is stubbed here so the test does not
 * depend on Photon being reachable; the endpoint itself is covered by the backend tests.
 */

const MAP = 'canvas.maplibregl-canvas'

const UTRECHT = {
  id: 'R2468',
  name: 'Utrecht',
  detail: 'Utrecht, Nederland',
  kind: 'city',
  point: [5.1214, 52.0907],
  bbox: [4.9704, 52.0261, 5.1951, 52.1427],
}
const NETHERLANDS = {
  id: 'R2323309',
  name: 'Nederland',
  detail: '',
  kind: 'country',
  point: [5.3, 52.1],
  bbox: null,
}

async function stubPlaces(page: Page, places: unknown[]) {
  await page.route('**/api/v1/places*', (route) => route.fulfill({ json: { places } }))
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
  expect((page as Page & { errors?: string[] }).errors ?? []).toEqual([])
})

test('choosing a place fills the form and moves the map there', async ({ page }) => {
  await stubPlaces(page, [UTRECHT, NETHERLANDS])
  await page.goto('/')
  await page.locator(MAP).waitFor()
  await page.waitForTimeout(2500)
  const before = await page.locator(MAP).screenshot()

  await page.getByRole('combobox', { name: /search for a place/i }).fill('utrecht')
  await expect(page.getByRole('option')).toHaveCount(2)
  await page.getByRole('option', { name: /utrecht/i }).click()

  await expect(page.getByLabel('Name')).toHaveValue('Utrecht')
  // The numbers stay under "Custom area"; the box on the map shows the chosen area.
  await expect(page.getByLabel(/^West/)).toHaveCount(0)
  await page.getByRole('button', { name: 'Custom area' }).click()
  await expect(page.getByLabel(/^West/)).toHaveValue('4.9704')
  await expect(page.getByLabel(/^North/)).toHaveValue('52.1427')
  await expect(page.getByRole('option')).toHaveCount(0)
  await page.waitForTimeout(2500) // the camera flight and new tiles
  expect(await page.locator(MAP).screenshot()).not.toEqual(before)
})

test('a place that is too large is shown but cannot be chosen', async ({ page }) => {
  await stubPlaces(page, [NETHERLANDS])
  await page.goto('/')
  await page.getByRole('combobox', { name: /search for a place/i }).fill('netherlands')

  const option = page.getByRole('option', { name: /nederland/i })
  await expect(option).toContainText(/too large/i)
  await option.click({ force: true })

  await expect(page.getByLabel('Name')).toHaveValue('')
})

test('works from the keyboard', async ({ page }) => {
  await stubPlaces(page, [UTRECHT])
  await page.goto('/')
  await page.getByRole('combobox', { name: /search for a place/i }).fill('utrecht')
  await expect(page.getByRole('option')).toHaveCount(1)

  await page.keyboard.press('Enter')

  await expect(page.getByLabel('Name')).toHaveValue('Utrecht')
})
