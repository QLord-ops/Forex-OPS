import { expect, test, type Page, type Route } from '@playwright/test'

const vehicle = { id: 'veh-1', vehicleNumber: '125', licensePlate: 'B-OPS125', maxSpeedKmh: 85 }
const loadStop = {
  id: 'stop-load', tourId: 'tour-1', sequence: 1, type: 'LOAD', company: 'Werk A',
  address: 'Werkstraße 1, Berlin', city: 'Berlin', latitude: 52.52, longitude: 13.405,
  serviceMinMinutes: 60, serviceMaxMinutes: 120, arrivedAt: null, completedAt: null,
}
const unloadStop = {
  id: 'stop-unload', tourId: 'tour-1', sequence: 2, type: 'UNLOAD', company: 'Werk B',
  address: 'Industriestraße 2, Potsdam', city: 'Potsdam', latitude: 52.39, longitude: 13.06,
  serviceMinMinutes: 60, serviceMaxMinutes: 120, arrivedAt: null, completedAt: null,
}

function tour(stops = [loadStop, unloadStop], status = 'ACTIVE') {
  return { id: 'tour-1', vehicleId: vehicle.id, orderNumber: 'A-100', status, planVersion: 1, stops, legs: [] }
}

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

async function authenticated(page: Page, handler: (route: Route, path: string) => Promise<boolean>) {
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, '')
    if (path === '/auth/session') return json(route, { authenticated: true, role: 'admin', csrfToken: 'e2e' })
    if (path === '/notifications') return json(route, { notifications: [] })
    if (await handler(route, path)) return
    return json(route, { error: `Unhandled e2e endpoint: ${path}` }, 404)
  })
  await page.route('https://tile.openstreetmap.org/**', route => route.abort())
  await page.route('https://services.arcgisonline.com/**', route => route.abort())
}

test('создаёт Auftrag из импортированного PDF', async ({ page }) => {
  let createdPayload: Record<string, unknown> | null = null
  await authenticated(page, async (route, path) => {
    if (path === '/vehicles' && route.request().method() === 'GET') { await json(route, [vehicle]); return true }
    if (path === '/imports/pdf/preview') {
      await json(route, {
        source: 'RULES', detectedLayout: 'PDF', warnings: [], aiAvailable: false,
        drafts: [{ orderNumber: 'A-200', vehicleNumber: '125', vehiclePlate: null, trailerPlate: 'Z-1', tourRemarks: 'Berlin für Potsdam', warnings: [], stops: [
          { ...loadStop, id: undefined, tourId: undefined, address: loadStop.address, appointmentLocal: null, confidence: 1, sourcePage: 1 },
          { ...unloadStop, id: undefined, tourId: undefined, address: unloadStop.address, appointmentLocal: null, confidence: 1, sourcePage: 1 },
        ] }],
      }); return true
    }
    if (path === '/geocode' || path === '/geocode/resolve') {
      const requestBody = route.request().postDataJSON() as { address?: string } | null
      const address = new URL(route.request().url()).searchParams.get('address') ?? requestBody?.address ?? ''
      await json(route, { address, latitude: address.includes('Potsdam') ? 52.39 : 52.52, longitude: address.includes('Potsdam') ? 13.06 : 13.405, city: address.includes('Potsdam') ? 'Potsdam' : 'Berlin', provider: 'e2e' }); return true
    }
    if (path === '/imports/tours/confirm' && route.request().method() === 'POST') {
      createdPayload = route.request().postDataJSON() as Record<string, unknown>
      await json(route, { tour: { ...tour(), orderNumber: 'A-200' }, created: true, reused: false }, 201); return true
    }
    if (path.startsWith('/vehicles/veh-1')) { await json(route, path.endsWith('/tours') ? [tour()] : vehicle); return true }
    return false
  })

  await page.goto('/orders/new')
  await page.getByRole('main').locator('input[type="file"]').setInputFiles({ name: 'auftrag.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7 e2e') })
  await expect(page.getByLabel('Номер Auftrag')).toHaveValue('A-200')
  await page.getByRole('button', { name: 'Подтвердить', exact: true }).click()
  await expect.poll(() => createdPayload).not.toBeNull()
  // An imported Auftrag goes through the idempotent confirm, so a retry never creates it twice.
  expect(createdPayload).toMatchObject({ vehicleId: 'veh-1', orderNumber: 'A-200', importAttemptId: expect.stringMatching(/:0$/), importFingerprint: expect.stringMatching(/^auftrag-/) })
})

