import { expect, test, type Route } from '@playwright/test'

// These tests work with the list filters and the cover buttons open; the dispatcher's list starts with them folded.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => { try { localStorage.setItem('ops-list-filters', '1') } catch { /* no storage */ } })
})

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
  await expect(toast).toContainText('Уехала без BELADEN')
  // One line: the main button at once, the other answers behind «⋯».
  await toast.getByRole('button', { name: 'Подробности и все кнопки' }).click()
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
  await expect(decisions.locator('.decision-row').first()).toContainText('949')
  await expect(decisions).toContainText('Уехала без BELADEN')
  await expect(decisions).toContainText('с загрузки Erfurt · 15:42 · GPS Webfleet')
  await expect(decisions.getByRole('button', { name: 'BELADEN 15:42' })).toBeVisible()
  await expect(decisions).toContainText('Auftrag 4471 · München 04.11 11:00')
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
  // Nothing to decide: no toast and nothing over the map, the note waits on the bell under «Для сведения».
  await expect(page.locator('.operations-toast')).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Требует решения' })).toHaveCount(0)
  await page.getByRole('button', { name: 'для сведения: 1' }).click()
  const decisions = page.locator('.bell-popover')
  await decisions.getByText('Для сведения').click()
  const card = decisions.getByRole('article').filter({ hasText: 'выехала из города' })
  await expect(card).toContainText('LKW 949 выехала из города — вероятно загружена')
  await expect(card).toContainText(/BELADEN записан автоматически на 15:42 · стояла 47 мин · GPS Webfleet/)
  await card.getByRole('button', { name: 'Отменить BELADEN' }).click()
  await expect.poll(() => reverted).toMatchObject({ reason: expect.stringContaining('Отменено') })
  await expect(decisions.getByRole('article')).toHaveCount(0)
})

test('стоянка не у адреса: прибытие и ENTLADEN записаны сами, точка другого тура перенесена на ворота', async ({ page }) => {
  let reverted = false
  const base = { createdAt: new Date().toISOString(), priority: 'INFO', urgent: false, resolved: false, resolvedReason: null, stackSize: 1 }
  let notifications = [
    { ...base, id: 'n-off', leadId: 'n-off', vehicleId: 'v1', stopId: 'stop-t', type: 'AUTO_STOP_EVENT',
      message: 'LKW 949 стояла 80 мин в 2 км от адреса Grünheide и уехала дальше — вероятно выгружена там.',
      payloadJson: JSON.stringify({ stopType: 'UNLOAD', at: '2026-11-18T10:20:00.000Z', enteredAt: '2026-11-18T09:00:00.000Z', stayMinutes: 80, source: 'WEBFLEET_AUTO',
        offsite: { latitude: 52.41, longitude: 13.79, distanceMeters: 2004 } }) },
    { ...base, id: 'n-gate', leadId: 'n-gate', vehicleId: 'v2', stopId: 'stop-g', type: 'STOP_MOVED_TO_GATE',
      message: 'LKW 125, точка Tesla Manufacturing в туре B-1 перенесена на ворота, где машины стояли при прошлых визитах (2 км от адреса). Маршрут и ETA пересчитаны.',
      payloadJson: JSON.stringify({ stops: ['stop-g'] }) }
  ]
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, '')
    if (path === '/auth/session') return json(route, { authenticated: true, role: 'dispatcher', csrfToken: 'e2e' })
    if (path === '/notifications') return json(route, { notifications })
    if (path === '/stops/stop-t/auto-event/revert') { reverted = true; notifications = notifications.filter((item) => item.id !== 'n-off'); return json(route, { ok: true }) }
    if (path === '/dashboard') return json(route, { vehicles: [
      { vehicle: truck('v1', '949'), statusText: 'MOVING', operationVersion: 1, tour: { id: 't-a', vehicleId: 'v1', orderNumber: 'A-1', status: 'ACTIVE',
        stops: [stop('stop-t', { city: 'Grünheide', arrivedAt: '2026-11-18T09:00:00Z', completedAt: '2026-11-18T10:20:00Z' }), stop('stop-u', { sequence: 2 })] } },
      { vehicle: truck('v2', '125'), statusText: 'MOVING', operationVersion: 1, tour: { id: 't-b', vehicleId: 'v2', orderNumber: 'B-1', status: 'ACTIVE', stops: [stop('stop-g', { city: 'Grünheide' })] } }
    ] })
    if (path.endsWith('/current-position')) return json(route, { status: 'MOVING' })
    return json(route, { error: 'not mocked' }, 404)
  })
  await page.route('https://tile.openstreetmap.org/**', (route) => route.abort())
  page.on('dialog', (dialog) => void dialog.accept())
  await page.goto('/')
  await expect(page.locator('.operations-toast')).toHaveCount(0)
  await page.getByRole('button', { name: 'для сведения: 2' }).click()
  const decisions = page.locator('.bell-popover')
  await decisions.getByText('Для сведения').click()
  const visit = decisions.getByRole('article').filter({ hasText: 'не по адресу' })
  await expect(visit).toContainText('LKW 949 была на точке не по адресу — вероятно выгружена')
  await expect(visit).toContainText(/Стояла 1 ч 20 мин в 2 км от адреса и уехала дальше\. Прибытие 10:00 и ENTLADEN 11:20 записаны автоматически/)
  await expect(visit).toContainText('Место стоянки запомнено как ворота')
  const gate = decisions.getByRole('article').filter({ hasText: 'перенесена на ворота' })
  await expect(gate).toContainText('LKW 125: точка перенесена на ворота завода')
  await visit.getByRole('button', { name: 'Отменить ENTLADEN' }).click()
  await expect.poll(() => reverted).toBe(true)
  await expect(decisions.getByRole('article').filter({ hasText: 'не по адресу' })).toHaveCount(0)
})

