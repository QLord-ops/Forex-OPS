import { expect, test, type Route } from '@playwright/test'

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

test('Auftrag с выгрузкой и Leergut на одном заводе: две точки, «Общий Termin с точкой 2»', async ({ page }) => {
  const vehicle = { id: 'veh-1', vehicleNumber: '125', licensePlate: 'B-125', maxSpeedKmh: 85 }
  const plant = 'Industriestraße Nord 1, 38239 Salzgitter'
  const preview = { source: 'OPENAI', detectedLayout: 'PDF', documentKind: 'ORDER', warnings: [], aiAvailable: true, documentId: 'doc-7',
    drafts: [{ orderNumber: '20566299', vehicleNumber: '125', vehiclePlate: null, trailerPlate: null, tourRemarks: 'Hydro Crimmitschau für VW SZ',
      warnings: [{ code: 'SHARED_TERMIN', message: 'Выгрузка и загрузка в Salzgitter — одно место: общий Termin 08:00 стоит на точке 2.' }],
      stops: [
        { sequence: 1, type: 'LOAD', company: 'Hydro Aluminium', address: 'Gewerbering 1, 08451 Crimmitschau', city: 'Crimmitschau', appointmentLocal: null, confidence: 1 },
        { sequence: 2, type: 'UNLOAD', company: 'Volkswagen AG', address: plant, city: 'Salzgitter', appointmentLocal: '2026-11-12T08:00', confidence: 1 },
        { sequence: 3, type: 'LOAD', company: 'Volkswagen AG', address: plant, city: 'Salzgitter', appointmentLocal: null, instructions: 'Leergut', terminRequired: false, samePlaceAsPrevious: true, confidence: 1 }
      ] }] }
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, '')
    if (path === '/auth/session') return json(route, { authenticated: true, role: 'dispatcher', csrfToken: 'e2e', dispatcherId: 'd-anna', displayName: 'Anna', onboardingCompletedAt: '2026-11-01T00:00:00Z' })
    if (path === '/notifications') return json(route, { notifications: [] })
    if (path === '/customers') return json(route, { customers: [] })
    if (path === '/vehicles' && route.request().method() === 'GET') return json(route, [vehicle])
    if (path === '/imports/pdf/preview') return json(route, preview)
    if (path === '/geocode' || path === '/geocode/resolve') return json(route, { address: 'x', latitude: 52.1, longitude: 10.3, city: 'x', provider: 'e2e', sourceAddress: 'x', resolvedAddress: 'x', precision: 'EXACT', attempts: [] })
    if (path.startsWith('/vehicles/veh-1')) return json(route, path.endsWith('/tours') ? [] : vehicle)
    return json(route, [])
  })
  await page.route('https://tile.openstreetmap.org/**', (route) => route.abort())

  await page.goto('/vehicles')
  await page.getByRole('button', { name: /меню$/ }).click()
  await page.getByRole('button', { name: 'ИИ-диспетчер' }).click()
  await page.getByRole('button', { name: 'Прикрепить Auftrag' }).click()
  await page.locator('.dispatcher-import-host input[type="file"]').setInputFiles({ name: 'auftrag.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7 e2e') })
  await expect(page.getByLabel('Номер Auftrag')).toHaveValue('20566299')
  const review = page.getByRole('region', { name: 'Проверка Auftrag' })
  const stops = review.getByRole('article')
  await expect(stops).toHaveCount(3)
  await expect(stops.nth(2)).toContainText('Общий Termin с точкой 2 · ')
  await expect(stops.nth(2)).not.toContainText('Termin нужен')
  await expect(stops.nth(2)).not.toContainText('Без срока')
  await expect(stops.nth(1)).not.toContainText('Общий Termin')
  await expect(review.getByText('Выгрузка и загрузка в Salzgitter — одно место: общий Termin 08:00 стоит на точке 2.')).toBeVisible()

  await page.setViewportSize({ width: 393, height: 851 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
  if (process.env.D2_SHOTS) { await stops.nth(2).scrollIntoViewIfNeeded(); await page.screenshot({ path: 'test-results/d2-shared-393.png' }) }
})
