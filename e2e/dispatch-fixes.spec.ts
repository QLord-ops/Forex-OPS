import { expect, test, type Page, type Route } from '@playwright/test'

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

const truck = (id: string, vehicleNumber: string) => ({ id, vehicleNumber, licensePlate: `B-${vehicleNumber}`, maxSpeedKmh: 85 })
const stop = (id: string, sequence: number, type: 'LOAD' | 'UNLOAD', city: string, latitude: number, longitude: number) => ({
  id, tourId: 'tour-1', sequence, type, company: `Werk ${city}`, address: `Werkstraße ${sequence}, ${city}`, city, latitude, longitude,
  serviceMinMinutes: 60, serviceMaxMinutes: 120, arrivedAt: null, completedAt: null
})
const stops = [stop('s1', 1, 'LOAD', 'Hannover', 52.37, 9.73), stop('s2', 2, 'UNLOAD', 'Emden', 53.36, 7.2)]
const line: Array<[number, number]> = [[9.73, 52.37], [8.8, 53.07], [7.2, 53.36]]

async function dashboard(page: Page, handler: (route: Route, path: string) => Promise<boolean> = async () => false) {
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, '')
    if (path === '/auth/session') return json(route, { authenticated: true, role: 'dispatcher', csrfToken: 'e2e' })
    if (path === '/notifications') return json(route, { notifications: [] })
    if (await handler(route, path)) return
    if (path === '/dashboard') return json(route, { vehicles: [
      { vehicle: truck('v1', '9724'), statusText: 'MOVING', etaSource: 'GPS', operationVersion: 4, remainingKm: 215, eta: new Date(Date.now() + 3 * 3600_000).toISOString(),
        tour: { id: 'tour-1', vehicleId: 'v1', orderNumber: '20565181', status: 'ACTIVE', stops },
        telemetry: { source: 'WEBFLEET', stale: false, ageSeconds: 60, speedKmh: 80, standstill: false, address: 'A28, Bremen' },
        mapPosition: { coordinate: [8.8, 53.07], source: 'WEBFLEET', stale: false, courseDeg: 270, standstill: false } },
      ...['3001', '3002', '3003'].map((number, index) => ({ vehicle: truck(`f${index}`, number), statusText: 'MOVING', operationVersion: 1, tour: null,
        mapPosition: { coordinate: [11 + index * 0.4, 51 + index * 0.3], source: 'WEBFLEET', stale: false, courseDeg: 0, standstill: false } }))
    ] })
    if (path === '/vehicles/v1/current-position') return json(route, { status: 'MOVING', positionSource: 'WEBFLEET', etaSource: 'GPS', coordinate: [8.8, 53.07], tourId: 'tour-1', legId: 'leg-1',
      routeGeometry: line, travelledGeometry: line.slice(0, 2), remainingGeometry: line.slice(1), progress: 0.5, remainingDistanceMeters: 215_000 })
    if (path.endsWith('/current-position')) return json(route, { status: 'MOVING' })
    return json(route, [])
  })
  await page.route('https://tile.openstreetmap.org/**', (route) => route.abort())
}

test('маркеры остаются привязаны к карте после зума, точка маршрута показывает себя на карте', async ({ page }) => {
  await dashboard(page)
  await page.goto('/?vehicleId=v1')
  const markers = page.locator('.fleet-marker')
  await expect(markers.first()).toBeAttached()
  await page.getByRole('button', { name: 'Приблизить' }).click()
  await page.getByRole('button', { name: 'Приблизить' }).click()
  // MapLibre positions a marker by its own class; losing it made the trucks slide to the corner.
  for (const marker of await markers.all()) await expect(marker).toHaveClass(/maplibregl-marker/)

  await page.getByRole('button', { name: /Точки маршрута · 2/ }).click()
  const center = () => page.evaluate(() => JSON.parse(window.localStorage.getItem('ops-dashboard-map-camera') ?? 'null')?.center as [number, number] | undefined)
  await page.getByRole('button', { name: /Показать на карте: 2 · .*Emden/ }).click()
  await expect.poll(async () => (await center())?.[0] ?? 0, { timeout: 5000 }).toBeLessThan(7.5)
})

