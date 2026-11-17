import { expect, test, type Route } from '@playwright/test'

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

const truck = (id: string, vehicleNumber: string) => ({ id, vehicleNumber, licensePlate: null, maxSpeedKmh: 85 })

test('«Мои» по умолчанию, весь парк с хозяевами и «Взять себе»', async ({ page }) => {
  let freeOwner: { id: string; name: string } | null = null
  let assignment: unknown = null
  const rows = () => [
    { vehicle: truck('v-mine', '2803'), tour: null, statusText: 'IDLE', operationVersion: 1, assignedTo: { id: 'd-anna', name: 'Anna Beispiel' }, mine: true },
    { vehicle: truck('v-ben', '7448'), tour: null, statusText: 'MOVING', operationVersion: 1, assignedTo: { id: 'd-ben', name: 'Ben Muster' }, mine: false },
    { vehicle: truck('v-free', '3786'), tour: null, statusText: 'IDLE', operationVersion: 1, assignedTo: freeOwner, mine: Boolean(freeOwner) }
  ]
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, '')
    if (path === '/auth/session') return json(route, { authenticated: true, role: 'dispatcher', csrfToken: 'e2e', dispatcherId: 'd-anna', displayName: 'Anna Beispiel', onboardingCompletedAt: '2026-11-01T00:00:00Z' })
    if (path === '/notifications') return json(route, { notifications: [] })
    if (path === '/dashboard') return json(route, { me: 'd-anna', vehicles: rows() })
    if (path === '/vehicles/v-free/assignment') {
      assignment = route.request().postDataJSON()
      freeOwner = { id: 'd-anna', name: 'Anna Beispiel' }
      return json(route, { vehicleId: 'v-free', assignedTo: freeOwner })
    }
    if (path.endsWith('/current-position')) return json(route, { status: 'IDLE' })
    return json(route, [])
  })
  await page.route('https://tile.openstreetmap.org/**', route => route.abort())
  await page.goto('/')

  const scope = page.getByRole('group', { name: 'Чьи машины показать' })
  await expect(scope.getByRole('button', { name: /Мои/ })).toHaveAttribute('aria-pressed', 'true')
  const rowsInList = page.locator('.fleet-list .vehicle-card')
  await expect(rowsInList).toHaveCount(1)
  await expect(rowsInList.first()).toContainText('LKW 2803')

  await scope.getByRole('button', { name: /Весь парк/ }).click()
  await expect(rowsInList).toHaveCount(3)
  await expect(rowsInList.filter({ hasText: 'LKW 7448' })).toContainText('ведёт Ben Muster')
  await expect(rowsInList.filter({ hasText: 'LKW 3786' })).toContainText('свободна')

  await scope.getByRole('button', { name: /Свободные/ }).click()
  await expect(rowsInList).toHaveCount(1)
  await rowsInList.first().locator('.vehicle-row-main').click()
  const card = page.getByRole('dialog')
  await expect(card).toContainText('Свободна')
  await card.getByRole('button', { name: 'Взять себе' }).click()
  await expect.poll(() => assignment).toEqual({ action: 'take', expectedDispatcherId: null })
  await expect(card).toContainText('Моя машина')

  await scope.getByRole('button', { name: /Мои/ }).click()
  await expect(rowsInList).toHaveCount(2)
})