test('отклонение от маршрута: маршрут перестроен сам, уведомление только «для сведения»', async ({ page }) => {
  let acked = false
  const note = (rebuilt: boolean) => ({ id: rebuilt ? 'n-told' : 'n-asked', vehicleId: rebuilt ? 'v1' : 'v2', stopId: null, type: 'ROUTE_DEVIATION', createdAt: new Date().toISOString(),
    priority: rebuilt ? 'INFO' : 'ACTION', urgent: false, resolved: false, resolvedReason: null, leadId: rebuilt ? 'n-told' : 'n-asked', stackSize: 1,
    message: rebuilt ? 'LKW 949 поехал по другому маршруту. Новый маршрут построен от позиции GPS: 312 км через A7, A38. ETA 14:20 (было 13:50).'
      : 'LKW 125 отклонилась от маршрута: ≈ 3,1 км от проложенной линии по GPS Webfleet. Посмотрите варианты маршрута.',
    payloadJson: JSON.stringify(rebuilt ? { legId: 'l1', rebuilt: true, distanceMeters: 312_400, live: true } : { legId: 'l2' }) })
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, '')
    if (path === '/auth/session') return json(route, { authenticated: true, role: 'dispatcher', csrfToken: 'e2e' })
    if (path === '/notifications') return json(route, { notifications: acked ? [note(false)] : [note(true), note(false)] })
    if (path === '/notifications/n-told/ack') { acked = true; return json(route, { ok: true }) }
    if (path === '/dashboard') return json(route, { vehicles: [
      { vehicle: truck('v1', '949'), statusText: 'MOVING', operationVersion: 1, tour: { id: 't-a', vehicleId: 'v1', orderNumber: 'A-1', status: 'ACTIVE', stops: [stop('a')] } },
      { vehicle: truck('v2', '125'), statusText: 'MOVING', operationVersion: 1, tour: { id: 't-b', vehicleId: 'v2', orderNumber: 'B-1', status: 'ACTIVE', stops: [stop('b')] } }
    ] })
    if (path.endsWith('/current-position')) return json(route, { status: 'MOVING' })
    return json(route, { error: 'not mocked' }, 404)
  })
  await page.route('https://tile.openstreetmap.org/**', (route) => route.abort())
  await page.goto('/')
  const decisions = page.getByRole('region', { name: 'Требует решения' })
  // The detour nobody could rebuild still asks for the dispatcher: the routes first.
  const asked = decisions.getByRole('article').filter({ hasText: 'тклонилась от маршрута' })
  await expect(asked.locator('.decision-row-action')).toHaveText('Варианты маршрута')
  await asked.getByRole('button', { name: 'Подробности и все кнопки' }).click()
  await expect(asked.locator('.decision-card-actions button')).toHaveText(['Понятно'])
  // The rebuilt one only informs and waits on the bell: «Понятно» first, the other routes stay one click away.
  await expect(decisions.getByRole('article')).toHaveCount(1)
  await page.getByRole('button', { name: 'Требует решения: 1 · для сведения: 1' }).click()
  const bell = page.locator('.bell-popover')
  await bell.getByText('Для сведения').click()
  const told = bell.getByRole('article').filter({ hasText: 'поехал по другому маршруту' })
  await expect(told).toContainText('LKW 949 поехал по другому маршруту')
  await expect(told).toContainText('Новый маршрут построен от позиции GPS: 312 км через A7, A38. ETA 14:20 (было 13:50).')
  await expect(told.locator('.decision-card-actions button')).toHaveText(['Понятно', 'Варианты маршрута'])
  await told.getByRole('button', { name: 'Понятно' }).click()
  await expect(bell.getByRole('article').filter({ hasText: 'поехал по другому маршруту' })).toHaveCount(0)
})
