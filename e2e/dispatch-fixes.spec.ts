import { expect, test, type Page, type Route } from '@playwright/test'
import { textClashes } from './text-clashes'

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
      routeGeometry: line, travelledGeometry: line.slice(0, 2), remainingGeometry: line.slice(1), progress: 0.5, remainingDistanceMeters: 215_000,
      roadSegments: [{ from: 0, to: 1, road: 'A7' }, { from: 1, to: 2, road: 'A28' }] })
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

test('на маршруте впереди машины видно табличку автобана с номером', async ({ page }) => {
  await dashboard(page)
  await page.goto('/?vehicleId=v1')
  const shield = page.getByRole('img', { name: 'Автобан A28' })
  await expect(shield).toBeAttached()
  await expect(shield).toHaveText('A28')
  await expect(shield).toHaveClass(/maplibregl-marker/)
  // A7 is already behind the truck: no shield for it.
  await expect(page.getByRole('img', { name: 'Автобан A7' })).toHaveCount(0)
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

test('Auftrag с «evt. Zuladung»: тур помечен, «Добавить Zuladung» ставит загрузку перед выгрузкой', async ({ page }) => {
  let previewBody: { futureStops?: Array<{ type: string; address: string; instructions?: string | null }> } | null = null
  const done = { ...stops[0], arrivedAt: '2026-11-06T08:00:00Z', completedAt: '2026-11-06T09:00:00Z' }
  const unload = { ...stops[1], id: 's2' }
  const activeTour = { id: 'tour-1', vehicleId: 'v1', orderNumber: '20565801', status: 'ACTIVE', planVersion: 3, tourRemarks: 'Borken für Königswalde + evt. Zuladung', stops: [done, unload] }
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
    if (path === '/vehicles/v1/tours') { await json(route, [activeTour]); return true }
    if (path.endsWith('/card')) { await json(route, { vehicleId: 'v1', vehicleNumber: '321', licensePlate: null, currentTrailerPlate: null, generatedAt: new Date().toISOString(), webfleet: null, current: null, coupling: null, driver: null, events: null, trips: null, maintenance: null }); return true }
    return false
  })
  await page.goto('/?vehicleId=v1&card=v1')
  await page.evaluate(() => window.localStorage.setItem('ops-truck-card-tab', 'tour'))
  await page.reload()
  const card = page.getByRole('dialog', { name: /321/ })
  await expect(card.getByRole('note').first()).toContainText('Zuladung возможна перед выгрузкой')
  await expect(card).toContainText('перед ней возможна Zuladung')
  await card.getByRole('note').first().scrollIntoViewIfNeeded()
  await page.screenshot({ path: 'test-results/zuladung-card.png' })
  await card.getByRole('button', { name: 'Добавить Zuladung' }).click()
  const fields = card.locator('.truck-card-editor fieldset')
  await expect(fields).toHaveCount(2)
  await expect(fields.nth(0).locator('legend')).toContainText('Zuladung')
  await expect(fields.nth(0).getByLabel('Тип')).toHaveValue('LOAD')
  await fields.nth(0).getByLabel('Адрес').fill('Industriestraße 1, 34117 Kassel')
  await card.getByRole('button', { name: 'Рассчитать изменения' }).click()
  await expect.poll(() => previewBody?.futureStops?.map((item) => [item.type, item.address, item.instructions ?? null])).toEqual([
    ['LOAD', 'Industriestraße 1, 34117 Kassel', 'Zuladung'],
    ['UNLOAD', unload.address, null]
  ])
})

