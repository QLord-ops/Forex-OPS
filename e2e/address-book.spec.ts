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

for (const role of ['admin', 'dispatcher'] as const) {
  test(`Настройки → «Адреса из Auftrag»: ${role === 'admin' ? 'админ скрывает адрес и собирает адреса прошлых туров' : 'диспетчер только смотрит'}`, async ({ page }) => {
    const rows = [
      { id: 'own-1', name: 'Volkswagen AG Werk Salzgitter', street: 'Industriestraße Nord 1', postalCode: '38239', city: 'Salzgitter', groups: 'Schnellecke', active: true, useCount: 14, lastSeenAt: '2026-11-09T08:00:00.000Z' },
      { id: 'own-2', name: 'Schnellecke Transportlogistik GmbH Umschlagslager', street: 'Rudolf-Diesel-Straße 2a', postalCode: '14974', city: 'Ludwigsfelde', groups: null, active: true, useCount: 3, lastSeenAt: '2026-11-08T08:00:00.000Z' }
    ]
    const calls: Array<{ path: string; body: unknown }> = []
    await page.route('**/api/**', async (route) => {
      const url = new URL(route.request().url())
      const path = url.pathname.replace(/^\/api/, '')
      const method = route.request().method()
      if (path === '/auth/session') return json(route, { authenticated: true, role, csrfToken: 'e2e', dispatcherId: 'd-anna', displayName: 'Anna', onboardingCompletedAt: '2026-11-01T00:00:00Z' })
      if (path === '/notifications') return json(route, { notifications: [] })
      if (path === '/customers') return json(route, { customers: [] })
      if (path === '/import-rules') return json(route, { rules: [], builtIn: [], corrections: { last7d: 0 } })
      if (path === '/address-rules') return json(route, { rules: [], builtIn: [] })
      if (path === '/addresses/own' && method === 'GET') {
        const q = (url.searchParams.get('q') ?? '').toLowerCase()
        return json(route, { total: rows.filter((row) => row.active).length, addresses: rows.filter((row) => !q || row.name.toLowerCase().includes(q)) })
      }
      if (path === '/addresses/own/backfill') {
        const body = route.request().postDataJSON() as { apply: boolean }
        calls.push({ path, body })
        return json(route, { added: 37, counted: 112, skipped: 240, applied: body.apply })
      }
      if (path.startsWith('/addresses/own-') && method === 'PATCH') {
        const body = route.request().postDataJSON() as { active: boolean }
        calls.push({ path, body })
        rows.find((row) => path.endsWith(row.id))!.active = body.active
        return json(route, { id: path.split('/').pop(), active: body.active })
      }
      return json(route, [])
    })
    await page.goto('/settings')
    const card = page.getByRole('region', { name: /Адреса из Auftrag/ })
    await expect(card.getByRole('heading')).toHaveText('Адреса из Auftrag: 2')
    await expect(card.getByRole('listitem')).toHaveCount(2)
    await expect(card.getByRole('listitem').first()).toContainText('Industriestraße Nord 1, 38239 Salzgitter')
    await expect(card.getByRole('listitem').first()).toContainText('использован 14 раз · Schnellecke')

    await page.setViewportSize({ width: 393, height: 851 })
    const cardBox = (await card.boundingBox())!
    for (const item of await card.locator('li, li strong, li span, button, input').all()) {
      const box = (await item.boundingBox())!
      expect(box.x).toBeGreaterThanOrEqual(cardBox.x - 0.5)
      expect(box.x + box.width).toBeLessThanOrEqual(cardBox.x + cardBox.width + 0.5)
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
    if (process.env.C_SHOTS && role === 'admin') { await card.scrollIntoViewIfNeeded(); await page.screenshot({ path: 'test-results/c-own-393.png' }) }

    await card.getByLabel('Поиск по фирме, улице или городу').fill('schnellecke')
    await expect(card.getByRole('listitem')).toHaveCount(1)
    await card.getByLabel('Поиск по фирме, улице или городу').fill('')
    await expect(card.getByRole('listitem')).toHaveCount(2)

    if (role === 'dispatcher') {
      await expect(card.getByRole('button')).toHaveCount(0)
      return
    }
    await card.getByRole('listitem').first().getByRole('button', { name: 'Скрыть' }).click()
    await expect(card.getByRole('listitem').first()).toContainText('скрыт из подсказок')
    await expect(card.getByRole('listitem').first().getByRole('button', { name: 'Вернуть' })).toBeVisible()
    await expect(card.getByRole('heading')).toHaveText('Адреса из Auftrag: 1')

    // Counting writes nothing; the addresses are added only after the second, explicit press.
    await card.getByRole('button', { name: 'Собрать из прошлых туров' }).click()
    await expect(card.getByText('Найдено новых адресов в прошлых турах: 37. Это запись в базу — сначала сделайте backup.')).toBeVisible()
    expect(calls.at(-1)).toEqual({ path: '/addresses/own/backfill', body: { apply: false } })
    await card.getByRole('button', { name: 'Добавить 37' }).click()
    await expect(card.getByText('Добавлено адресов: 37.')).toBeVisible()
    expect(calls).toEqual([
      { path: '/addresses/own-1', body: { active: false } },
      { path: '/addresses/own/backfill', body: { apply: false } },
      { path: '/addresses/own/backfill', body: { apply: true } }
    ])
  })
}
