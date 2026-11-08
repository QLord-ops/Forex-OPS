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
  await expect(withSlot.locator('.vehicle-row-termin')).toHaveText('Termin 04.11 11:00')
  await expect(rows.filter({ hasText: 'LKW 125' }).locator('.vehicle-row-termin')).toHaveCount(0)
  await page.getByRole('group', { name: 'Фильтр автопарка' }).getByRole('button', { name: /^Termin/ }).click()
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
  await expect(toast.getByRole('button', { name: 'Не загружена' })).toBeVisible()
  await expect(toast.getByRole('button', { name: 'Ошибка прибытия' })).toBeVisible()
  await toast.getByRole('button', { name: 'BELADEN 15:42' }).click()
  await expect.poll(() => loaded).toEqual({ timestamp: '2026-11-03T14:42:00.000Z' })
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('на Диспозиции вопросы стоят в «Требует решения», Termin принимается одной кнопкой', async ({ page }) => {
  let applied: unknown = null
  let acked = false
  let notifications = [
    { id: 'n-dep', vehicleId: 'v1', stopId: 'stop-l', type: 'STOP_DEPARTED', createdAt: new Date().toISOString(),
      message: 'LKW 949 уехала с загрузки Erfurt в 15:42 без BELADEN. Загружена?', payloadJson: JSON.stringify({ stopId: 'stop-l', stopType: 'LOAD', leftAt: '2026-11-03T14:42:00.000Z' }) },
    { id: 'n-ter', vehicleId: 'v2', stopId: 'stop-u', type: 'APPOINTMENT_MATCH', createdAt: new Date().toISOString(),
      message: 'Для LKW 125 есть термин: München. Проверьте и привяжите.', payloadJson: JSON.stringify({ pendingId: 'p1', stopId: 'stop-u' }) }
  ]
  const candidate = { stopId: 'stop-u', tourId: 't-b', vehicleId: 'v2', vehicleNumber: '125', licensePlate: null, orderNumber: '4471', tourStatus: 'ACTIVE', planVersion: 3,
    sequence: 1, type: 'UNLOAD', company: null, address: 'München', city: 'München', appointmentAt: null, windowStartAt: null, windowEndAt: null, score: 200, reasons: [] }
  const pending = { id: 'p1', fingerprint: 'f'.repeat(64), documentKind: 'VW_FAHRTENSCHEIN', vehiclePlate: null, company: null, site: null, city: 'München', stopType: 'UNLOAD',
    appointmentAt: '2026-11-04T10:00:00Z', windowStartAt: null, windowEndAt: null, references: [], sourceExcerpt: null, createdAt: new Date().toISOString(),
    match: { status: 'MATCHED', vehicle: { status: 'NO_PLATE' }, candidates: [candidate] } }
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, '')
    if (path === '/auth/session') return json(route, { authenticated: true, role: 'dispatcher', csrfToken: 'e2e' })
    if (path === '/notifications') return json(route, { notifications })
    if (path === '/appointments/pending') return json(route, { items: applied ? [] : [pending] })
    if (path === '/appointments/from-document') { applied = route.request().postDataJSON(); return json(route, { stopId: 'stop-u', vehicleId: 'v2', version: 4 }) }
    if (path === '/notifications/n-ter/ack') { acked = true; notifications = notifications.filter((item) => item.id !== 'n-ter'); return json(route, { ok: true }) }
    if (path === '/dashboard') return json(route, { vehicles: [
      { vehicle: truck('v1', '949'), statusText: 'MOVING', operationVersion: 1, tour: { id: 't-a', vehicleId: 'v1', orderNumber: 'A-1', status: 'ACTIVE', stops: [stop('stop-l', { type: 'LOAD', city: 'Erfurt' })] } },
      { vehicle: truck('v2', '125'), statusText: 'MOVING', operationVersion: 1, tour: { id: 't-b', vehicleId: 'v2', orderNumber: '4471', status: 'ACTIVE', stops: [stop('stop-u')] } }
    ] })
    if (path.endsWith('/current-position')) return json(route, { status: 'MOVING' })
    return json(route, { error: 'not mocked' }, 404)
  })
  await page.route('https://tile.openstreetmap.org/**', (route) => route.abort())
  page.on('dialog', (dialog) => void dialog.accept())
  await page.goto('/')

  const decisions = page.getByRole('region', { name: 'Требует решения' })
  await expect(decisions.getByRole('article')).toHaveCount(2)
  await expect(decisions).toContainText('LKW 949 уехала с загрузки без BELADEN')
  await expect(decisions).toContainText('Erfurt, выезд 15:42 · GPS Webfleet')
  await expect(decisions.getByRole('button', { name: 'BELADEN 15:42' })).toBeVisible()
  await expect(decisions).toContainText('LKW 125 · Auftrag 4471 · München 04.11 11:00')
  // On the dashboard the questions live in the list, not in a toast; the bell counts them.
  await expect(page.locator('.operations-toast')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Требует решения: 2' })).toBeVisible()
  await expect(page.getByRole('group', { name: 'Фильтр автопарка' }).getByRole('button', { name: /^Решить/ })).toContainText('2')

  await decisions.getByRole('button', { name: 'Принять' }).click()
  await expect.poll(() => applied).toMatchObject({ stopId: 'stop-u', version: 3, pendingId: 'p1' })
  await expect.poll(() => acked).toBe(true)
  await expect(decisions.getByRole('article')).toHaveCount(1)
})