test('прибытие ставит только GPS: ручной кнопки прибытия нет', async ({ page }) => {
  const activeTour = tour()
  await authenticated(page, async (route, path) => {
    if (path === '/vehicles/veh-1') { await json(route, vehicle); return true }
    if (path === '/vehicles/veh-1/tours') { await json(route, [activeTour]); return true }
    if (path === '/vehicles/veh-1/timeline') { await json(route, { vehicle, tours: [activeTour], items: [] }); return true }
    if (path === '/vehicles/veh-1/current-position') { await json(route, { vehicleId: vehicle.id, tourId: activeTour.id, status: 'ARRIVED', coordinate: [13.405, 52.52] }); return true }
    if (path === '/vehicles/veh-1/operations') { await json(route, { vehicleId: vehicle.id, version: 1, clock: null, preliminary: true, manualStoppedAt: null, position: { status: 'ARRIVED' }, currentStop: loadStop, dwellMinutes: null, clockProposals: [], traffic: null }); return true }
    return false
  })
  await page.goto('/vehicles/veh-1')
  await expect(page.getByText('отметится само по GPS Webfleet')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Подтвердить прибытие' })).toHaveCount(0)
})

test('фиксирует BELADEN после прибытия', async ({ page }) => {
  let loaded = false
  const arrivedStop = { ...loadStop, arrivedAt: '2026-10-30T08:00:00.000Z' }
  const activeTour = tour([arrivedStop, unloadStop])
  await authenticated(page, async (route, path) => {
    if (path === '/vehicles/veh-1') { await json(route, vehicle); return true }
    if (path === '/vehicles/veh-1/tours') { await json(route, [activeTour]); return true }
    if (path === '/vehicles/veh-1/timeline') { await json(route, { vehicle, tours: [activeTour], items: [] }); return true }
    if (path === '/vehicles/veh-1/current-position') { await json(route, { vehicleId: vehicle.id, tourId: activeTour.id, status: 'ARRIVED', coordinate: [13.405, 52.52] }); return true }
    if (path === '/vehicles/veh-1/operations') { await json(route, { vehicleId: vehicle.id, version: 1, clock: null, preliminary: true, manualStoppedAt: null, position: { status: 'ARRIVED' }, currentStop: arrivedStop, dwellMinutes: 15, clockProposals: [], traffic: null }); return true }
    if (path === '/stops/stop-load/loaded') { loaded = route.request().postDataJSON(); await json(route, activeTour); return true }
    return false
  })
  await page.goto('/vehicles/veh-1')
  await page.getByRole('button', { name: 'ЗАГРУЖЕНО' }).evaluate((element: HTMLButtonElement) => element.click())
  // One click only opens the dialog: history is written after the time is confirmed.
  const dialog = page.getByRole('dialog', { name: /BELADEN/ })
  await expect(dialog).toBeVisible()
  expect(loaded).toBe(false)
  await dialog.locator('input[type="datetime-local"]').fill('2026-10-30T09:15')
  await dialog.getByRole('button', { name: 'Подтвердить' }).click()
  await expect.poll(() => loaded).toMatchObject({ timestamp: expect.stringContaining('2026-10-30T') })
  await expect(dialog).toHaveCount(0)
})

test('после истечения сессии вход поверх приложения сохраняет введённое', async ({ page }) => {
  let expired = false
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, '')
    if (path === '/auth/session') return json(route, { authenticated: true, role: 'dispatcher', csrfToken: 'e2e' })
    if (path === '/auth/login') { expired = false; return json(route, { authenticated: true, role: 'dispatcher', csrfToken: 'e2e-2' }) }
    if (expired) return json(route, { error: 'Войдите в диспетчерскую.' }, 401)
    if (path === '/notifications') return json(route, { notifications: [] })
    if (path === '/dashboard') return json(route, { vehicles: [{ vehicle, tour: tour(), statusText: 'MOVING', operationVersion: 1 }] })
    if (path === '/vehicles') return json(route, [vehicle])
    if (path.endsWith('/current-position')) return json(route, { status: 'MOVING', coordinate: [13.4, 52.5] })
    return json(route, [])
  })
  await page.route('https://tile.openstreetmap.org/**', route => route.abort())
  await page.goto('/')
  const search = page.getByPlaceholder('LKW, Auftrag или город')
  await search.fill('125')
  expired = true
  await expect(page.getByRole('dialog', { name: 'Сессия истекла, войдите снова' })).toBeVisible({ timeout: 15_000 })
  await page.locator('#dispatcher-password').fill('e2e-test-password')
  await page.getByRole('button', { name: 'SIGN IN' }).click()
  await expect(page.getByRole('dialog', { name: 'Сессия истекла, войдите снова' })).toHaveCount(0)
  await expect(search).toHaveValue('125')
})

test('закреплённая машина стоит первой даже без срочных событий', async ({ page }) => {
  const other = { id: 'veh-2', vehicleNumber: '200', licensePlate: 'B-OPS200', maxSpeedKmh: 85 }
  await page.addInitScript(() => window.localStorage.setItem('ops-dashboard-pinned-vehicles', JSON.stringify(['veh-1'])))
  await authenticated(page, async (route, path) => {
    if (path === '/dashboard') {
      await json(route, { vehicles: [
        { vehicle, tour: null, statusText: 'IDLE', operationVersion: 1 },
        { vehicle: other, tour: tour(), statusText: 'MOVING', delayMinutes: 90, risk: 'RED', warning: 'RED', operationVersion: 1 }
      ] }); return true
    }
    if (path === '/vehicles') { await json(route, [vehicle, other]); return true }
    if (path.endsWith('/current-position')) { await json(route, { status: 'IDLE' }); return true }
    return false
  })
  await page.goto('/')
  const cards = page.locator('.fleet-list .vehicle-card')
  await expect(cards).toHaveCount(2)
  await expect(cards.first()).toContainText('LKW 125')
  await expect(page.getByRole('button', { name: 'Все' })).toHaveAttribute('aria-pressed', 'true')
})

test('редактирует будущий тур', async ({ page }) => {
  let updatedPayload: Record<string, unknown> | null = null
  const queued = { ...tour([loadStop, unloadStop], 'QUEUED'), id: 'tour-2', orderNumber: 'A-300' }
  await authenticated(page, async (route, path) => {
    if (path === '/vehicles') { await json(route, [vehicle]); return true }
    if (path === '/tours/tour-2' && route.request().method() === 'GET') { await json(route, queued); return true }
    if (path === '/tours/tour-2' && route.request().method() === 'PATCH') { updatedPayload = route.request().postDataJSON() as Record<string, unknown>; await json(route, { ...queued, orderNumber: 'A-301' }); return true }
    if (path === '/tours') { await json(route, [queued]); return true }
    return false
  })
  await page.goto('/tours/tour-2/edit')
  await page.getByLabel('Номер заказа').fill('A-301')
  await page.getByRole('button', { name: 'Сохранить изменения' }).click()
  await expect.poll(() => updatedPayload).not.toBeNull()
  // Stop ids and the plan version let the server keep LDM/references and reject a stale edit.
  expect(updatedPayload).toMatchObject({ vehicleId: 'veh-1', orderNumber: 'A-301', version: 1, stops: [{ id: 'stop-load' }, { id: 'stop-unload' }] })
})