test('варианты маршрута от GPS: серый вариант становится маршрутом тура', async ({ page }) => {
  let applied: unknown = null
  const option = (id: string, km: number, minutes: number, shift: number) => ({ id, distanceMeters: km * 1000, durationSeconds: minutes * 60, trafficDelaySeconds: 0, mainRoads: ['A28'],
    providerStatus: 'live-traffic', geometry: [[8.8, 53.07], [8.2 + shift, 53.2 + shift], [7.2, 53.36]] })
  await dashboard(page, async (route, path) => {
    if (path === '/vehicles/v1/route-options') {
      await json(route, { vehicleId: 'v1', version: 4, legId: 'leg-1', checkedAt: new Date().toISOString(), offRouteMeters: 2600,
        current: { remainingDistanceMeters: 215_000, eta: null, geometry: line.slice(1) },
        options: [option('o-0', 215, 150, 0), option('o-1', 236, 162, 0.1), option('o-2', 251, 171, -0.1)] }); return true
    }
    if (path === '/vehicles/v1/route-options/apply') { applied = route.request().postDataJSON(); await json(route, { ok: true }); return true }
    return false
  })
  page.on('dialog', (dialog) => void dialog.accept())
  await page.goto('/?vehicleId=v1')
  await page.getByRole('button', { name: 'Варианты' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Варианты от GPS' })).toBeVisible()
  const chips = page.locator('.route-alt-chip')
  await expect(chips).toHaveCount(2)
  await page.getByRole('button', { name: /Выбрать вариант маршрута: 2 ч 42 мин · 236 км/ }).click()
  await expect.poll(() => applied).toEqual({ optionId: 'o-1', version: 4 })
  await expect(chips).toHaveCount(0)
})

test('в проверке распознавания можно добавить выгрузку, и она уходит в Auftrag', async ({ page }) => {
  let created: { stops?: Array<{ learnLabel?: string | null; plannedAt?: string | null }> } | null = null
  const vehicle = truck('veh-1', '125')
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, '')
    if (path === '/auth/session') return json(route, { authenticated: true, role: 'dispatcher', csrfToken: 'e2e' })
    if (path === '/notifications') return json(route, { notifications: [] })
    if (path === '/vehicles' && route.request().method() === 'GET') return json(route, [vehicle])
    if (path === '/imports/pdf/preview') return json(route, { source: 'RULES', detectedLayout: 'PDF', warnings: [], aiAvailable: false,
      drafts: [{ orderNumber: '71123515', vehicleNumber: '125', vehiclePlate: null, trailerPlate: null, tourRemarks: 'vorladen Lager --> TST Hamburg + Seifert & BLG Bremen', warnings: [], stops: [
        { sequence: 1, type: 'LOAD', company: 'Lager', address: 'Rudolf-Diesel-Straße 2, 14974 Ludwigsfelde', city: 'Ludwigsfelde', appointmentLocal: null, confidence: 1 },
        { sequence: 2, type: 'UNLOAD', company: 'TST Süderelbe', address: 'Dradenauer Deichweg 3, 21129 Hamburg', city: 'Hamburg', appointmentLocal: null, plannedLocal: '2026-11-05T06:00', confidence: 1, sourceLabel: 'TST Süderelbe Hamburg' },
        { sequence: 3, type: 'UNLOAD', company: 'Seifert', address: 'Bremen', city: 'Bremen', appointmentLocal: null, plannedLocal: '2026-11-05T06:00', confidence: 0.4, sourceLabel: 'Seifert Bremen', terminRequired: true }
      ] }] })
    if (path === '/geocode' || path === '/geocode/resolve') {
      const body = route.request().postDataJSON() as { address?: string } | null
      return json(route, { address: body?.address ?? '', latitude: 53.08, longitude: 8.8, city: 'Bremen', provider: 'e2e', precision: 'EXACT' })
    }
    if (path === '/imports/tours/confirm') { created = route.request().postDataJSON() as { stops?: unknown[] }; return json(route, { tour: { id: 't', vehicleId: 'veh-1', orderNumber: '71123515', status: 'ACTIVE', stops: [], legs: [] }, created: true, reused: false }, 201) }
    if (path.startsWith('/vehicles/veh-1')) return json(route, path.endsWith('/tours') ? [] : vehicle)
    return json(route, [])
  })
  await page.route('https://tile.openstreetmap.org/**', (route) => route.abort())
  await page.goto('/vehicles')
  await page.getByRole('button', { name: /меню$/ }).click()
  await page.getByRole('button', { name: 'ИИ-диспетчер' }).click()
  await page.getByRole('button', { name: 'Прикрепить Auftrag' }).click()
  await page.locator('.dispatcher-import-host input[type="file"]').setInputFiles({ name: 'auftrag.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7 e2e') })
  await expect(page.getByLabel('Номер Auftrag')).toHaveValue('71123515')
  await expect(page.locator('.quick-order-review-stop').nth(2)).toContainText('Termin нужен')
  await expect(page.locator('.quick-order-review-stop').nth(1)).toContainText('не Termin')
  await page.getByRole('button', { name: 'Редактировать' }).click()
  // The Seifert address is missing in the Auftrag: the dispatcher types it once.
  await page.locator('.quick-order-review-stop').nth(2).getByLabel('Полный адрес').fill('Musterweg 5, 28197 Bremen')
  await page.getByRole('button', { name: 'Выгрузка', exact: true }).click()
  // A wrong stop can be removed; the minimum of two stops is checked on confirm.
  await page.getByRole('button', { name: 'Загрузка', exact: true }).click()
  // A new loading is placed after the last loading, so it is stop 2.
  await page.getByRole('button', { name: 'Удалить точку 2' }).click()
  await expect(page.locator('.quick-order-review-stop')).toHaveCount(4)
  const fourth = page.locator('.quick-order-review-stop').nth(3)
  await expect(fourth.getByLabel('Тип точки 4')).toHaveValue('UNLOAD')
  await fourth.getByLabel('Фирма').fill('BLG Industrielogistik')
  await fourth.getByLabel('Полный адрес').fill('Senator-Apelt-Straße 90, 28197 Bremen')
  await fourth.getByLabel('Город').fill('Bremen')
  await page.getByRole('button', { name: 'Подтвердить', exact: true }).click()
  await expect.poll(() => created?.stops?.length ?? 0).toBe(4)
  // Only the corrected place is remembered; the planned 06:00 travels as a plan, not a Termin.
  expect(created!.stops!.map((stop) => stop.learnLabel ?? null)).toEqual([null, null, 'Seifert Bremen', null])
  expect(created!.stops![1].plannedAt).toBe('2026-11-05T05:00:00.000Z')
})