test('сохранённый Auftrag открывается из карточки «Тур» у активного и очередного тура', async ({ page }) => {
  const activeTour = { id: 'tour-1', vehicleId: 'v1', orderNumber: '71123727', status: 'ACTIVE', planVersion: 1, stops, document: { id: 'doc-1', filename: 'Transportauftrag.pdf', mimeType: 'application/pdf' } }
  const queuedTour = { id: 'tour-2', vehicleId: 'v1', orderNumber: '71123800', status: 'QUEUED', planVersion: 1, previousTourId: 'tour-1', stops: stops.map((stop) => ({ ...stop, id: `q-${stop.id}`, tourId: 'tour-2' })), document: { id: 'doc-2', filename: 'foto.jpg', mimeType: 'image/jpeg' } }
  await dashboard(page, async (route, path) => {
    if (path === '/dashboard') {
      await json(route, { vehicles: [{ vehicle: truck('v1', '321'), statusText: 'MOVING', etaSource: 'GPS', operationVersion: 1, tour: activeTour,
        telemetry: { source: 'WEBFLEET', stale: false, ageSeconds: 60 }, mapPosition: { coordinate: [10.9, 49.4], source: 'WEBFLEET', stale: false, courseDeg: 0, standstill: false } }] }); return true
    }
    if (path === '/tours/tour-1') { await json(route, activeTour); return true }
    if (path === '/vehicles/v1/tours') { await json(route, [activeTour, queuedTour]); return true }
    if (path.endsWith('/card')) { await json(route, { vehicleId: 'v1', vehicleNumber: '321', licensePlate: null, currentTrailerPlate: null, generatedAt: new Date().toISOString(), webfleet: null, current: null, coupling: null, driver: null, events: null, trips: null, maintenance: null }); return true }
    return false
  })
  await page.goto('/?vehicleId=v1&card=v1')
  await page.evaluate(() => window.localStorage.setItem('ops-truck-card-tab', 'tour'))
  await page.reload()
  const card = page.getByRole('dialog', { name: /321/ })
  const activeLink = card.getByRole('link', { name: 'Auftrag (PDF)' })
  await expect(activeLink).toHaveAttribute('href', '/api/documents/doc-1/file')
  await expect(activeLink).toHaveAttribute('target', '_blank')
  await card.getByRole('button', { name: /71123800/, expanded: false }).click()
  await expect(card.getByRole('link', { name: 'Auftrag (фото)' })).toHaveAttribute('href', '/api/documents/doc-2/file')
})

test('машина на суточном отдыхе на загрузке: пометка в списке и панели, уведомление в «Требует решения»', async ({ page }) => {
  const arrivedAt = new Date(Date.now() - 5 * 3600_000).toISOString()
  const until = new Date(Date.now() + 6 * 3600_000)
  const restStops = [{ ...stops[0], arrivedAt }, stops[1]]
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, '')
    if (path === '/auth/session') return json(route, { authenticated: true, role: 'dispatcher', csrfToken: 'e2e' })
    if (path === '/notifications') return json(route, { notifications: [{ id: 'n-rest', vehicleId: 'v1', stopId: 's1', type: 'DAILY_REST_AT_STOP', createdAt: new Date().toISOString(),
      message: 'LKW 3010 на загрузке в Hannover: водитель на суточном отдыхе с 14:46 (тахограф Webfleet). Загрузка продолжится после отдыха, не раньше 23:46.',
      payloadJson: JSON.stringify({ stopType: 'LOAD', place: 'Hannover', since: arrivedAt, until: until.toISOString() }) }] })
    if (path === '/dashboard') return json(route, { vehicles: [{ vehicle: truck('v1', '3010'), statusText: 'WAITING', etaSource: 'GPS', operationVersion: 4, dwellMinutes: 300, dwellSeverity: 'NONE',
      currentStop: restStops[0], currentAction: { type: 'MARK_LOADED', label: 'BELADEN', stopId: 's1' },
      restAtStop: { stopId: 's1', stopType: 'LOAD', place: 'Hannover', since: arrivedAt, until: until.toISOString() },
      tour: { id: 'tour-1', vehicleId: 'v1', orderNumber: '20565181', status: 'ACTIVE', stops: restStops },
      telemetry: { source: 'WEBFLEET', stale: false, ageSeconds: 60, speedKmh: 0, standstill: true },
      mapPosition: { coordinate: [9.73, 52.37], source: 'WEBFLEET', stale: false, courseDeg: 0, standstill: true } }] })
    if (path.endsWith('/current-position')) return json(route, { status: 'WAITING' })
    return json(route, [])
  })
  await page.route('https://tile.openstreetmap.org/**', (route) => route.abort())
  await page.goto('/?vehicleId=v1')
  const untilText = until.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
  const row = page.locator('.vehicle-card').filter({ hasText: 'LKW 3010' })
  await expect(row).toContainText('Суточный отдых')
  // In the evening the rest ends tomorrow and the note carries the date («до 06.11, 04:30»).
  await expect(row).toContainText(new RegExp(`до ([0-9]{2}[.][0-9]{2}, )?${untilText} · потом загрузка`))
  await expect(page.locator('.vehicle-panel')).toContainText(`потом загрузка`)
  const decisions = page.getByRole('region', { name: 'Требует решения' })
  await expect(decisions).toContainText('LKW 3010 на суточном отдыхе на загрузке')
  await expect(decisions).toContainText('Загрузка продолжится после отдыха')
})