test('показывает причину ошибки Webfleet и привязывает объект к грузовику', async ({ page }) => {
  let bound: Record<string, unknown> | null = null
  const status = (unmatched: unknown[]) => ({
    configured: true, mode: 'READ_ONLY', pollingIntervalSeconds: 60, lastSnapshotAt: new Date().toISOString(),
    summary: { received: 1, matched: 0, rejected: 0, unmatched, lastError: 'SYNC_FAILED', errorCategory: 'AUTH', providerErrorCode: 1101 },
    lastError: 'SYNC_FAILED', errorCategory: 'AUTH', providerErrorCode: 1101, retryAfter: new Date(Date.now() + 30 * 60_000).toISOString(),
  })
  const binding = { vehicleId: vehicle.id, vehicleNumber: vehicle.vehicleNumber, licensePlate: vehicle.licensePlate, objectUid: 'wf-125', objectNo: 'LKW 125', externalPlate: null, status: 'ACTIVE', boundAt: new Date().toISOString() }
  await authenticated(page, async (route, path) => {
    if (path === '/vehicles' && route.request().method() === 'GET') { await json(route, [vehicle]); return true }
    if (path === '/integrations/webfleet/status') { await json(route, status(bound ? [] : [{ objectUid: 'wf-125', objectNo: 'LKW 125', licensePlate: '', ambiguous: false }])); return true }
    if (path === '/integrations/webfleet/bindings' && route.request().method() === 'GET') { await json(route, bound ? [binding] : []); return true }
    if (path === '/integrations/webfleet/suggestions') { await json(route, []); return true }
    if (path === '/integrations/webfleet/bindings' && route.request().method() === 'POST') {
      bound = route.request().postDataJSON() as Record<string, unknown>
      await json(route, [binding]); return true
    }
    return false
  })

  await page.goto('/vehicles')
  const panel = page.getByRole('region', { name: 'Подключение Webfleet' })
  await expect(panel.getByText('Webfleet отклонил вход')).toBeVisible()
  await expect(panel.getByText('Код Webfleet: 1101.')).toBeVisible()

  await panel.getByText('Требуют сопоставления: 1').click()
  await panel.getByRole('combobox', { name: 'Грузовик OPS для LKW 125' }).selectOption(vehicle.id)
  await panel.getByRole('button', { name: 'Привязать' }).click()

  await expect.poll(() => bound).toMatchObject({ objectUid: 'wf-125', vehicleId: vehicle.id, objectNo: 'LKW 125' })
  await expect(panel.getByText('Привязанные машины: 1')).toBeVisible()
  await expect(panel.getByText('Требуют сопоставления')).toHaveCount(0)
})