test('BELADEN записан сам после выезда из города: уведомление «для сведения» с «Отменить»', async ({ page }) => {
  let reverted: unknown = null
  let notifications = [{ id: 'n-auto', vehicleId: 'v1', stopId: 'stop-l', type: 'AUTO_STOP_EVENT', createdAt: new Date().toISOString(),
    priority: 'INFO', urgent: false, resolved: false, resolvedReason: null, leadId: 'n-auto', stackSize: 1,
    message: 'LKW 949 выехала из Zwickau — вероятно загружена. BELADEN записан автоматически на 15:42 (выезд с точки по GPS Webfleet). Если это ошибка, отмените.',
    payloadJson: JSON.stringify({ stopType: 'LOAD', at: '2026-11-03T14:42:00.000Z', stayMinutes: 47, source: 'WEBFLEET_AUTO' }) }]
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, '')
    if (path === '/auth/session') return json(route, { authenticated: true, role: 'dispatcher', csrfToken: 'e2e' })
    if (path === '/notifications') return json(route, { notifications })
    if (path === '/stops/stop-l/auto-event/revert') { reverted = route.request().postDataJSON(); notifications = []; return json(route, { ok: true }) }
    if (path === '/dashboard') return json(route, { vehicles: [
      { vehicle: truck('v1', '949'), statusText: 'MOVING', operationVersion: 1, tour: { id: 't-a', vehicleId: 'v1', orderNumber: 'A-1', status: 'ACTIVE',
        stops: [stop('stop-l', { type: 'LOAD', city: 'Zwickau', arrivedAt: '2026-11-03T13:55:00Z', completedAt: '2026-11-03T14:42:00Z' }), stop('stop-u', { sequence: 2 })] } }
    ] })
    if (path.endsWith('/current-position')) return json(route, { status: 'MOVING' })
    return json(route, { error: 'not mocked' }, 404)
  })
  await page.route('https://tile.openstreetmap.org/**', (route) => route.abort())
  page.on('dialog', (dialog) => void dialog.accept())
  await page.goto('/')
  // Nothing to decide: no toast, the note waits under «Для сведения».
  await expect(page.locator('.operations-toast')).toHaveCount(0)
  const decisions = page.getByRole('region', { name: 'Требует решения' })
  await decisions.getByText('Для сведения').click()
  const card = decisions.getByRole('article').filter({ hasText: 'выехала из города' })
  await expect(card).toContainText('LKW 949 выехала из города — вероятно загружена')
  await expect(card).toContainText(/BELADEN записан автоматически на 15:42, Zwickau · стояла 47 мин · GPS Webfleet/)
  await card.getByRole('button', { name: 'Отменить BELADEN' }).click()
  await expect.poll(() => reverted).toMatchObject({ reason: expect.stringContaining('Отменено') })
  await expect(decisions.getByRole('article')).toHaveCount(0)
})
