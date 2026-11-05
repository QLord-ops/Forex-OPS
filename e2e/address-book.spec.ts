import { expect, test, type Route } from '@playwright/test'

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

const vehicle = { id: 'veh-1', vehicleNumber: '125', licensePlate: 'B-OPS125', maxSpeedKmh: 85 }
const emden = { id: 'addr-1', source: 'WEBFLEET', label: 'VW Werk Emden · Tor 17', line2: 'Frisiusstraße 1, 26723 Emden', company: 'VW Werk Emden', street: 'Frisiusstraße 1',
  postalCode: '26723', city: 'Emden', latitude: 53.366, longitude: 7.206, radiusMeters: 400 }

test('адреса Webfleet подсказываются в маршруте: выбор ставит точные координаты без поиска адреса', async ({ page }) => {
  const searches: string[] = []
  const scenarios: Array<Record<string, unknown>> = []
  const used: string[] = []
  let geocoded = 0
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname.replace(/^\/api/, '')
    if (path === '/auth/session') return json(route, { authenticated: true, role: 'admin', csrfToken: 'e2e' })
    if (path === '/notifications') return json(route, { notifications: [] })
    if (path === '/dashboard') return json(route, { vehicles: [{ vehicle, tour: null, statusText: 'IDLE' }] })
    if (path === '/vehicles' && route.request().method() === 'GET') return json(route, [vehicle])
    if (path === '/addresses/search') {
      searches.push(url.searchParams.get('q') ?? '')
      return json(route, { suggestions: /emd/i.test(url.searchParams.get('q') ?? '') ? [emden] : [] })
    }
    if (path.startsWith('/addresses/') && path.endsWith('/used')) { used.push(path); return json(route, { ok: true }) }
    if (path.startsWith('/geocode')) { geocoded += 1; return json(route, { error: 'not expected' }, 500) }
    if (path === '/route-scenarios/preview') {
      const body = route.request().postDataJSON() as { stops: Array<{ address: string; coords?: { latitude: number; longitude: number } }> }
      scenarios.push(body)
      return json(route, { vehicleId: 'veh-1', vehicleNumber: '125', generatedAt: '2026-11-06T10:00:00Z', startRange: { earliest: '2026-11-06T10:00:00Z', latest: '2026-11-06T10:00:00Z' },
        completion: { earliest: '2026-11-06T13:00:00Z', latest: '2026-11-06T13:00:00Z' }, finishToday: 'UNKNOWN', preliminary: true, requiresDailyRest: false, distanceMeters: 300000,
        geometry: [[9.7, 52.4], [7.2, 53.37]], routingProviders: ['tomtom'], warnings: [], legs: [], downstreamQueueImpact: [],
        stops: body.stops.map((stop) => ({ address: stop.address, type: 'VISIT', coords: stop.coords ?? { latitude: 0, longitude: 0 }, earliestArrival: '2026-11-06T13:00:00Z', latestArrival: '2026-11-06T13:00:00Z',
          earliestDeparture: null, latestDeparture: null, risk: 'UNKNOWN', serviceMinMinutes: 0, serviceMaxMinutes: 0 })) })
    }
    if (path.startsWith('/vehicles/')) return json(route, path.endsWith('/current-position') ? { position: null } : [])
    return json(route, [])
  })
  await page.route('https://tile.openstreetmap.org/**', (route) => route.abort())
  await page.route('https://api.tomtom.com/**', (route) => route.abort())
  await page.goto('/')
  await page.getByRole('button', { name: 'Маршрут', exact: true }).first().click()
  const form = page.getByRole('form', { name: 'Построить маршрут' })

  // The first point lists matching trucks in the same list.
  await form.getByLabel('Старт: номер машины или адрес').fill('125')
  await form.getByRole('option', { name: /LKW 125/ }).click()
  await expect(form.getByLabel('Старт: номер машины или адрес')).toHaveValue('LKW 125')

  const target = form.getByLabel('Конечный адрес')
  await target.fill('emd')
  const option = form.getByRole('option', { name: /VW Werk Emden · Tor 17/ })
  await expect(option).toContainText('Frisiusstraße 1, 26723 Emden')
  await expect(option).toContainText('Webfleet')
  await page.screenshot({ path: 'test-results/address-suggestions.png' })
  await target.press('ArrowDown')
  await target.press('Enter')
  await expect(target).toHaveValue('VW Werk Emden · Tor 17, Frisiusstraße 1, 26723 Emden')
  await expect(form).toContainText('точные координаты из адресной книги')
  await expect.poll(() => used).toEqual(['/addresses/addr-1/used'])

  await form.getByRole('button', { name: 'Проложить маршрут' }).click()
  await expect.poll(() => scenarios.length).toBe(1)
  expect(scenarios[0]).toMatchObject({ vehicleId: 'veh-1', stops: [{ address: 'VW Werk Emden · Tor 17, Frisiusstraße 1, 26723 Emden', coords: { latitude: 53.366, longitude: 7.206 } }] })
  expect(geocoded).toBe(0)
  expect(searches.every((query) => query.length >= 2)).toBe(true)
})