test.describe('окно «Маршрут»', () => {
  const vehicles = [vehicle, { id: 'veh-2', vehicleNumber: '2868', licensePlate: 'GÖ-FX 2868', maxSpeedKmh: 85 }]
  const scenario = (stops: Array<{ address: string }>, vehicleNumber: string | null) => ({
    vehicleId: vehicleNumber ? 'veh-1' : null, vehicleNumber, generatedAt: '2026-11-01T10:00:00Z',
    startRange: { earliest: '2026-11-01T10:00:00Z', latest: '2026-11-01T10:00:00Z' },
    completion: { earliest: '2026-11-01T13:00:00Z', latest: '2026-11-01T13:30:00Z' },
    finishToday: 'UNKNOWN', preliminary: true, requiresDailyRest: false, distanceMeters: 245000,
    geometry: [[13.4, 52.5], [12, 51.5], [10, 51]], routingProviders: ['tomtom'],
    warnings: ['Не заполнены исходные часы машины. Прогноз предварительный.'],
    stops: stops.map((stop, index) => ({ address: stop.address, type: 'VISIT', coords: { latitude: 51 + index * 0.1, longitude: 10 + index * 0.1 },
      earliestArrival: '2026-11-01T12:00:00Z', latestArrival: '2026-11-01T12:30:00Z', earliestDeparture: null, latestDeparture: null,
      risk: 'UNKNOWN', serviceMinMinutes: 0, serviceMaxMinutes: 0 })),
    downstreamQueueImpact: []
  })

  async function openRouteWindow(page: Page, requests: Array<Record<string, unknown>>) {
    await authenticated(page, async (route, path) => {
      if (path === '/dashboard') { await json(route, { vehicles: vehicles.map((item) => ({ vehicle: item, tour: null, statusText: 'Свободен' })) }); return true }
      if (path === '/vehicles' && route.request().method() === 'GET') { await json(route, vehicles); return true }
      if (path === '/route-scenarios/preview') {
        const body = route.request().postDataJSON() as Record<string, unknown>
        requests.push(body)
        await json(route, scenario(body.stops as Array<{ address: string }>, body.vehicleId ? '125' : null)); return true
      }
      if (path.startsWith('/vehicles/')) { await json(route, path.endsWith('/current-position') ? { position: null } : []); return true }
      return false
    })
    await page.goto('/')
    await page.getByRole('button', { name: 'Маршрут', exact: true }).first().click()
    return page.getByRole('form', { name: 'Построить маршрут' })
  }

  test('строит маршрут от машины по номеру и показывает ETA без технических кодов', async ({ page }) => {
    const requests: Array<Record<string, unknown>> = []
    const form = await openRouteWindow(page, requests)
    await form.getByLabel('Старт: номер машины или адрес').fill('125')
    await expect(form.getByText('LKW 125 · B-OPS125 · от текущей позиции')).toBeVisible()
    await form.getByLabel('Конечный адрес').fill('Kassel')
    await form.getByRole('button', { name: 'Проложить маршрут' }).click()
    await expect.poll(() => requests.length).toBe(1)
    expect(requests[0]).toMatchObject({ vehicleId: 'veh-1', startMode: 'NOW', includeQueueImpact: false, stops: [{ address: 'Kassel' }] })
    await expect(form.getByText('245 км')).toBeVisible()
    await expect(form.getByText('TomTom · с учётом пробок · старт LKW 125')).toBeVisible()
    await expect(form.getByText(/[A-Z]{3,}_[A-Z_]+/)).toHaveCount(0)
  })

  test('добавляет до 10 точек и строит свободный маршрут от адреса', async ({ page }) => {
    const requests: Array<Record<string, unknown>> = []
    const form = await openRouteWindow(page, requests)
    await form.getByLabel('Старт: номер машины или адрес').fill('37120 Bovenden')
    await expect(form.getByText('Адрес старта')).toBeVisible()
    const add = form.getByRole('button', { name: 'Добавить точку' })
    for (let index = 0; index < 8; index += 1) await add.click()
    await expect(form.getByRole('button', { name: 'Максимум 10 точек' })).toBeDisabled()
    const inputs = form.locator('.route-point input')
    await expect(inputs).toHaveCount(10)
    for (let index = 1; index < 10; index += 1) await inputs.nth(index).fill(`Ort ${index + 1}`)
    await form.getByRole('button', { name: 'Проложить маршрут' }).click()
    await expect.poll(() => requests.length).toBe(1)
    expect(requests[0]).toMatchObject({ originAddress: '37120 Bovenden' })
    expect((requests[0].stops as Array<{ address: string }>).map((stop) => stop.address)).toEqual(Array.from({ length: 9 }, (_, index) => `Ort ${index + 2}`))
    await expect(page.locator('.preview-stop-marker')).toHaveCount(9)
  })

  test('меняет точки местами удержанием ручки и клавиатурой', async ({ page }) => {
    const requests: Array<Record<string, unknown>> = []
    const form = await openRouteWindow(page, requests)
    await form.getByLabel('Старт: номер машины или адрес').fill('Berlin')
    await form.getByRole('button', { name: 'Добавить точку' }).click()
    const inputs = form.locator('.route-point input')
    await inputs.nth(1).fill('Hamburg')
    await inputs.nth(2).fill('München')

    // Press and hold the handle of point 3, then drag it above point 2.
    const handle = form.getByRole('button', { name: 'Перетащить точку 3' })
    const target = form.getByRole('button', { name: 'Перетащить точку 2' })
    const from = await handle.boundingBox(), to = await target.boundingBox()
    await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2)
    await page.mouse.down()
    await page.waitForTimeout(300)
    await page.mouse.move(to!.x + to!.width / 2, to!.y + to!.height / 2 - 6, { steps: 12 })
    await page.mouse.up()
    await expect(inputs.nth(1)).toHaveValue('München')
    await expect(inputs.nth(2)).toHaveValue('Hamburg')

    // Keyboard: focus handle 2, Space, ArrowDown, Space.
    await form.getByRole('button', { name: 'Перетащить точку 2' }).focus()
    await page.keyboard.press('Space')
    await page.waitForTimeout(150)
    await page.keyboard.press('ArrowDown')
    await page.waitForTimeout(250)
    await page.keyboard.press('Space')
    await expect(inputs.nth(1)).toHaveValue('Hamburg')
    await expect(inputs.nth(2)).toHaveValue('München')

    await form.getByRole('button', { name: 'Проложить маршрут' }).click()
    await expect.poll(() => requests.length).toBe(1)
    expect(requests[0]).toMatchObject({ originAddress: 'Berlin', stops: [{ address: 'Hamburg' }, { address: 'München' }] })
  })

  test('не даёт поставить машину не первой точкой', async ({ page }) => {
    const requests: Array<Record<string, unknown>> = []
    const form = await openRouteWindow(page, requests)
    await form.getByLabel('Старт: номер машины или адрес').fill('Berlin')
    await form.getByLabel('Конечный адрес').fill('LKW 125')
    await form.getByRole('button', { name: 'Проложить маршрут' }).click()
    await expect(form.getByRole('alert')).toContainText('Машину можно указать только первой точкой')
    expect(requests).toHaveLength(0)
  })
})

