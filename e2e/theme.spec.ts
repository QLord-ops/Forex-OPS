import { expect, test, type Route } from '@playwright/test'

async function json(route: Route, body: unknown) {
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
}

const vehicle = { id: 'veh-997', vehicleNumber: '997', licensePlate: 'GÖ-FX997', maxSpeedKmh: 85 }

test.use({ colorScheme: 'light' })

test('ночная смена: переключение, выбор переживает перезагрузку, карта на месте', async ({ page }) => {
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, '')
    if (path === '/auth/session') return json(route, { authenticated: true, role: 'dispatcher', csrfToken: 'e2e' })
    if (path === '/notifications') return json(route, { notifications: [] })
    if (path === '/dashboard') return json(route, { vehicles: [{ vehicle, tour: null, statusText: 'IDLE', operationVersion: 1, currentAction: null,
      mapPosition: { coordinate: [10.0, 51.5], source: 'WEBFLEET', stale: false } }] })
    return json(route, [])
  })
  await page.route('https://tile.openstreetmap.org/**', (route) => route.abort())
  await page.goto('/')

  const html = page.locator('html')
  await expect(html).toHaveAttribute('data-theme', 'light')
  const toggle = page.getByRole('button', { name: 'Ночная смена' })
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await toggle.click()
  await expect(html).toHaveAttribute('data-theme', 'dark')
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#08101b')
  // Night surfaces really change: the list background is no longer white.
  const background = await page.locator('body').evaluate((el) => getComputedStyle(el).backgroundImage)
  expect(background).not.toContain('255, 255, 255')

  await page.reload()
  await expect(html).toHaveAttribute('data-theme', 'dark')
  await expect(page.locator('.maplibregl-canvas')).toBeVisible()
  await expect(page.locator('.vehicle-card').filter({ hasText: 'LKW 997' })).toBeVisible()

  await page.getByRole('button', { name: 'Ночная смена' }).click()
  await expect(html).toHaveAttribute('data-theme', 'light')
})

test.describe('системная тёмная тема', () => {
  test.use({ colorScheme: 'dark' })
  test('без выбора диспетчера берётся из Windows', async ({ page }) => {
    await page.route('**/api/**', (route) => json(route, new URL(route.request().url()).pathname.endsWith('/auth/session')
      ? { authenticated: true, role: 'dispatcher', csrfToken: 'e2e' } : []))
    await page.goto('/')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  })
})
