import { expect, test, type Route } from '@playwright/test'

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

const vehicle = { id: 'veh-997', vehicleNumber: '997', licensePlate: 'GÖ-FX997', maxSpeedKmh: 85 }
const stop = (id: string, tourId: string, sequence: number, type: 'LOAD' | 'UNLOAD', city: string, extra: Record<string, unknown> = {}) => ({
  id, tourId, sequence, type, address: `Werk ${city}`, city, postalCode: null, countryCode: 'DE', latitude: 50.7, longitude: 12.5,
  arrivedAt: null, completedAt: null, appointmentAt: null, ...extra
})
const current = { id: 'tour-a', vehicleId: vehicle.id, orderNumber: '20565269', status: 'ACTIVE', planVersion: 3,
  stops: [stop('s1', 'tour-a', 1, 'LOAD', 'Zwickau', { arrivedAt: '2026-11-03T12:39:00Z' }), stop('s2', 'tour-a', 2, 'UNLOAD', 'Bocholt')], legs: [] }
const queued = (id: string, order: string, from: string, to: string) => ({ id, vehicleId: vehicle.id, orderNumber: order, status: 'QUEUED', planVersion: 1, previousTourId: 'tour-a',
  plannedStartAt: '2026-11-04T06:00:00Z', stops: [stop(`${id}-1`, id, 1, 'LOAD', from), stop(`${id}-2`, id, 2, 'UNLOAD', to)], legs: [], events: [] })

test('вкладка «Тур»: следующая точка, следующие туры и удаление не начатого тура', async ({ page }) => {
  let tours = [current, queued('tour-b', '20570001', 'Bocholt', 'Kassel'), queued('tour-c', '20570002', 'Kassel', 'Bovenden')]
  let cancelled: unknown = null
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, '')
    if (path === '/auth/session') return json(route, { authenticated: true, role: 'dispatcher', csrfToken: 'e2e' })
    if (path === '/notifications') return json(route, { notifications: [] })
    if (path === '/dashboard') return json(route, { vehicles: [{ vehicle, tour: current, statusText: 'WAITING', operationVersion: 1,
      currentAction: { type: 'MARK_LOADED', label: 'BELADEN', stopId: 's1' }, mapPosition: { coordinate: [12.5, 50.7], source: 'WEBFLEET', stale: false } }] })
    if (path === '/vehicles/veh-997/tours') return json(route, tours)
    if (path === '/tours/tour-b' && route.request().method() === 'PATCH') {
      cancelled = route.request().postDataJSON()
      tours = tours.filter((tour) => tour.id !== 'tour-b')
      return json(route, { ...tours[0], status: 'CANCELLED' })
    }
    if (path.endsWith('/card')) return json(route, { vehicleId: vehicle.id, vehicleNumber: '997', licensePlate: null, currentTrailerPlate: null, generatedAt: new Date().toISOString(),
      webfleet: null, current: null, coupling: null, driver: null, events: null, trips: null, maintenance: null })
    if (path.endsWith('/current-position')) return json(route, { status: 'WAITING', coordinate: [12.5, 50.7] })
    return json(route, [])
  })
  await page.route('https://tile.openstreetmap.org/**', (route) => route.abort())
  page.on('dialog', (dialog) => void dialog.accept())
  await page.goto('/')
  await page.evaluate(() => window.localStorage.setItem('ops-truck-card-tab', 'tour'))

  // BELADEN is fully visible and does not run under the pin.
  const row = page.locator('.vehicle-card').filter({ hasText: 'LKW 997' })
  const action = row.getByRole('button', { name: 'BELADEN' })
  const pin = row.locator('.vehicle-card-actions .icon-button').last()
  const [a, b] = [await action.boundingBox(), await pin.boundingBox()]
  expect(a && b && a.x + a.width <= b.x + 0.5).toBe(true)

  await row.locator('.vehicle-row-main').click()
  const card = page.getByRole('dialog')
  await expect(card.getByRole('tab', { name: 'Тур' })).toHaveAttribute('aria-selected', 'true')
  await expect(card).toContainText('Следующая точкаЗагрузка · ')
  await expect(card).toContainText('Тур начат — удалить нельзя')
  await expect(card).toContainText('прибыл')
  const next = card.getByRole('region', { name: /Следующие туры/ })
  await expect(next).toContainText('20570001')
  await expect(next).toContainText('20570002')

  const toggle = next.locator('.truck-card-tour-toggle', { hasText: '20570001' })
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(next).not.toContainText('Загрузка · ')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await expect(next.locator('.truck-card-tour-details')).toContainText('Загрузка · Bocholt')
  await expect(next.locator('.truck-card-tour-details')).toContainText('Выгрузка · Kassel')
  await expect(next.locator('.truck-card-tour-details')).toContainText('впереди · без срока')
  await page.screenshot({ path: 'test-results/queued-tour-open.png', clip: { x: 0, y: 0, width: 1280, height: 900 } })
  await toggle.click()
  await expect(next.locator('.truck-card-tour-details')).toHaveCount(0)

  await next.getByRole('button', { name: 'Удалить тур 20570001' }).click()
  await expect.poll(() => cancelled).toEqual({ status: 'CANCELLED', version: 1 })
  await expect(next).not.toContainText('20570001')
  await expect(next).toContainText('20570002')
})

test('уведомление в фоне: окно Windows, звук и счётчик во вкладке', async ({ page }) => {
  await page.addInitScript(() => {
    const shown: Array<{ title: string; body?: string; tag?: string }> = []
    class FakeNotification {
      static permission = 'granted'
      static requestPermission = async () => 'granted'
      onclick: (() => void) | null = null
      constructor(title: string, options: { body?: string; tag?: string } = {}) { shown.push({ title, body: options.body, tag: options.tag }) }
      close() { /* nothing to close in the test */ }
    }
    Object.assign(window, { Notification: FakeNotification, shownNotifications: shown })
    Object.defineProperty(document, 'hasFocus', { value: () => false })
  })
  let notifications: Array<Record<string, unknown>> = []
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, '')
    if (path === '/auth/session') return json(route, { authenticated: true, role: 'dispatcher', csrfToken: 'e2e' })
    if (path === '/notifications') return json(route, { notifications })
    if (path === '/dashboard') return json(route, { vehicles: [] })
    return json(route, [])
  })
  await page.route('https://tile.openstreetmap.org/**', (route) => route.abort())
  // The first answer marks what is already known; only later notifications alert.
  const firstPoll = page.waitForResponse((response) => response.url().endsWith('/api/notifications'))
  await page.goto('/vehicles')
  await firstPoll
  await expect(page).toHaveTitle('OPS FOREX')

  notifications = [{ id: 'n1', vehicleId: vehicle.id, stopId: 's1', type: 'AUTO_ARRIVAL', message: 'Webfleet: LKW 997 прибыла на загрузку, Zwickau', createdAt: new Date().toISOString() }]
  // Showing the tab again refreshes at once instead of waiting for the 30 s poll.
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await expect(page).toHaveTitle('(1) OPS FOREX')
  const shown = await page.evaluate(() => (window as unknown as { shownNotifications: Array<{ title: string; body?: string; tag?: string }> }).shownNotifications)
  expect(shown).toEqual([{ title: 'Прибытие по GPS', body: 'Webfleet: LKW 997 прибыла на загрузку, Zwickau', tag: 'n1' }])
})