test('уведомление об автоприбытии по GPS позволяет отменить прибытие', async ({ page }) => {
  let reverted: Record<string, unknown> | null = null
  let notifications = [{ id: 'n-auto', vehicleId: vehicle.id, stopId: 'stop-load', type: 'AUTO_ARRIVAL',
    message: 'Webfleet: LKW 125 прибыла на загрузку, Berlin, в 14:32 (автоматически по GPS). Если это ошибка, отмените прибытие.', createdAt: '2026-11-02T13:32:00Z' }]
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, '')
    if (path === '/auth/session') return json(route, { authenticated: true, role: 'dispatcher', csrfToken: 'e2e' })
    if (path === '/notifications') return json(route, { notifications })
    if (path === '/stops/stop-load/arrival/revert') { reverted = route.request().postDataJSON() as Record<string, unknown>; notifications = []; return json(route, { ok: true }) }
    if (path === '/vehicles' || path === '/dashboard') return json(route, path === '/dashboard' ? { vehicles: [] } : [vehicle])
    return json(route, [])
  })
  await page.route('https://tile.openstreetmap.org/**', route => route.abort())
  page.on('dialog', dialog => void dialog.accept())

  await page.goto('/vehicles')
  const toast = page.getByRole('dialog')
  await expect(toast).toContainText('автоматически по GPS')
  await expect(toast.getByRole('button', { name: 'Подтвердить прибытие' })).toHaveCount(0)
  await toast.getByRole('button', { name: 'Отменить прибытие' }).click()
  await expect.poll(() => reverted).toMatchObject({ reason: 'Отменено из уведомления об автоприбытии' })
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('показывает пробки на маршруте выбранной машины', async ({ page }) => {
  const line = Array.from({ length: 20 }, (_, i) => [9.95 + i * 0.05, 51.5 - i * 0.04])
  await authenticated(page, async (route, path) => {
    if (path === '/dashboard') { await json(route, { vehicles: [{ vehicle, tour: tour(), statusText: 'MOVING', operationVersion: 1 }] }); return true }
    if (path === '/vehicles') { await json(route, [vehicle]); return true }
    if (path.endsWith('/current-position')) {
      await json(route, { state: 'UNTERWEGS', status: 'MOVING', positionSource: 'CALCULATED', coordinate: line[5], position: { latitude: line[5][1], longitude: line[5][0] },
        tourId: 'tour-1', legId: 'leg-1', geometryVersion: 'leg-1:a', routeGeometry: line, travelledGeometry: line.slice(0, 6), remainingGeometry: line.slice(5),
        trafficSegments: [{ from: 8, to: 12, level: 'JAM', delaySeconds: 720, speedKmh: 15 }, { from: 14, to: 16, level: 'SLOW', delaySeconds: 20, speedKmh: 60 }], trafficCheckedAt: new Date().toISOString() }); return true
    }
    if (path.startsWith('/vehicles/veh-1')) { await json(route, []); return true }
    return false
  })
  await page.route('https://api.tomtom.com/**', route => route.abort())
  await page.goto('/?vehicleId=veh-1')
  const legend = page.getByRole('note', { name: 'Пробки на маршруте' })
  await expect(legend).toContainText('пробка')
  await expect(legend).toContainText('медленно')
  await expect(legend).not.toContainText('стоит')

  // Every jam gets an icon with the time it costs, the short slow-down too.
  const icons = page.getByRole('button', { name: /Подробнее о пробке/ })
  await expect(icons).toHaveCount(2)
  await expect(icons.first()).toContainText('+12 мин')
  await expect(icons.nth(1)).toContainText('<1 мин')
  await icons.first().click()
  const details = page.locator('.traffic-incident-details')
  await expect(details.locator('header')).toContainText('Пробка')
  await expect(details.getByLabel('Задержка +12 мин')).toHaveText('+12 мин')
  await expect(details).toContainText('Скорость~15 км/ч')
  await expect(details).toContainText('До пробки')
  await page.keyboard.press('Escape')
  await expect(details).toHaveCount(0)
})