test('утром наверху то, что требует решения; информационное и устаревшее свёрнуто, «Прочитать все» закрывает только его', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-11-05T07:00:00+01:00'))
  const at = (time: string) => new Date(`2026-11-05T${time}:00+01:00`).toISOString()
  const notifications = [
    { id: 'n-left', vehicleId: 'v1', stopId: 's1', type: 'STOP_DEPARTED', priority: 'ACTION', urgent: true, createdAt: at('03:10'),
      message: 'LKW 9724 уехала с загрузки', payloadJson: JSON.stringify({ stopType: 'LOAD', leftAt: at('03:05') }) },
    { id: 'n-jam', vehicleId: 'v1', stopId: 's2', type: 'TRAFFIC_DELAY', priority: 'RISK', createdAt: at('04:20'), message: 'Грузовик 9724: задержка из-за трафика 25 мин', payloadJson: '{}' },
    { id: 'n-old-jam', vehicleId: 'v1', stopId: 's2', type: 'TRAFFIC_DELAY', priority: 'INFO', resolved: true, resolvedReason: 'есть новее', createdAt: at('02:20'), message: 'Грузовик 9724: задержка из-за трафика 12 мин', payloadJson: '{}' },
    { id: 'n-termin', vehicleId: 'v1', stopId: 's2', type: 'TERMIN_MET', priority: 'INFO', createdAt: at('01:00'), message: 'LKW 9724 прибыла вовремя', payloadJson: '{}' }
  ]
  let acked: unknown = null
  await dashboard(page, async (route, path) => {
    if (path === '/notifications/ack-many') { acked = route.request().postDataJSON(); await json(route, { ok: true, count: 2 }); return true }
    return false
  })
  await page.route('**/api/notifications', (route) => json(route, { notifications }))
  await page.goto('/')
  const decisions = page.getByRole('region', { name: 'Требует решения' })
  await expect(decisions.getByRole('status')).toHaveText('За ночь: 4 · требуют решения: 1')
  await expect(decisions.locator('.decision-group-title')).toHaveText(['Нужно решение1', 'Важно1', 'Для сведения2'])
  await expect(decisions.getByRole('group', { name: 'Нужно решение' })).toContainText('LKW 9724 уехала с загрузки без BELADEN')
  await expect(decisions.getByText('задержка из-за трафика 12 мин')).toBeHidden()
  await decisions.getByText('Для сведения').click()
  await expect(decisions.getByText('Уже не актуально: есть новее')).toBeVisible()
  page.once('dialog', (dialog) => void dialog.accept())
  await decisions.getByRole('button', { name: 'Прочитать все' }).click()
  await expect.poll(() => acked).toEqual({ ids: ['n-old-jam', 'n-termin'] })
})

