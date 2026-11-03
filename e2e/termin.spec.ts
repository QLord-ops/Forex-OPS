import { expect, test, type Route } from '@playwright/test'

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

const vehicle = { id: 'veh-900', vehicleNumber: '900', licensePlate: 'GÖ-FX900', maxSpeedKmh: 85 }
const document = {
  kind: 'VW_FAHRTENSCHEIN', documentType: 'LKWcontrol Fahrtenschein', plate: 'GÖ-FX900', trailerPlate: null, company: 'Beispielwerk München', site: null, city: 'München',
  stopType: 'UNLOAD', appointmentLocal: '2026-11-04T11:00', windowStartLocal: null, windowEndLocal: null, references: [{ label: 'Fahrt-ID', value: 'T00000000000001' }],
  positions: ['A36 Entladung 4 LE'], sourceExcerpt: 'Geplante Ankunft 04.11.2026 11:00', confidence: 0.9, warnings: [], fingerprint: `termin-${'a'.repeat(64)}`
}
const candidate = { stopId: 'stop-m', tourId: 'tour-m', vehicleId: vehicle.id, vehicleNumber: '900', licensePlate: 'GÖ-FX900', orderNumber: 'A-900', tourStatus: 'ACTIVE', planVersion: 4,
  sequence: 2, type: 'UNLOAD', company: 'Beispielwerk', address: 'Werkstraße 1, 80995 München', city: 'München', appointmentAt: null, windowStartAt: null, windowEndAt: null,
  score: 285, reasons: ['LKW 900', 'город München', 'выгрузка'] }

async function setup(page: import('@playwright/test').Page, match: unknown) {
  const calls: Record<string, unknown> = {}
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, '')
    if (path === '/auth/session') return json(route, { authenticated: true, role: 'dispatcher', csrfToken: 'e2e' })
    if (path === '/notifications') return json(route, { notifications: [] })
    if (path === '/imports/pdf/preview') return json(route, { source: 'OPENAI', detectedLayout: 'PDF', documentKind: 'APPOINTMENT', appointment: document, match, previous: null, drafts: [], warnings: [], aiAvailable: true })
    if (path === '/stops/stop-m/appointment/preview') return json(route, { stopId: 'stop-m', tourId: 'tour-m', vehicleId: vehicle.id, version: 4, generatedAt: new Date().toISOString(),
      appointmentAt: '2026-11-04T10:00:00.000Z', earliestArrival: null, latestArrival: null, recommendedStartAt: '2026-11-04T05:40:00.000Z', bufferMinutes: 30, risk: 'ON_TIME', action: 'LEAVE_BY', message: '', preliminary: false })
    if (path === '/appointments/from-document') { calls.apply = route.request().postDataJSON(); return json(route, { stopId: 'stop-m', vehicleId: vehicle.id, version: 5 }) }
    if (path === '/appointments/pending' && route.request().method() === 'POST') { calls.pending = route.request().postDataJSON(); return json(route, { id: 'p1', status: 'PENDING' }) }
    if (path === '/vehicles') return json(route, [vehicle])
    if (path.startsWith('/vehicles/')) return json(route, path.endsWith('/tours') ? [] : vehicle)
    return json(route, { error: `Unhandled e2e endpoint: ${path}` }, 404)
  })
  await page.route('https://tile.openstreetmap.org/**', (route) => route.abort())
  return calls
}

test('термин из PDF: проверка, найденная точка, риск и «Применить»', async ({ page }) => {
  const calls = await setup(page, { status: 'MATCHED', vehicle: { status: 'MATCHED', vehicleId: vehicle.id, vehicleNumber: '900', plate: 'GÖ-FX900' }, candidates: [candidate] })
  await page.goto('/orders/new')
  await page.getByRole('main').locator('input[type="file"]').setInputFiles({ name: 'Delivery_Slip.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7 termin') })

  const review = page.getByRole('dialog', { name: 'Проверка термина' })
  await expect(review).toContainText('Проверка термина · Fahrtenschein')
  await expect(review).toContainText('LKW 900 найдена')
  await expect(review.getByLabel('Время термина')).toHaveValue('2026-11-04T11:00')
  await expect(review).toContainText('город München')
  await expect(review.getByRole('radio', { name: /LKW 900 · A-900/ })).toBeChecked()
  await expect(review).toContainText('Успевает')
  await review.getByRole('button', { name: 'Применить' }).click()
  await expect.poll(() => calls.apply).toMatchObject({ stopId: 'stop-m', version: 4, fingerprint: document.fingerprint, document: { appointmentLocal: '2026-11-04T11:00', windowStartLocal: null } })
})

test('термин без тура сохраняется как ожидающий', async ({ page }) => {
  const calls = await setup(page, { status: 'NONE', vehicle: { status: 'NOT_FOUND', plate: 'GÖ-FX900' }, candidates: [] })
  await page.goto('/orders/new')
  await page.getByRole('main').locator('input[type="file"]').setInputFiles({ name: 'Deckblatt.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7 termin') })
  const review = page.getByRole('dialog', { name: 'Проверка термина' })
  await expect(review).toContainText('Подходящей точки нет')
  await expect(review.getByRole('button', { name: 'Применить' })).toBeDisabled()
  await review.getByRole('button', { name: 'Сохранить как ожидающий' }).click()
  await expect.poll(() => calls.pending).toMatchObject({ fingerprint: document.fingerprint, document: { company: 'Beispielwerk München' } })
  await expect(review).toHaveCount(0)
})
