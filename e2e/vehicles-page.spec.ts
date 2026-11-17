import { expect, test, type Page, type Route } from '@playwright/test'

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

const now = () => new Date().toISOString()
const vehicles = [
  { id: 'v125', vehicleNumber: '125', licensePlate: 'GÖ-FX 125', maxSpeedKmh: 85, customerLineId: 'nord', aSchild: true, appSped: true, servicePhone: '+49 151 1250' },
  { id: 'v140', vehicleNumber: '140', licensePlate: 'GÖ-FX 140', maxSpeedKmh: 85, customerLineId: 'nord', aSchild: false, appSped: false },
  { id: 'v9404', vehicleNumber: '9404', licensePlate: 'NOM-BW 9404', maxSpeedKmh: 80, customerLineId: 'dsv', aSchild: false, appSped: true },
  { id: 'v152', vehicleNumber: '152', licensePlate: 'GÖ-FX 152', maxSpeedKmh: 85, customerLineId: null }
]
const customers = [
  { id: 'c-sn', name: 'Schnellecke', active: true, lines: [{ id: 'nord', name: 'Nord', code: 'NORD', active: true, sortIndex: 1, dispatchers: [{ id: 'd1', name: 'Anna Keller', primary: true }] }] },
  { id: 'c-dsv', name: 'DSV', active: true, lines: [{ id: 'dsv', name: 'DSV', code: 'DSV', active: true, sortIndex: 1, dispatchers: [{ id: 'd2', name: 'Ben Hoffmann', primary: true }] }] }
]
const live = () => ({ source: 'WEBFLEET', stale: false, ageSeconds: 60, checkedAt: now() })
const dashboard = () => ({ vehicles: [
  { vehicle: vehicles[0], statusText: 'MOVING', risk: 'GREEN', telemetry: live(), assignedTo: { id: 'd1', name: 'Anna Keller' }, eta: new Date(Date.now() + 3600_000).toISOString() },
  { vehicle: vehicles[1], statusText: 'IDLE', risk: 'GREEN', telemetry: { source: 'WEBFLEET', stale: true, ageSeconds: 3 * 3600 } },
  { vehicle: vehicles[2], statusText: 'MOVING', risk: 'RED', delayMinutes: 18, telemetry: live(), assignedTo: { id: 'd2', name: 'Ben Hoffmann' } },
  { vehicle: vehicles[3], statusText: 'IDLE', risk: 'GREEN', telemetry: { source: 'CALCULATED', stale: false } }
] })
const webfleet = () => ({ configured: true, lastSnapshotAt: now(), pollingIntervalSeconds: 60, lastError: null,
  summary: { received: 152, matched: 3, rejected: 0, unmatched: [{ objectUid: 'wf-7741', objectNo: 'Trailer 7741', licensePlate: '', ambiguous: false }] },
  details: { drivingTimes: { checkedAt: now(), errorCategory: null, providerErrorCode: null }, vehicles: { checkedAt: now(), errorCategory: null, providerErrorCode: null } } })

async function signedIn(page: Page, theme: 'light' | 'dark' = 'light') {
  const saved: unknown[] = []
  await page.addInitScript((value) => { try { localStorage.setItem('ops-theme', value) } catch { /* private mode */ } }, theme)
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, '')
    const method = route.request().method()
    if (path === '/auth/session') return json(route, { authenticated: true, role: 'admin', csrfToken: 'e2e', dispatcherId: 'd-chef', displayName: 'Chef Admin', onboardingCompletedAt: '2026-11-01T00:00:00Z' })
    if (path === '/notifications') return json(route, { notifications: [] })
    if (path === '/customers') return json(route, { customers })
    if (path === '/vehicles' && method === 'GET') return json(route, vehicles)
    if (path === '/vehicles/v140' && method === 'PATCH') { saved.push(route.request().postDataJSON()); return json(route, vehicles[1]) }
    if (path === '/dashboard') return json(route, dashboard())
    if (path === '/integrations/webfleet/status') return json(route, webfleet())
    if (path === '/integrations/webfleet/bindings') return json(route, [])
    if (path === '/integrations/webfleet/suggestions') return json(route, [])
    return json(route, [])
  })
  await page.route('https://tile.openstreetmap.org/**', (route) => route.abort())
  return saved
}

