import { expect, test, type Page, type Route } from '@playwright/test'

// The main screen after the redesign (owner, 18.11.2026): the summary over the map, the questions in a stack,
// «Сообщить заказчику» on a late truck and the Auftrag right on the map.
async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}
const soon = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString()
const stop = (id: string, extra: Record<string, unknown> = {}) => ({ id, tourId: 't187', sequence: 2, type: 'UNLOAD', company: 'Musterwerk Jena', address: 'Werkstraße 1, 07745 Jena', city: 'Jena',
  latitude: 50.92, longitude: 11.58, serviceMinMinutes: 60, serviceMaxMinutes: 120, arrivedAt: null, completedAt: null, appointmentAt: soon(30), ...extra })
const customer = { id: 'c-mw', name: 'Musterwerk', slug: 'MUSTERWERK', color: '#1d4ed8' }
const late = {
  vehicle: { id: 'v187', vehicleNumber: '187', licensePlate: 'GÖ FX 187', maxSpeedKmh: 85 }, customer, line: { id: 'l', code: 'SUED', name: 'Süd' },
  tour: { id: 't187', vehicleId: 'v187', orderNumber: 'FX-48211', status: 'ACTIVE', stops: [stop('s1', { sequence: 1, type: 'LOAD', city: 'Bovenden', completedAt: soon(-200), arrivedAt: soon(-240) }), stop('s2')], legs: [] },
  statusText: 'MOVING', risk: 'RED', eta: soon(70), delayMinutes: 40, remainingKm: 62, mine: true, operationVersion: 1,
  to: stop('s2'), telemetry: { source: 'WEBFLEET', stale: false, ageSeconds: 60, speedKmh: 78 },
  mapPosition: { coordinate: [10.7, 50.95], source: 'WEBFLEET', stale: false, courseDeg: 90, standstill: false }
}
const parked = { vehicle: { id: 'v231', vehicleNumber: '231', licensePlate: 'GÖ FX 231', maxSpeedKmh: 85 }, customer, statusText: 'AT_STOP', risk: 'GREEN', mine: true, operationVersion: 1, dwellMinutes: 110,
  tour: { id: 't231', vehicleId: 'v231', orderNumber: 'FX-1', status: 'ACTIVE', stops: [stop('s3', { tourId: 't231', sequence: 1, type: 'UNLOAD', city: 'Nordhausen', arrivedAt: soon(-110) })], legs: [] },
  currentStop: stop('s3', { tourId: 't231', sequence: 1, city: 'Nordhausen', arrivedAt: soon(-110) }) }
const question = (id: string, vehicleId: string, minutes: number) => ({ id, vehicleId, stopId: 's2', type: 'STOP_DEPARTED', priority: 'ACTION', urgent: true, createdAt: soon(-minutes),
  message: `LKW ${vehicleId} уехала с выгрузки без ENTLADEN`, payloadJson: JSON.stringify({ stopType: 'UNLOAD', leftAt: soon(-minutes) }) })

async function mainScreen(page: Page, notices: unknown[] = []) {
  const recorded: unknown[] = []
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, '')
    if (path === '/auth/session') return json(route, { authenticated: true, role: 'dispatcher', csrfToken: 'e2e', dispatcherId: 'd1', displayName: 'Anna Demo', onboardingCompletedAt: '2026-11-01T00:00:00Z' })
    if (path === '/notifications') return json(route, { notifications: notices })
    if (path === '/dashboard') return json(route, { me: 'd1', vehicles: [late, parked] })
    if (path === '/customers/c-mw') return json(route, { ...customer, category: 'OEM_LOGISTICS', active: true, aliases: [], lines: [], profile: { version: 1, notify: { emails: ['dispo@musterwerk.example'] } }, overview: {} })
    if (path === '/vehicles/v187/customer-notice') { recorded.push(route.request().postDataJSON()); return json(route, { at: new Date().toISOString(), by: 'Anna Demo', channel: 'COPY', stopId: 's2', etaAt: null, delayMinutes: 40 }, 201) }
    if (path.endsWith('/current-position')) return json(route, { status: 'MOVING' })
    return json(route, [])
  })
  await page.route('https://tile.openstreetmap.org/**', (route) => route.abort())
  return recorded
}