test('«Открыть» в нижней панели показывает карточку; BELADEN вручную уходит с пометкой manual', async ({ page }) => {
  let loaded: unknown = null
  await dashboard(page, async (route, path) => {
    if (path === '/dashboard') {
      await json(route, { vehicles: [{ vehicle: truck('v1', '124'), statusText: 'MOVING', etaSource: 'GPS', operationVersion: 2,
        tour: { id: 'tour-1', vehicleId: 'v1', orderNumber: '20565574', status: 'ACTIVE', stops },
        currentStop: stops[0], currentAction: { type: 'MARK_LOADED', label: 'BELADEN', stopId: 's1', withoutGpsArrival: true, manual: true },
        telemetry: { source: 'WEBFLEET', stale: false, ageSeconds: 60, speedKmh: 83, standstill: false, address: 'A4, Chemnitz' },
        mapPosition: { coordinate: [12.9, 50.83], source: 'WEBFLEET', stale: false, courseDeg: 90, standstill: false } }] }); return true
    }
    if (path === '/stops/s1/loaded') { loaded = route.request().postDataJSON(); await json(route, { id: 'tour-1', vehicleId: 'v1', stops: [] }); return true }
    if (path.endsWith('/card')) { await json(route, { vehicleId: 'v1', vehicleNumber: '124', licensePlate: null, currentTrailerPlate: null, generatedAt: new Date().toISOString(), webfleet: null, current: null, coupling: null, driver: null, events: null, trips: null, maintenance: null }); return true }
    return false
  })
  await page.goto('/?vehicleId=v1')
  await page.getByRole('button', { name: 'Открыть', exact: true }).click()
  await expect(page.getByRole('dialog', { name: /124/ })).toBeVisible()
  await page.getByRole('button', { name: 'Закрыть карточку' }).click()

  // GPS never saw the truck at the stop, but it loaded: the dispatcher records BELADEN by hand.
  const row = page.locator('.vehicle-card').filter({ hasText: 'LKW 124' })
  await expect(row).not.toHaveClass(/vehicle-card-action/)
  await row.getByRole('button', { name: 'BELADEN' }).click()
  const popover = page.getByRole('dialog', { name: /BELADEN LKW 124/ })
  await expect(popover).toContainText('GPS Webfleet не видел машину')
  await popover.getByRole('button', { name: 'Подтвердить вручную' }).click()
  await expect.poll(() => loaded).toMatchObject({ manual: true })
})

