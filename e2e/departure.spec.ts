import { expect, test, type Route } from '@playwright/test'

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

const truck = (id: string, vehicleNumber: string) => ({ id, vehicleNumber, licensePlate: null, maxSpeedKmh: 85 })
const stop = (id: string, extra: Record<string, unknown> = {}) => ({ id, tourId: `t-${id}`, sequence: 1, type: 'UNLOAD', address: 'Werkstraße 1, 80995 München', city: 'München', latitude: 48.1, longitude: 11.5, arrivedAt: null, completedAt: null, ...extra })

test('машина с термином выделена меткой, фильтр «Термин» оставляет только её', async ({ page }) => {
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, '')
    if (path === '/auth/session') return json(route, { authenticated: true, role: 'dispatcher', csrfToken: 'e2e' })
    if (path === '/notifications') return json(route, { notifications: [] })
    if (path === '/dashboard') return json(route, { vehicles: [
      { vehicle: truck('v1', '949'), statusText: 'MOVING', operationVersion: 1, tour: { id: 't-a', vehicleId: 'v1', orderNumber: 'A-1', status: 'ACTIVE', stops: [stop('a', { appointmentAt: '2026-11-04T10:00:00Z' })] } },
      { vehicle: truck('v2', '125'), statusText: 'MOVING', operationVersion: 1, tour: { id: 't-b', vehicleId: 'v2', orderNumber: 'B-1', status: 'ACTIVE', stops: [stop('b')] } }
    ] })
    if (path.endsWith('/current-position')) return json(route, { status: 'MOVING' })
    return json(route, { error: 'not mocked' }, 404)
  })
  await page.route('https://tile.openstreetmap.org/**', (route) => route.abort())
  await page.goto('/')
  const rows = page.locator('.fleet-list .vehicle-card')
  await expect(rows).toHaveCount(2)
  const withSlot = rows.filter({ hasText: 'LKW 949' })
  await expect(withSlot).toHaveClass(/vehicle-card-termin/)
  await expect(withSlot.locator('.vehicle-row-termin')).toHaveText('Термин 04.11 11:00')
  await expect(rows.filter({ hasText: 'LKW 125' }).locator('.vehicle-row-termin')).toHaveCount(0)
  await page.getByRole('button', { name: 'Термин', exact: true }).click()
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toContainText('LKW 949')
})

test('уведомление «уехала с точки»: BELADEN со временем выезда', async ({ page }) => {
  let loaded: unknown = null
  let notifications = [{ id: 'n-dep', vehicleId: 'v1', stopId: 'stop-l', type: 'STOP_DEPARTED', createdAt: new Date().toISOString(),
    message: 'LKW 949 уехала с загрузки Zwickau в 15:42 без BELADEN. Загружена?', payloadJson: JSON.stringify({ stopId: 'stop-l', stopType: 'LOAD', leftAt: '2026-11-03T14:42:00.000Z' }) }]
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, '')
    if (path === '/auth/session') return json(route, { authenticated: true, role: 'dispatcher', csrfToken: 'e2e' })
    if (path === '/notifications') return json(route, { notifications })
    if (path === '/stops/stop-l/loaded') { loaded = route.request().postDataJSON(); notifications = []; return json(route, { id: 't', vehicleId: 'v1', stops: [] }) }
    if (path === '/vehicles') return json(route, [truck('v1', '949')])
    return json(route, { error: 'not mocked' }, 404)
  })
  page.on('dialog', (dialog) => void dialog.accept())
  await page.goto('/vehicles')
  const toast = page.getByRole('dialog')
  await expect(toast).toContainText('без BELADEN')
  await expect(toast.getByRole('button', { name: 'Ещё не загружена' })).toBeVisible()
  await expect(toast.getByRole('button', { name: 'Прибытие было ошибкой' })).toBeVisible()
  await toast.getByRole('button', { name: 'BELADEN 15:42' }).click()
  await expect.poll(() => loaded).toEqual({ timestamp: '2026-11-03T14:42:00.000Z' })
  await expect(page.getByRole('dialog')).toHaveCount(0)
})
