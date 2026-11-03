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
    if (path === '/auth/session') return json(route, { authenticated: true, role: 'dispatcher', csrfToken: 'e2e', dispatcherId: 'd-anna', displayName: 'Anna Beispiel' })
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