test('в карточке «Тур» у текущей точки есть маленькая кнопка BELADEN, которая записывает событие вручную', async ({ page }) => {
  let loaded: unknown = null
  await dashboard(page, async (route, path) => {
    if (path === '/dashboard') {
      await json(route, { vehicles: [{ vehicle: truck('v1', '124'), statusText: 'MOVING', etaSource: 'GPS', operationVersion: 2,
        tour: { id: 'tour-1', vehicleId: 'v1', orderNumber: '20565574', status: 'ACTIVE', planVersion: 1, stops },
        telemetry: { source: 'WEBFLEET', stale: false, ageSeconds: 60, speedKmh: 83, standstill: false },
        mapPosition: { coordinate: [12.9, 50.83], source: 'WEBFLEET', stale: false, courseDeg: 90, standstill: false } }] }); return true
    }
    if (path === '/stops/s1/loaded') { loaded = route.request().postDataJSON(); await json(route, { id: 'tour-1', vehicleId: 'v1', stops: [] }); return true }
    if (path === '/vehicles/v1/tours') { await json(route, []); return true }
    if (path.endsWith('/card')) { await json(route, { vehicleId: 'v1', vehicleNumber: '124', licensePlate: null, currentTrailerPlate: null, generatedAt: new Date().toISOString(), webfleet: null, current: null, coupling: null, driver: null, events: null, trips: null, maintenance: null }); return true }
    return false
  })
  await page.goto('/?vehicleId=v1&card=v1')
  await page.evaluate(() => window.localStorage.setItem('ops-truck-card-tab', 'tour'))
  await page.reload()
  const card = page.getByRole('dialog', { name: /124/ })
  await expect(card.getByRole('tab', { name: 'Тур' })).toHaveAttribute('aria-selected', 'true')
  // Only the stop the truck is heading to gets the button; the later stops wait their turn.
  await expect(card.getByRole('button', { name: /^BELADEN/ })).toHaveCount(1)
  await card.getByRole('button', { name: 'BELADEN Hannover' }).click()
  await expect(card).toContainText('Прибытия по GPS нет')
  await card.getByRole('button', { name: 'Записать BELADEN' }).click()
  await expect.poll(() => loaded).toMatchObject({ manual: true })
})

test('начатый тур меняется из карточки: будущие точки правятся через предпросмотр, пройденные остаются', async ({ page }) => {
  let applied: unknown = null
  let previewBody: { futureStops?: Array<{ address: string }> } | null = null
  const done = { ...stops[0], arrivedAt: '2026-11-04T09:00:00Z', completedAt: '2026-11-04T10:15:00Z' }
  const next = { ...stops[1], id: 's2' }
  const later = stop('s3', 3, 'LOAD', 'Nürnberg', 49.45, 11.08)
  const activeTour = { id: 'tour-1', vehicleId: 'v1', orderNumber: '1242343245', status: 'ACTIVE', planVersion: 3, stops: [done, next, later] }
  await dashboard(page, async (route, path) => {
    if (path === '/dashboard') {
      await json(route, { vehicles: [{ vehicle: truck('v1', '321'), statusText: 'MOVING', etaSource: 'GPS', operationVersion: 2, tour: activeTour,
        telemetry: { source: 'WEBFLEET', stale: false, ageSeconds: 60 }, mapPosition: { coordinate: [10.9, 49.4], source: 'WEBFLEET', stale: false, courseDeg: 0, standstill: false } }] }); return true
    }
    if (path === '/tours/tour-1') { await json(route, activeTour); return true }
    if (path === '/tours/tour-1/replan/preview') {
      previewBody = route.request().postDataJSON()
      await json(route, { id: 'p1', version: 3, expiresAt: new Date(Date.now() + 600_000).toISOString(), affectedTourIds: [],
        before: { distanceMeters: 300_000, durationSeconds: 14_400, roads: [] }, after: { distanceMeters: 320_000, durationSeconds: 15_000, roads: [] } }); return true
    }
    if (path === '/tours/tour-1/replan/apply') { applied = route.request().postDataJSON(); await json(route, { ok: true }); return true }
    if (path === '/vehicles/v1/tours') { await json(route, [activeTour]); return true }
    if (path.endsWith('/card')) { await json(route, { vehicleId: 'v1', vehicleNumber: '321', licensePlate: null, currentTrailerPlate: null, generatedAt: new Date().toISOString(), webfleet: null, current: null, coupling: null, driver: null, events: null, trips: null, maintenance: null }); return true }
    return false
  })
  await page.goto('/?vehicleId=v1&card=v1')
  await page.evaluate(() => window.localStorage.setItem('ops-truck-card-tab', 'tour'))
  await page.reload()
  const card = page.getByRole('dialog', { name: /321/ })
  await card.getByRole('button', { name: 'Изменить тур' }).click()
  // Only the future stops are editable: the loaded stop 1 is not in the form.
  const fields = card.locator('.truck-card-editor fieldset')
  await expect(fields).toHaveCount(2)
  await fields.nth(1).getByLabel('Адрес').fill('Hafenstraße 4, 90451 Nürnberg')
  await card.getByRole('button', { name: 'Рассчитать изменения' }).click()
  await expect.poll(() => previewBody?.futureStops?.map((item) => item.address)).toEqual(['Werkstraße 2, Emden', 'Hafenstraße 4, 90451 Nürnberg'])
  await card.getByRole('button', { name: 'Применить изменения' }).click()
  await expect.poll(() => applied).toEqual({ previewId: 'p1', version: 3 })
})