test('карточка машины: компактная строка, вкладки как в телематике, открытие из списка и с карты', async ({ page }) => {
  const other = { id: 'veh-2', vehicleNumber: '7448', licensePlate: 'B-CY7448', maxSpeedKmh: 85 }
  const now = Date.now()
  const at = (minutes: number) => new Date(now + minutes * 60_000).toISOString()
  // Values of B CY 2803 from the dispatcher's Webfleet screenshot.
  const card = (id: string, number: string, plate: string) => ({
    vehicleId: id, vehicleNumber: number, licensePlate: plate, currentTrailerPlate: 'B-TR 1', generatedAt: at(0),
    webfleet: { objectNo: plate, objectName: 'MB', plate, vin: 'WDB0000000TEST001', tankLiters: 880, objectType: 'heavy_truck' },
    current: { recordedAt: at(-1), ageSeconds: 60, stale: false, usable: true, coordinate: [9.95, 51.6], address: '06268 Obhausen, DE',
      speedKmh: 84, courseDeg: 121, standstill: false, ignitionOn: true, ignitionChangedAt: at(-110), fuelPercent: 15, fuelLiters: 132,
      odometerKm: 1566.9, engineHours: 33.35, businessTrip: true },
    coupling: { status: 'OK', assetUid: null, assetNo: null, coupledAt: null },
    driver: { status: 'SIGNED_ON', name: 'Max Mustermann', workState: 5, activitySince: at(-66), checkedAt: at(0), drivingTimesStatus: 'OK', optiDrive: 7.98,
      drivingTimes: { referenceTime: at(-1), remainDrivingTodayMs: 24_360_000, totalDrivingTodayMs: 11_640_000, totalOtherWorkTodayMs: 5_640_000, totalAvailabilityTodayMs: 0,
        maxDrivingTodayMs: 36_000_000, remainDrivingWeekMs: 172_440_000, maxDrivingWeekMs: 201_600_000, shiftStartedAt: at(-320), latestShiftEndAt: at(580),
        nextBreakAt: at(74), nextBreakMinMs: 1_800_000, nextRestAt: at(579), nextRestMinMs: 32_400_000, earliestNextShiftAt: at(540),
        extendedShiftsUsed: 0, maxExtendedShifts: 2, reducedRestsUsed: 1, maxReducedRests: 3, restBalances: [], infringements: false, lastCardActivityAt: at(-319) } },
    events: { status: 'OK', unresolved: 1, items: [{ id: 'e1', at: at(-70), level: 'ALARM', text: 'Превышение скорости', address: 'A38', resolved: false }] },
    trips: { status: 'OK', items: [
      { id: 't2', startAt: at(-60), endAt: null, startAddress: 'Lindenstraße, 37355 Niederorschel', endAddress: null, distanceKm: null, businessTrip: true },
      { id: 't1', startAt: at(-330), endAt: at(-152), startAddress: 'BASE Northeim', endAddress: 'Lindenstraße, 37355 Niederorschel', distanceKm: 99, businessTrip: true }
    ] },
    maintenance: { status: 'OK', items: [] }
  })
  const cardRequests: string[] = []
  await authenticated(page, async (route, path) => {
    if (path === '/dashboard') {
      await json(route, { vehicles: [
        { vehicle, tour: tour(), statusText: 'ARRIVED', operationVersion: 1, currentAction: { type: 'MARK_LOADED', label: 'BELADEN', stopId: 'stop-load' },
          telemetry: { source: 'WEBFLEET', checkedAt: at(-1), stale: false, ageSeconds: 60, speedKmh: 84, standstill: false, courseDeg: 121, address: '06268 Obhausen, DE', objectNo: 'B CY 2803', objectName: 'MB', usable: true },
          mapPosition: { coordinate: [13.4, 52.5], source: 'WEBFLEET', stale: false, courseDeg: 90, standstill: false } },
        { vehicle: other, tour: null, statusText: 'IDLE', operationVersion: 1, mapPosition: { coordinate: [9.95, 51.6], source: 'WEBFLEET', stale: false, courseDeg: 45, standstill: false } }
      ] }); return true
    }
    if (path === '/vehicles') { await json(route, [vehicle, other]); return true }
    if (path.endsWith('/card')) {
      cardRequests.push(path)
      await json(route, path.includes('veh-2') ? card('veh-2', '7448', 'B CY 7448') : card('veh-1', '125', 'B CY 2803')); return true
    }
    if (path.endsWith('/track')) { await json(route, { checkedAt: at(0), points: [[9.9, 51.5], [9.95, 51.6]] }); return true }
    if (path.endsWith('/current-position')) {
      const [longitude, latitude] = path.includes('veh-2') ? [9.95, 51.6] : [13.4, 52.5]
      await json(route, { status: 'MOVING', positionSource: 'WEBFLEET', coordinate: [longitude, latitude], position: { latitude, longitude } }); return true
    }
    if (path.startsWith('/vehicles/')) { await json(route, []); return true }
    return false
  })
  await page.goto('/?vehicleId=veh-1')
  await page.evaluate(() => window.localStorage.removeItem('ops-truck-card-tab'))

  // Three-line row: number and plate, status and place, the position source as a tag, and the dispatcher's action.
  const row125 = page.locator('.vehicle-card').filter({ hasText: 'LKW 125' })
  await expect(row125.locator('.vehicle-row-title')).toHaveText(/LKW 125\s*B CY 2803/)
  await expect(row125.locator('.vehicle-row-line')).toContainText('06268 Obhausen')
  await expect(row125.locator('.source-tag')).toHaveText(/^GPS/)
  await expect(row125.getByRole('button', { name: 'BELADEN' })).toBeVisible()
  await row125.locator('.vehicle-row-main').click()
  const dialog = page.getByRole('dialog', { name: 'B CY 2803' })
  await expect(dialog.getByRole('heading', { name: 'B CY 2803' })).toBeFocused()
  await expect(dialog.getByRole('tab', { name: 'Машина' })).toHaveAttribute('aria-selected', 'true')
  await expect(dialog).toContainText('Едет 84 км/ч, на юго-восток')
  await expect(dialog).toContainText('Служебная поездка')
  await expect(dialog).toContainText('15 % · ~132 л')
  await expect(dialog).toContainText('1 567 км')
  await expect(dialog).toContainText('GPS · 1 мин')

  await dialog.getByRole('tab', { name: 'Машина' }).focus()
  await page.keyboard.press('ArrowRight')
  await expect(dialog.getByRole('tab', { name: 'Водитель' })).toBeFocused()
  await expect(dialog.getByRole('tab', { name: 'Водитель' })).toHaveAttribute('aria-selected', 'true')
  await expect(dialog).toContainText('Max Mustermann')
  await expect(dialog).toContainText(/по тахографу · с \d\d:\d\d \(1 ч 6 мин\)/)
  await expect(dialog.getByRole('meter', { name: 'Остаток вождения' }).first()).toHaveAttribute('aria-valuetext', '6 ч 46 мин из 10 ч')
  await expect(dialog).toContainText('Рабочее время всего4 ч 48 мин')
  await expect(dialog).toContainText(/Следующий перерывдо (\d\d\.\d\d, )?\d\d:\d\d \(не меньше 30 мин\)/)
  await expect(dialog).toContainText(/Ежедневный отдыхдо .*\d\d:\d\d \(не меньше 9 ч\)/)
  await expect(dialog.getByRole('meter', { name: 'Остаток вождения' }).nth(1)).toHaveAttribute('aria-valuetext', '47 ч 54 мин из 56 ч')
  await expect(dialog.getByLabel('Удлинённое вождение: доступно 2 из 2')).toBeVisible()
  await expect(dialog.getByLabel('Удлинённый рабочий день: доступно 2 из 3')).toBeVisible()
  await expect(dialog.getByRole('meter', { name: 'За 7 дней' })).toHaveAttribute('aria-valuetext', '7,98 из 10')

  await dialog.getByRole('tab', { name: /События/ }).click()
  await expect(dialog.locator('.truck-card-event-alarm')).toContainText('Тревога')
  await expect(dialog).toContainText('Превышение скорости')
  await dialog.getByRole('tab', { name: 'Поездки' }).click()
  await expect(dialog).toContainText('Стоянка 1 ч 32 мин')
  await expect(dialog).toContainText('поездка продолжается')
  await expect(dialog).toContainText('99 км · служебная')

  // The track sits in the tab row; the card has no footer and no «Открыть LKW» any more.
  await expect(dialog.getByRole('link', { name: /Открыть LKW/ })).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Трек', exact: true }).click()
  await expect(dialog.getByRole('button', { name: 'Трек', exact: true })).toHaveAttribute('aria-pressed', 'true')

  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(row125.locator('.vehicle-row-main')).toBeFocused()

  await page.locator('.vehicle-card').filter({ hasText: 'LKW 7448' }).locator('.vehicle-row-main').click()
  await expect(page.getByRole('dialog', { name: 'B CY 7448' })).toBeVisible()
  // The last opened tab is remembered for the next truck.
  await expect(page.getByRole('dialog').getByRole('tab', { name: 'Поездки' })).toHaveAttribute('aria-selected', 'true')
  await page.getByRole('button', { name: 'Закрыть карточку' }).click()

  // veh-2 is selected now, so the fleet layer shows truck 125 as a small marker; it is a button, so the keyboard works too.
  // The map is still fitted to the track, so the marker may be off screen: open it from the keyboard.
  await page.getByRole('button', { name: /LKW 125: .*GPS, едет\. Открыть карточку/ }).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog', { name: 'B CY 2803' })).toBeVisible()
  expect(cardRequests).toEqual(expect.arrayContaining(['/vehicles/veh-1/card', '/vehicles/veh-2/card']))
})