const at = (longitude: number, latitude: number) => ({ coordinate: [longitude, latitude], source: 'WEBFLEET', stale: false, courseDeg: 0, standstill: false })
// Four towns far apart, so the markers never fold into one cluster.
const fleetRows = [
  { vehicle: truck('v-mine', '2803'), tour: null, statusText: 'IDLE', operationVersion: 1, assignedTo: { id: 'd-anna', name: 'Anna Beispiel' }, mine: true, mapPosition: at(9.99, 53.55) },
  { vehicle: truck('v-line', '2804'), tour: null, statusText: 'IDLE', operationVersion: 1, assignedTo: null, mine: true, mapPosition: at(11.58, 48.14) },
  { vehicle: truck('v-ben', '7448'), tour: null, statusText: 'MOVING', operationVersion: 1, assignedTo: { id: 'd-ben', name: 'Ben Muster' }, mine: false, mapPosition: at(13.4, 52.52) },
  { vehicle: truck('v-free', '3786'), tour: null, statusText: 'IDLE', operationVersion: 1, assignedTo: null, mine: false, mapPosition: at(6.96, 50.94) }
]
async function fleet(page: import('@playwright/test').Page, role: 'admin' | 'dispatcher', asked: string[]) {
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url())
    const path = url.pathname.replace(/^\/api/, '')
    if (path === '/auth/session') return json(route, { authenticated: true, role, csrfToken: 'e2e', dispatcherId: 'd-anna', displayName: 'Anna Beispiel', onboardingCompletedAt: '2026-11-01T00:00:00Z' })
    if (path === '/notifications') { asked.push(url.search); return json(route, { notifications: [] }) }
    if (path === '/dashboard') return json(route, { me: 'd-anna', vehicles: fleetRows })
    if (path.endsWith('/current-position')) return json(route, { status: 'IDLE' })
    return json(route, [])
  })
  await page.route('https://tile.openstreetmap.org/**', route => route.abort())
}
const marker = (page: import('@playwright/test').Page, number: string) => page.locator(`.fleet-marker[aria-label^="LKW ${number}:"]`)

test('диспетчер видит на карте только свои машины, остальные — по кнопке', async ({ page }) => {
  const asked: string[] = []
  await fleet(page, 'dispatcher', asked)
  await page.goto('/')
  // The first own truck is the selected one (drawn as the position, not as a fleet marker); the other own truck is a marker.
  await expect(marker(page, '2804')).toBeAttached()
  await expect(page.locator('.fleet-marker')).toHaveCount(1)
  await expect(page.locator('.fleet-list .vehicle-card')).toHaveCount(2)

  const scope = page.getByRole('group', { name: 'Чьи машины показать' })
  await expect(scope.getByRole('button', { name: /^Мои/ })).toHaveAttribute('aria-pressed', 'true')
  await scope.getByRole('button', { name: /Весь парк/ }).click()
  await expect(page.locator('.fleet-marker')).toHaveCount(3)
  await expect(marker(page, '7448')).toBeAttached()

  // A dispatcher's look at the fleet is not remembered: the next visit starts with their own trucks again.
  await page.reload()
  await expect(scope.getByRole('button', { name: /^Мои/ })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.fleet-marker')).toHaveCount(1)
  expect(asked.every((query) => query === '')).toBe(true)
})

test('админ видит весь парк и скрывает чужие линии кнопкой «Мои линии»', async ({ page }) => {
  const asked: string[] = []
  await fleet(page, 'admin', asked)
  await page.goto('/')
  const scope = page.getByRole('group', { name: 'Чьи машины показать' })
  await expect(scope.getByRole('button', { name: /Весь парк/ })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.fleet-list .vehicle-card')).toHaveCount(4)
  await expect(page.locator('.fleet-marker')).toHaveCount(3)
  expect(asked.at(-1)).toBe('')

  await scope.getByRole('button', { name: /Мои линии/ }).click()
  await expect(page.locator('.fleet-list .vehicle-card')).toHaveCount(2)
  await expect(marker(page, '7448')).toHaveCount(0)
  await expect(marker(page, '3786')).toHaveCount(0)
  await expect.poll(() => asked.at(-1)).toBe('?scope=mine')

  // The admin's choice is kept for the next visit.
  await page.reload()
  await expect(scope.getByRole('button', { name: /Мои линии/ })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.fleet-list .vehicle-card')).toHaveCount(2)
  await expect(marker(page, '7448')).toHaveCount(0)
})