test('машины: по линиям, GPS и работа видны, Webfleet одной строкой, правка под строкой', async ({ page }) => {
  const saved = await signedIn(page)
  await page.goto('/vehicles')
  await expect(page.getByRole('heading', { name: 'Машины' })).toBeVisible()
  const board = page.getByRole('region', { name: 'Машины' })
  await expect(board.locator('.fleet-group')).toHaveText([/^Schnellecke · Nord2 машины · ведёт Anna Keller/, /^DSV · DSV1 машина · ведёт Ben Hoffmann/, /^Без линии1 машина/])

  const row = (number: string) => board.locator('.fleet-row').filter({ has: page.locator('.fleet-number', { hasText: new RegExp(`^${number}$`) }) })
  await expect(row('125')).toContainText('1 мин назад')
  await expect(row('125')).toContainText('Anna Keller')
  await expect(row('125')).toContainText('A Schild')
  await expect(row('140')).toContainText('устарел · 3 ч')
  await expect(row('140')).toContainText('Без тура')
  await expect(row('140')).toContainText('свободна')
  await expect(row('9404').locator('.fleet-late')).toContainText('опоздание +18 мин')
  await expect(row('9404').locator('.fleet-now')).toHaveText('В пути')
  await expect(row('152')).toContainText('нет GPS')

  // Webfleet is one line; the matching opens on demand.
  const webfleetPanel = page.getByRole('region', { name: 'Подключение Webfleet' })
  await expect(webfleetPanel).toContainText('Webfleet: данные получены')
  await expect(webfleetPanel.getByText('Требуют сопоставления: 1')).toHaveCount(0)
  await webfleetPanel.getByRole('button', { name: /Сопоставление · 1 без машины/ }).click()
  await expect(webfleetPanel.getByText('Требуют сопоставления: 1')).toBeVisible()
  await webfleetPanel.getByRole('button', { name: /Сопоставление/ }).click()

  const filters = page.getByRole('group', { name: 'Показать' })
  await filters.getByRole('button', { name: /Без свежего GPS/ }).click()
  await expect(board.locator('.fleet-row')).toHaveCount(2)
  await filters.getByRole('button', { name: /Без линии/ }).click()
  await expect(board.locator('.fleet-row')).toHaveCount(1)
  await filters.getByRole('button', { name: /Без тура/ }).click()
  await expect(board.locator('.fleet-row')).toHaveCount(2)
  await filters.getByRole('button', { name: /^Все/ }).click()
  await page.getByLabel('Найти машину по номеру, госномеру или телефону').fill('1511250')
  await expect(board.locator('.fleet-row')).toHaveCount(1)
  await page.getByLabel('Найти машину по номеру, госномеру или телефону').fill('')

  // The form waits behind its button; the edit row holds the rare fields.
  await expect(page.getByLabel('Номер машины')).toHaveCount(0)
  await page.getByRole('button', { name: 'Добавить машину' }).click()
  await expect(page.getByLabel('Номер машины')).toBeVisible()
  await page.getByRole('button', { name: 'Отмена' }).click()
  await row('140').getByRole('button', { name: 'Изменить машину 140' }).click()
  await expect(page.getByLabel('Линия заказчика LKW 140')).toHaveValue('nord')
  await expect(page.getByLabel('Служебный телефон LKW 140')).toBeVisible()
  await page.getByRole('form', { name: 'Изменить машину 140' }).getByLabel('Макс. скорость').fill('80')
  await page.getByRole('button', { name: 'Сохранить' }).click()
  await expect.poll(() => saved).toEqual([{ vehicleNumber: '140', licensePlate: 'GÖ-FX 140', maxSpeedKmh: 80 }])
  if (process.env.FLEET_SHOTS) { await row('9404').getByRole('button', { name: 'Изменить машину 9404' }).click(); await page.screenshot({ path: 'test-results/fleet-light.png', fullPage: true }) }
})

for (const theme of ['light', 'dark'] as const) {
  test(`машины на телефоне, ${theme === 'dark' ? 'Ночная смена' : 'дневная тема'}: карточки не вылезают за экран`, async ({ page }) => {
    await page.setViewportSize({ width: 393, height: 851 })
    await signedIn(page, theme)
    await page.goto('/vehicles')
    await expect(page.locator('.fleet-row').first()).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
    for (const card of await page.locator('.fleet-row').all()) {
      const box = (await card.boundingBox())!
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width).toBeLessThanOrEqual(393 + 0.5)
    }
    if (process.env.FLEET_SHOTS) await page.screenshot({ path: `test-results/fleet-phone-${theme}.png`, fullPage: true })
  })
}

test('машины, Ночная смена на компьютере', async ({ page }) => {
  test.skip(!process.env.FLEET_SHOTS, 'only for screenshots')
  await signedIn(page, 'dark')
  await page.goto('/vehicles')
  await page.locator('.fleet-row').filter({ hasText: '140' }).getByRole('button', { name: 'Изменить машину 140' }).click()
  await page.screenshot({ path: 'test-results/fleet-dark.png', fullPage: true })
})
