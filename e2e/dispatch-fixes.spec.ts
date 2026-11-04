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
  let created: { stops?: unknown[] } | null = null
  const vehicle = truck('veh-1', '125')
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, '')
    if (path === '/auth/session') return json(route, { authenticated: true, role: 'dispatcher', csrfToken: 'e2e' })
    if (path === '/notifications') return json(route, { notifications: [] })
    if (path === '/vehicles' && route.request().method() === 'GET') return json(route, [vehicle])
    if (path === '/imports/pdf/preview') return json(route, { source: 'RULES', detectedLayout: 'PDF', warnings: [], aiAvailable: false,
      drafts: [{ orderNumber: '71123515', vehicleNumber: '125', vehiclePlate: null, trailerPlate: null, tourRemarks: 'vorladen Lager --> TST Hamburg + Seifert & BLG Bremen', warnings: [], stops: [
        { sequence: 1, type: 'LOAD', company: 'Lager', address: 'Rudolf-Diesel-Straße 2, 14974 Ludwigsfelde', city: 'Ludwigsfelde', appointmentLocal: null, confidence: 1 },
        { sequence: 2, type: 'UNLOAD', company: 'TST Süderelbe', address: 'Dradenauer Deichweg 3, 21129 Hamburg', city: 'Hamburg', appointmentLocal: null, confidence: 1 }
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
  await page.getByRole('button', { name: 'Редактировать' }).click()
  await page.getByRole('button', { name: 'Выгрузка', exact: true }).click()
  const third = page.locator('.quick-order-review-stop').nth(2)
  await expect(third.getByLabel('Тип точки 3')).toHaveValue('UNLOAD')
  await third.getByLabel('Фирма').fill('BLG Industrielogistik')
  await third.getByLabel('Полный адрес').fill('Senator-Apelt-Straße 90, 28197 Bremen')
  await third.getByLabel('Город').fill('Bremen')
  await page.getByRole('button', { name: 'Подтвердить', exact: true }).click()
  await expect.poll(() => created?.stops?.length ?? 0).toBe(3)
})