test.describe('этап машины в точках маршрута', () => {
  const thirdStop = { ...unloadStop, id: 'stop-3', sequence: 3, city: 'Leipzig', address: 'Hafenstraße 3, Leipzig', latitude: 51.34, longitude: 12.37 }
  const line = Array.from({ length: 10 }, (_, i) => [13.4 - i * 0.03, 52.5 - i * 0.01])

  async function openDashboard(page: Page, stops: typeof loadStop[], status: string, progress: number) {
    await authenticated(page, async (route, path) => {
      if (path === '/dashboard') { await json(route, { vehicles: [{ vehicle, tour: tour(stops), statusText: status, remainingKm: 35, eta: new Date(Date.now() + 3_600_000).toISOString(), operationVersion: 1 }] }); return true }
      if (path === '/vehicles') { await json(route, [vehicle]); return true }
      if (path.endsWith('/current-position')) {
        await json(route, { state: 'UNTERWEGS', status, progress, positionSource: 'CALCULATED', coordinate: line[4], position: { latitude: line[4][1], longitude: line[4][0] },
          tourId: 'tour-1', legId: 'leg-1', geometryVersion: 'leg-1:a', routeGeometry: line, travelledGeometry: line.slice(0, 5), remainingGeometry: line.slice(4) }); return true
      }
      if (path.startsWith('/vehicles/veh-1')) { await json(route, []); return true }
      return false
    })
    await page.goto('/?vehicleId=veh-1')
  }

  test('машина в пути: этап в свёрнутой шторке и шкала с пройденной точкой', async ({ page }) => {
    const done = { ...loadStop, arrivedAt: '2026-10-30T08:00:00.000Z', completedAt: '2026-10-30T09:00:00.000Z' }
    await openDashboard(page, [done, unloadStop, thirdStop], 'MOVING', 0.4)
    const trigger = page.getByRole('button', { name: /Точки маршрута · 3/ })
    await expect(trigger).toContainText('Этап 2 из 3 · В пути на выгрузку')
    await expect(trigger.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '40')
    await trigger.click()
    const track = page.getByRole('list', { name: 'Этапы маршрута' })
    await expect(track.getByRole('listitem').nth(0)).toHaveAttribute('aria-label', /Загружено/)
    await expect(track.getByRole('listitem').nth(1)).toHaveAttribute('aria-label', /Едем сюда · ETA/)
    await expect(track.getByRole('listitem').nth(2)).toHaveAttribute('aria-label', /Следующая/)
    await expect(page.locator('.stop-marker-done')).toHaveCount(1)
    await expect(page.locator('.stop-marker-current')).toHaveCount(1)
  })

  test('машина на точке: «На выгрузке» и отметка «машина здесь»', async ({ page }) => {
    const done = { ...loadStop, arrivedAt: '2026-10-30T08:00:00.000Z', completedAt: '2026-10-30T09:00:00.000Z' }
    const here = { ...unloadStop, arrivedAt: new Date(Date.now() - 25 * 60_000).toISOString() }
    await openDashboard(page, [done, here], 'ARRIVED', 1)
    const trigger = page.getByRole('button', { name: /Точки маршрута · 2/ })
    await expect(trigger).toContainText(/Этап 2 из 2 · На выгрузке, Potsdam · 2[45] мин/)
    await trigger.click()
    await expect(page.getByRole('list', { name: 'Этапы маршрута' }).getByRole('listitem').nth(1)).toHaveAttribute('aria-label', /Машина здесь/)
  })
})

