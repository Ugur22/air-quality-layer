import { createHash } from 'node:crypto'
import { expect, test, type Page } from '@playwright/test'

/**
 * Real-browser checks for what jsdom cannot do: the map (WebGL, its worker) and drawing on it
 * (ADR 0009, 0011, 0012). They need the API (`make up`) because the page loads its project.
 */

const MAP = 'canvas.maplibregl-canvas'

test.beforeEach(async ({ page }) => {
  const errors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(error.message))
  // Asserted in afterEach below; stored on the page object to reach it there.
  ;(page as Page & { errors?: string[] }).errors = errors
  await page.goto('/')
  await page.locator(MAP).waitFor()
  await page.waitForTimeout(2500) // style and tiles
})

test.afterEach(({ page }) => {
  expect((page as Page & { errors?: string[] }).errors ?? []).toEqual([])
})

async function mapBox(page: Page) {
  const box = await page.locator(MAP).boundingBox()
  if (!box) throw new Error('map has no size')
  return box
}

async function fields(page: Page) {
  return [
    await page.getByLabel(/^West/).inputValue(),
    await page.getByLabel(/^South/).inputValue(),
    await page.getByLabel(/^East/).inputValue(),
    await page.getByLabel(/^North/).inputValue(),
  ]
}

async function drag(page: Page, from: [number, number], to: [number, number]) {
  await page.mouse.move(...from)
  await page.mouse.down()
  await page.mouse.move(...to, { steps: 8 })
  await page.mouse.up()
}

async function startDrawing(page: Page) {
  await page.getByRole('button', { name: /draw region/i }).click()
  await page.waitForTimeout(400)
}

async function picture(page: Page): Promise<string> {
  return createHash('md5')
    .update(await page.locator(MAP).screenshot())
    .digest('hex')
}

/** Waits until the map stops changing by itself (tiles, fades), so a later change is a real one. */
async function waitUntilStill(page: Page) {
  let last = await picture(page)
  for (let i = 0; i < 20; i += 1) {
    await page.waitForTimeout(500)
    const now = await picture(page)
    if (now === last) return
    last = now
  }
  throw new Error('the map never stopped changing')
}

/** True when a plain drag moves the map (the picture changes). */
async function mapPans(page: Page): Promise<boolean> {
  await waitUntilStill(page)
  const before = await picture(page)
  const box = await mapBox(page)
  await drag(page, [box.x + 250, box.y + 300], [box.x + 420, box.y + 340])
  await page.waitForTimeout(1500)
  return before !== (await picture(page))
}

test('the map is on screen before any sync, with the box from the form', async ({ page }) => {
  await expect(page.locator(MAP)).toBeVisible()
  await expect(page.getByLabel(/^West/)).toHaveValue('4.85')
  await expect(page.locator('#map-hint')).toContainText('dashed box')
})

test('a dragged rectangle fills the form, drawing turns off and the map still pans', async ({
  page,
}) => {
  const box = await mapBox(page)
  const before = await fields(page)

  await startDrawing(page)
  await expect(page.getByRole('button', { name: /draw region/i })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await drag(page, [box.x + 300, box.y + 120], [box.x + 520, box.y + 280])

  await expect(page.getByRole('button', { name: /draw region/i })).toHaveAttribute(
    'aria-pressed',
    'false',
  )
  expect(await fields(page)).not.toEqual(before)
  const [west, south, east, north] = (await fields(page)).map(Number) as [
    number,
    number,
    number,
    number,
  ]
  expect(west).toBeLessThan(east)
  expect(south).toBeLessThan(north)
  expect(await mapPans(page)).toBe(true)
})

test('a drag may start in the top-left corner of the map, under the overlay', async ({ page }) => {
  const box = await mapBox(page)
  const before = await fields(page)

  await startDrawing(page)
  await drag(page, [box.x + 80, box.y + 60], [box.x + 400, box.y + 300])

  expect(await fields(page)).not.toEqual(before)
})

test('Escape in the middle of a drag leaves the map pannable', async ({ page }) => {
  const box = await mapBox(page)
  const before = await fields(page)

  await startDrawing(page)
  await page.mouse.move(box.x + 500, box.y + 150)
  await page.mouse.down()
  await page.mouse.move(box.x + 650, box.y + 250, { steps: 6 })
  await page.keyboard.press('Escape')
  await page.mouse.up()

  await expect(page.getByRole('button', { name: /draw region/i })).toHaveAttribute(
    'aria-pressed',
    'false',
  )
  expect(await fields(page)).toEqual(before)
  expect(await mapPans(page)).toBe(true)
})

test('a second drawing replaces the first box', async ({ page }) => {
  const box = await mapBox(page)
  await startDrawing(page)
  await drag(page, [box.x + 300, box.y + 120], [box.x + 500, box.y + 260])
  const first = await fields(page)

  await startDrawing(page)
  await drag(page, [box.x + 520, box.y + 160], [box.x + 760, box.y + 330])

  expect(await fields(page)).not.toEqual(first)
})

test('a drawn box over 2 degrees is explained and cannot be submitted', async ({ page }) => {
  const box = await mapBox(page)
  for (let i = 0; i < 6; i += 1) {
    await page.getByRole('button', { name: /zoom out/i }).click()
    await page.waitForTimeout(250)
  }
  await page.waitForTimeout(1500)

  await startDrawing(page)
  await drag(page, [box.x + 120, box.y + 100], [box.x + box.width - 120, box.y + box.height - 100])

  await expect(page.locator('#map-hint')).toContainText(/at most 2 degrees/)
  await page.getByRole('button', { name: /create region and sync/i }).click()
  await expect(
    page.getByRole('form', { name: 'Region' }).getByText(/at most 2 degrees wide/),
  ).toBeVisible()
})