test('нижняя панель: этап под «бровью», следующая точка, часы по тахографу; при карточке съезжает в полоску', async ({ page }) => {
  const reference = new Date(Date.now() - 3 * 60_000).toISOString()
  const card = { vehicleId: 'v1', vehicleNumber: '9724', licensePlate: 'B-9724', currentTrailerPlate: null, generatedAt: new Date().toISOString(), webfleet: null, current: null, coupling: null, events: null, trips: null, maintenance: null,
    driver: { status: 'SIGNED_ON', name: null, workState: 5, activitySince: null, checkedAt: reference, optiDrive: null, drivingTimesStatus: 'OK',
      drivingTimes: { referenceTime: reference, remainDrivingTodayMs: 97 * 60_000, totalDrivingTodayMs: 0, totalOtherWorkTodayMs: 0, totalAvailabilityTodayMs: 0, maxDrivingTodayMs: 9 * 3600_000,
        remainDrivingWeekMs: null, maxDrivingWeekMs: null, shiftStartedAt: null, latestShiftEndAt: null, nextBreakAt: new Date(Date.now() + 45 * 60_000).toISOString(), nextBreakMinMs: 45 * 60_000,
        nextRestAt: null, nextRestMinMs: null, earliestNextShiftAt: null, extendedShiftsUsed: null, maxExtendedShifts: null, reducedRestsUsed: null, maxReducedRests: null, restBalances: [], infringements: false, lastCardActivityAt: null } } }
  await dashboard(page, async (route, path) => { if (path.endsWith('/card')) { await json(route, card); return true } return false })
  await page.goto('/?vehicleId=v1')
  const panel = page.locator('.vehicle-panel')
  await expect(panel.locator('.vehicle-panel-stage')).toContainText('Тур 20565181')
  const [stage, bar] = await Promise.all([panel.locator('.vehicle-panel-stage').boundingBox(), panel.locator('.vehicle-panel-bar').boundingBox()])
  expect(stage!.y).toBeLessThan(bar!.y)
  await expect(panel.locator('.vehicle-panel-next')).toContainText('Следующая точка')
  await expect(panel.locator('.vehicle-panel-next')).toContainText('Hannover')
  await expect(panel.getByLabel('Часы водителя')).toContainText('Вождение: осталось 1 ч 37 мин')
  await expect(panel.getByLabel('Часы водителя')).toContainText('по тахографу Webfleet')
  await page.screenshot({ path: 'test-results/panel-open.png' })

  await page.getByRole('button', { name: 'Свернуть панель машины' }).click()
  await expect(panel).toHaveClass(/vehicle-panel-collapsed/)
  await expect(panel).toContainText('LKW 9724')
  await expect(panel.locator('.vehicle-panel-strip-next')).toContainText('Hannover')
  await expect(panel).not.toContainText('Осталось')
  await page.screenshot({ path: 'test-results/panel-collapsed.png' })
  await page.reload()
  await expect(page.locator('.vehicle-panel')).toHaveClass(/vehicle-panel-collapsed/)
  await page.getByRole('button', { name: 'Развернуть панель LKW 9724' }).click()
  await expect(page.locator('.vehicle-panel')).toContainText('Осталось')

  // The truck card opens: the panel steps aside to the strip, and comes back when the card closes.
  await page.goto('/?vehicleId=v1&card=v1')
  await expect(page.locator('.vehicle-panel')).toHaveClass(/vehicle-panel-collapsed/)
  await expect(page.locator('.vehicle-panel-strip-next')).toContainText('Hannover')
  await page.screenshot({ path: 'test-results/panel-with-card.png' })
  await page.getByRole('dialog').getByRole('button', { name: /Закрыть/ }).first().click()
  await expect(page.locator('.vehicle-panel')).not.toHaveClass(/vehicle-panel-collapsed/)
  await expect(page.getByRole('button', { name: 'Свернуть панель машины' })).toHaveAttribute('aria-expanded', 'true')
})

test('нижняя панель показывает, из чего сложилась ETA: езда, суточный отдых по тахографу, без наложений', async ({ page }) => {
  const restEnd = new Date(Date.now() + 15 * 3600_000)
  await dashboard(page, async (route, path) => {
    if (path !== '/dashboard') return false
    await json(route, { vehicles: [{ vehicle: truck('v1', '2853'), statusText: 'MOVING', etaSource: 'GPS', operationVersion: 4, remainingKm: 423, eta: new Date(restEnd.getTime() + 2 * 3600_000).toISOString(),
      etaPlan: { hours: 'TACHOGRAPH', preliminary: false, driveSeconds: 6 * 3600 + 12 * 60, breakSeconds: 0, rest: { startAt: new Date(Date.now() + 4 * 3600_000).toISOString(), endAt: restEnd.toISOString(), seconds: 11 * 3600, reduced: false }, startsAt: null },
      tour: { id: 'tour-1', vehicleId: 'v1', orderNumber: 'SHP2610-A59V928', status: 'ACTIVE', stops },
      telemetry: { source: 'WEBFLEET', stale: false, ageSeconds: 60, speedKmh: 76, standstill: false, address: 'A2, Bad Nenndorf' },
      mapPosition: { coordinate: [8.8, 53.07], source: 'WEBFLEET', stale: false, courseDeg: 90, standstill: false } }] })
    return true
  })
  await page.goto('/?vehicleId=v1')
  const panel = page.locator('.vehicle-panel')
  await expect(panel.locator('.vehicle-panel-bar')).toBeVisible()
  await expect(panel.getByText(/≈ 6 ч 12 мин езды · отдых 11 ч до /)).toBeVisible()
  await expect(panel.getByText('от GPS · по тахографу')).toBeVisible()
  expect(await textClashes(page, '.vehicle-panel'), 'нижняя панель').toEqual([])
})