test.describe('варианты маршрута', () => {
  const line = (shift: number) => Array.from({ length: 6 }, (_, i) => [12.9 - i * 0.6, 50.6 + i * 0.25 + shift]) as Array<[number, number]>
  const option = (leg: number, index: number, roads: string[], km: number, minutes: number, delay = 0) => ({
    id: `${leg}-${index}`, mainRoads: roads, distanceMeters: km * 1000, durationSeconds: minutes * 60, trafficDelaySeconds: delay * 60, hasRoadClosure: false,
    geometry: line(index * 0.15 + leg), trafficSegments: [] })
  const legsFor = (count: number) => Array.from({ length: count }, (_, leg) => ({
    from: leg ? `Ziel ${leg}` : 'VOLLMANN Elterlein', to: leg ? `Ziel ${leg + 1}, Kassel` : 'VW Hannover, Hansa Str. 51',
    options: [option(leg, 0, ['A14', 'A2'], 383, 313, 12), option(leg, 1, ['A72', 'A38'], 399, 324), option(leg, 2, ['A36', 'A2'], 420, 369)] }))

  async function openWithVariants(page: Page, stopCount: number, requests: Array<Record<string, unknown>>) {
    await authenticated(page, async (route, path) => {
      if (path === '/dashboard') { await json(route, { vehicles: [{ vehicle, tour: null, statusText: 'Свободен' }] }); return true }
      if (path === '/vehicles' && route.request().method() === 'GET') { await json(route, [vehicle]); return true }
      if (path === '/route-scenarios/preview') {
        const body = route.request().postDataJSON() as { stops: Array<{ address: string }>; legChoices?: Array<{ durationSeconds: number }> }
        requests.push(body)
        const retimed = Boolean(body.legChoices)
        await json(route, { vehicleId: null, vehicleNumber: null, generatedAt: '2026-11-02T10:00:00Z',
          startRange: { earliest: '2026-11-02T10:00:00Z', latest: '2026-11-02T10:00:00Z' },
          completion: { earliest: '2026-11-02T15:13:00Z', latest: retimed ? '2026-11-02T15:24:00Z' : '2026-11-02T15:13:00Z' },
          finishToday: 'UNKNOWN', preliminary: true, requiresDailyRest: false, distanceMeters: 383000 * stopCount,
          geometry: retimed ? [] : line(0), routingProviders: ['tomtom'], warnings: [],
          stops: body.stops.map((stop, index) => ({ address: stop.address, type: 'VISIT', coords: { latitude: 52 + index, longitude: 9.7 },
            earliestArrival: '2026-11-02T15:13:00Z', latestArrival: retimed ? '2026-11-02T15:24:00Z' : '2026-11-02T15:13:00Z',
            earliestDeparture: null, latestDeparture: null, risk: 'UNKNOWN', serviceMinMinutes: 0, serviceMaxMinutes: 0 })),
          legs: retimed ? [] : legsFor(stopCount), downstreamQueueImpact: [] })
        return true
      }
      if (path.startsWith('/vehicles/')) { await json(route, path.endsWith('/current-position') ? { position: null } : []); return true }
      return false
    })
    await page.route('https://api.tomtom.com/**', route => route.abort())
    await page.goto('/')
    await page.getByRole('button', { name: 'Маршрут', exact: true }).first().click()
    const form = page.getByRole('form', { name: 'Построить маршрут' })
    await form.getByLabel('Старт: номер машины или адрес').fill('VOLLMANN Elterlein')
    if (stopCount > 1) await form.getByRole('button', { name: 'Добавить точку' }).click()
    const inputs = form.locator('.route-point input')
    for (let index = 1; index <= stopCount; index += 1) await inputs.nth(index).fill(index === 1 ? 'VW Hannover, Hansa Str. 51' : `Ziel ${index}, Kassel`)
    await form.getByRole('button', { name: 'Проложить маршрут' }).click()
    return form
  }

  test('показывает 3 варианта с автобанами, лучший выбран, выбор другого не убирает остальные', async ({ page }) => {
    const requests: Array<Record<string, unknown>> = []
    const form = await openWithVariants(page, 1, requests)
    const variants = form.getByRole('radiogroup', { name: /Варианты участка 1 → 2/ })
    await expect(variants.getByRole('radio')).toHaveCount(3)
    const best = variants.getByRole('radio', { name: /через A14 и A2/ })
    await expect(best).toHaveAttribute('aria-checked', 'true')
    await expect(best).toContainText('383 км · лучший по времени')
    await expect(best).toContainText('5 ч 13 мин')
    await expect(best).toContainText('пробки +12 мин')
    const second = variants.getByRole('radio', { name: /через A72 и A38/ })
    await expect(second).toContainText('399 км · +11 мин, +16 км к лучшему')
    await expect(best.locator('.road-shield')).toHaveText(['A14', 'A2'])
    await expect(page.locator('.route-alt-chip')).toHaveCount(2)
    await expect(form.locator('.route-builder-leg-km')).toHaveText(['383 км'])

    await second.click()
    await expect(second).toHaveAttribute('aria-checked', 'true')
    await expect(variants.getByRole('radio')).toHaveCount(3)
    await expect.poll(() => requests.length).toBe(2)
    expect(requests[1]).toMatchObject({ originAddress: 'VOLLMANN Elterlein', legChoices: [{ distanceMeters: 399000, durationSeconds: 19440 }],
      stops: [{ address: 'VW Hannover, Hansa Str. 51', coords: { latitude: 52, longitude: 9.7 } }] })
    await expect(form.locator('.route-builder-leg-km')).toHaveText(['399 км'])
    await expect(form.getByText('5 ч 24 мин в пути')).toBeVisible()
    await expect(page.locator('.route-alt-chip')).toHaveCount(2)

    // Back to the best variant: the original forecast comes back without a new request.
    await page.locator('.route-alt-chip').filter({ hasText: '5 ч 13 мин' }).click()
    await expect(best).toHaveAttribute('aria-checked', 'true')
    await expect(form.getByText('5 ч 13 мин в пути')).toBeVisible()
    expect(requests).toHaveLength(2)
  })

  test('варианты по участкам для маршрута с несколькими точками и выбор стрелками', async ({ page }) => {
    const requests: Array<Record<string, unknown>> = []
    const form = await openWithVariants(page, 2, requests)
    const tabs = form.getByRole('tablist', { name: 'Участки маршрута' })
    await expect(tabs.getByRole('tab')).toHaveCount(2)
    await tabs.getByRole('tab', { name: /2 → 3/ }).click()
    const variants = form.getByRole('radiogroup', { name: /Варианты участка 2 → 3/ })
    await variants.getByRole('radio', { name: /через A14 и A2/ }).focus()
    await page.keyboard.press('ArrowDown')
    await expect(variants.getByRole('radio', { name: /через A72 и A38/ })).toHaveAttribute('aria-checked', 'true')
    await expect.poll(() => requests.length).toBe(2)
    expect((requests[1].legChoices as Array<{ durationSeconds: number }>).map((choice) => choice.durationSeconds)).toEqual([18780, 19440])
  })
})