test('«Сообщить заказчику»: письмо на немецком с адресом из профиля заказчика, отметка «заказчик уведомлён» в туре', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const recorded = await mainScreen(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/?vehicleId=v187')
  const panel = page.locator('.vehicle-panel')
  await expect(panel).toContainText('опоздание 40 мин')
  await panel.getByRole('button', { name: 'Сообщить заказчику' }).click()
  const dialog = page.getByRole('dialog', { name: 'Сообщить заказчику · LKW 187' })
  await expect(dialog.getByLabel('Кому')).toHaveValue('dispo@musterwerk.example')
  await expect(dialog.getByLabel('Тема')).toHaveValue('Verspätung LKW 187 · Auftrag FX-48211 · Jena')
  await expect(dialog.getByLabel(/Текст/)).toHaveValue(/unser LKW 187 \(GÖ FX 187\) zum Auftrag FX-48211 kommt später als geplant\./)
  await expect(dialog.getByLabel(/Текст/)).toHaveValue(/Mit freundlichen Grüßen\nAnna Demo\nForex GmbH · Disposition/)
  await dialog.getByRole('button', { name: 'Скопировать текст' }).click()
  await expect(dialog.getByRole('status')).toContainText('Отмечено: заказчик уведомлён')
  expect(recorded).toEqual([{ tourId: 't187', stopId: 's2', channel: 'COPY', etaAt: late.eta, delayMinutes: 40, recipients: 1 }])
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('Entladung: Musterwerk Jena, Werkstraße 1, 07745 Jena')
  await dialog.getByRole('button', { name: 'Готово' }).click()
  await expect(dialog).toBeHidden()
  // Not offered to the truck that already stands at its stop.
  await page.locator('.vehicle-card').filter({ hasText: 'LKW 231' }).locator('.vehicle-row-main').click()
  await page.getByRole('button', { name: 'Закрыть карточку' }).click()
  await expect(page.locator('.vehicle-panel').getByRole('button', { name: 'Сообщить заказчику' })).toHaveCount(0)
})

test('сводка над картой: числа смены и фильтр «на точке» одним нажатием', async ({ page }) => {
  await mainScreen(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/?vehicleId=v187')
  const summary = page.getByRole('group', { name: 'Смена: сводка' })
  await expect(summary).toContainText('2машин')
  await expect(summary).toContainText('1опаздывает')
  await expect(summary).toContainText('1на точке')
  await summary.getByRole('button', { name: /на точке/ }).click()
  await expect(page.locator('.fleet-list .vehicle-card')).toHaveCount(1)
  await expect(page.locator('.fleet-list .vehicle-card')).toContainText('LKW 231')
  await expect(page.getByRole('group', { name: 'Фильтр автопарка' }).getByRole('button', { name: /^На точке/ })).toHaveAttribute('aria-pressed', 'true')
})

test('вопросы над картой: два сразу, остальные за «открыть все»; карта и список не перекрыты', async ({ page }) => {
  await mainScreen(page, [question('n1', 'v187', 5), question('n2', 'v231', 10), question('n3', 'v187', 15)])
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/?vehicleId=v187')
  const stack = page.getByRole('region', { name: 'Требует решения' })
  await expect(stack.getByRole('article')).toHaveCount(2)
  await stack.getByRole('button', { name: /ещё 1 вопрос/ }).click()
  await expect(stack.locator('.decision-card:not(.decision-card-nested)')).toHaveCount(3)
  await expect(stack.getByRole('button', { name: 'Свернуть' })).toBeVisible()
  const [list, panel] = await Promise.all([page.locator('.fleet-rail').boundingBox(), stack.boundingBox()])
  expect(list && panel && list.x + list.width < panel.x).toBe(true)
})

test('Auftrag на главной: кнопка рядом с «Адрес» и «Маршрут», файл можно бросить прямо на карту', async ({ page }) => {
  await mainScreen(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/?vehicleId=v187')
  const map = page.getByRole('region', { name: 'Карта выбранного грузовика' })
  await map.getByRole('button', { name: 'Auftrag', exact: true }).click()
  await expect(map.getByText('Добавить Auftrag')).toBeVisible()
  await expect(map.getByText('Перетащите Auftrag сюда')).toBeVisible()
  await map.getByRole('button', { name: 'Auftrag', exact: true }).click()
  await expect(map.getByText('Добавить Auftrag')).toBeHidden()
  // Dragging a file over the map shows where it goes.
  const transfer = await page.evaluateHandle(() => { const data = new DataTransfer(); data.items.add(new File(['x'], 'auftrag.pdf', { type: 'application/pdf' })); return data })
  await page.locator('.dashboard-stage').dispatchEvent('dragover', { dataTransfer: transfer })
  await expect(page.getByText('Отпустите файл: Auftrag откроется на проверку')).toBeVisible()
})
