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
    if (path === '/tours' && route.request().method() === 'POST') {
      createdPayload = route.request().postDataJSON() as Record<string, unknown>
      await json(route, { ...tour(), orderNumber: 'A-200' }, 201); return true
    }
    if (path.startsWith('/vehicles/veh-1')) { await json(route, path.endsWith('/tours') ? [tour()] : vehicle); return true }
    return false
  })

  await page.goto('/orders/new')
  await page.getByRole('main').locator('input[type="file"]').setInputFiles({ name: 'auftrag.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7 e2e') })
  await expect(page.getByLabel('Номер Auftrag')).toHaveValue('A-200')
  await page.getByRole('button', { name: 'Подтвердить', exact: true }).click()
  await expect.poll(() => createdPayload).not.toBeNull()
  expect(createdPayload).toMatchObject({ vehicleId: 'veh-1', orderNumber: 'A-200' })
})

test('подтверждает фактическое прибытие', async ({ page }) => {
  let arrivalBody: unknown = null
  const activeTour = tour()
  await authenticated(page, async (route, path) => {
    if (path === '/vehicles/veh-1') { await json(route, vehicle); return true }
    if (path === '/vehicles/veh-1/tours') { await json(route, [activeTour]); return true }
    if (path === '/vehicles/veh-1/timeline') { await json(route, { vehicle, tours: [activeTour], items: [] }); return true }
    if (path === '/vehicles/veh-1/current-position') { await json(route, { vehicleId: vehicle.id, tourId: activeTour.id, status: 'ARRIVED', coordinate: [13.405, 52.52] }); return true }
    if (path === '/vehicles/veh-1/operations') { await json(route, { vehicleId: vehicle.id, version: 1, clock: null, preliminary: true, manualStoppedAt: null, position: { status: 'ARRIVED' }, currentStop: loadStop, dwellMinutes: null, clockProposals: [], traffic: null }); return true }
    if (path === '/stops/stop-load/arrival') { arrivalBody = route.request().postDataJSON(); await json(route, { ok: true }); return true }
    return false
  })
  await page.goto('/vehicles/veh-1')
  await page.getByRole('button', { name: 'Подтвердить прибытие', exact: true }).click()
  await expect.poll(() => arrivalBody).not.toBeNull()
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
    if (path === '/stops/stop-load/loaded') { loaded = true; await json(route, activeTour); return true }
    return false
  })
  await page.goto('/vehicles/veh-1')
  await page.getByRole('button', { name: 'ЗАГРУЖЕНО' }).evaluate((element: HTMLButtonElement) => element.click())
  await expect.poll(() => loaded).toBe(true)
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
  expect(updatedPayload).toMatchObject({ vehicleId: 'veh-1', orderNumber: 'A-301' })
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
