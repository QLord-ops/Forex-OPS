import { devices, expect, test, type Page, type Route } from '@playwright/test'

// The phone: Chromium in the Pixel 5 profile (touch, 393 px wide).
test.use({ ...devices['Pixel 5'] })

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}
const stop = (id: string, type: 'LOAD' | 'UNLOAD', city: string) => ({ id, tourId: 't1', sequence: type === 'LOAD' ? 1 : 2, type, company: `Werk ${city}`, address: `Werkstraße 1, ${city}`, city,
  latitude: 51.2, longitude: 6.8, serviceMinMinutes: 60, serviceMaxMinutes: 120, arrivedAt: null, completedAt: null })
const row = (id: string, number: string) => ({
  vehicle: { id, vehicleNumber: number, licensePlate: null, maxSpeedKmh: 85 },
  tour: { id: `t-${id}`, vehicleId: id, orderNumber: '71123727', status: 'ACTIVE', stops: [stop(`${id}a`, 'LOAD', 'Düsseldorf'), stop(`${id}b`, 'UNLOAD', 'Ludwigsfelde')], legs: [] },
  statusText: 'EN_ROUTE', operationVersion: 1, assignedTo: null, mine: true
})
const deviation = { id: 'n1', vehicleId: 'v2', stopId: null, type: 'ROUTE_DEVIATION', message: 'LKW 997: 2,4 km vom Kurs', createdAt: new Date().toISOString(), payloadJson: '{}',
  priority: 'ACTION', urgent: false, resolved: false, resolvedReason: null, leadId: 'n1', stackSize: 1 }

async function phone(page: Page, onImage?: () => void) {
  // Headless Chromium always reports notifications as blocked; a phone where the dispatcher allowed them is the usual case.
  await page.addInitScript(() => Object.defineProperty(Notification, 'permission', { get: () => 'granted' }))
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, '')
    if (path === '/auth/session') return json(route, { authenticated: true, role: 'dispatcher', csrfToken: 'e2e', dispatcherId: 'd1', displayName: 'Anna Beispiel', onboardingCompletedAt: '2026-11-01T00:00:00Z' })
    if (path === '/notifications') return json(route, { notifications: [deviation] })
    if (path === '/dashboard') return json(route, { me: 'd1', vehicles: [row('v1', '321'), row('v2', '997')] })
    if (path.endsWith('/current-position')) return json(route, { status: 'EN_ROUTE' })
    if (path.endsWith('/card')) return json(route, { vehicleNumber: '321', webfleet: null, events: { unresolved: 0, items: [] } })
    if (path === '/imports/image/preview') { onImage?.(); return json(route, { source: 'OPENAI', detectedLayout: 'IMAGE', drafts: [], warnings: [], aiAvailable: true }) }
    return json(route, [])
  })
  await page.route('https://tile.openstreetmap.org/**', (route) => route.abort())
}
const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)

test('телефон: вкладки внизу, машины и карта по отдельности, выбранная машина не теряется', async ({ page }) => {
  await phone(page)
  await page.goto('/')
  const tabs = page.getByRole('navigation', { name: 'Разделы' })
  await expect(tabs).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Основная навигация' })).toBeHidden()
  await expect(tabs.getByRole('link', { name: 'Машины' })).toHaveAttribute('aria-current', 'page')
  await expect(tabs.getByRole('link', { name: /Решения/ })).toContainText('1')
  await expect(page.getByRole('complementary', { name: 'Список грузовиков' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Карта выбранного грузовика' })).toBeHidden()
  expect(await sideways(page)).toBe(0)

  await tabs.getByRole('link', { name: 'Карта' }).click()
  await expect(page).toHaveURL(/view=map/)
  await expect(page).toHaveURL(/vehicleId=v1/)
  await expect(page.getByRole('region', { name: 'Карта выбранного грузовика' })).toBeVisible()
  await expect(page.getByRole('complementary', { name: 'Список грузовиков' })).toBeHidden()
  await tabs.getByRole('link', { name: 'Машины' }).click()
  await expect(page).not.toHaveURL(/view=map/)
  await expect(page).toHaveURL(/vehicleId=v1/)
})

test('телефон: карточка машины — лист над списком, ручка разворачивает и сворачивает', async ({ page }) => {
  await phone(page)
  await page.goto('/')
  await page.locator('.vehicle-row-main').first().click()
  const sheet = page.getByRole('dialog', { name: /LKW 321/ })
  await expect(sheet).toHaveClass(/truck-card-sheet-half/)
  await sheet.getByRole('button', { name: 'Развернуть карточку' }).click()
  await expect(sheet).toHaveClass(/truck-card-sheet-full/)
  await sheet.getByRole('button', { name: 'Свернуть карточку наполовину' }).click()
  await expect(sheet).toHaveClass(/truck-card-sheet-half/)
  await sheet.getByRole('button', { name: 'Закрыть карточку' }).click()
  await expect(page.locator('.truck-card')).toHaveCount(0)
})

test('телефон: «Решения» вместо колокольчика, Auftrag камерой, «Ещё» со всеми разделами', async ({ page }) => {
  let imageSent = false
  await phone(page, () => { imageSent = true })
  await page.goto('/')
  const tabs = page.getByRole('navigation', { name: 'Разделы' })

  await tabs.getByRole('link', { name: /Решения/ }).click()
  await expect(page.getByRole('heading', { name: 'Требует решения' })).toBeVisible()
  await expect(page.getByText(/отклонилась от маршрута/)).toHaveCount(1)
  expect(await sideways(page)).toBe(0)

  await tabs.getByRole('link', { name: 'Auftrag' }).click()
  const camera = page.getByLabel('Снять Auftrag камерой')
  await expect(camera).toHaveAttribute('capture', 'environment')
  await expect(camera).toHaveAttribute('accept', 'image/*')
  await expect(page.getByText('Снять фото')).toBeVisible()
  await camera.setInputFiles({ name: 'auftrag.jpg', mimeType: 'image/jpeg', buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]) })
  await expect.poll(() => imageSent).toBe(true)
  expect(await sideways(page)).toBe(0)

  await tabs.getByRole('link', { name: 'Ещё' }).click()
  await expect(page.getByRole('button', { name: /ИИ-диспетчер/ })).toBeVisible()
  const sections = page.getByRole('navigation', { name: 'Остальные разделы' })
  for (const name of ['Статус 07:00', 'Туры', /Машины и Webfleet/, 'Заказчики', 'Аналитика', /Настройки/]) await expect(sections.getByRole('link', { name })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Выйти' })).toBeVisible()
  // Without VAPID keys on the server the switch says so instead of failing silently.
  await expect(page.getByRole('switch', { name: /Push на этот телефон/ })).toContainText('не настроен на сервере')
  await sections.getByRole('link', { name: 'Туры' }).click()
  await expect(tabs.getByRole('link', { name: 'Ещё' })).toHaveAttribute('aria-current', 'page')
  expect(await sideways(page)).toBe(0)
})
