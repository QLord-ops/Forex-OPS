import { expect, test, type Route } from '@playwright/test'

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

test('неизвестное сокращение: вопрос «Что значит «QX»?», ответ запоминается и Auftrag пересчитывается', async ({ page }) => {
  const vehicle = { id: 'veh-1', vehicleNumber: '125', licensePlate: 'B-125', maxSpeedKmh: 85 }
  const load = { sequence: 1, type: 'LOAD', company: 'Hydro Aluminium', address: 'Gewerbering 1, 08451 Crimmitschau', city: 'Crimmitschau', appointmentLocal: null, confidence: 1 }
  const question = { code: 'UNKNOWN_ABBREVIATION', stopIndex: 1, field: 'city', abbreviation: 'QX', options: ['Crimmitschau', 'Salzgitter', 'Wolfsburg'],
    message: 'Сокращение «QX» в Tourbemerkung («VW QX») не расшифровано. Напишите, что оно значит, — оно запомнится для следующих Auftrag.' }
  const preview = (taught: boolean) => ({ source: 'OPENAI', detectedLayout: 'PDF', documentKind: 'ORDER', warnings: [], aiAvailable: true, documentId: 'doc-3',
    drafts: [{ orderNumber: '20566263', vehicleNumber: '125', vehiclePlate: null, trailerPlate: null, tourRemarks: 'Hydro Crimmitschau für VW QX', warnings: taught ? [] : [question], stops: [load, taught
      ? { sequence: 2, type: 'UNLOAD', company: 'Volkswagen AG', address: 'Industriestraße Nord 1, 38239 Salzgitter', city: 'Salzgitter', appointmentLocal: null, confidence: 1 }
      : { sequence: 2, type: 'UNLOAD', company: 'Volkswagen AG', address: 'QX', city: 'QX', appointmentLocal: null, confidence: 0.4 }] }] })
  const calls: Array<{ path: string; body: unknown }> = []
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, '')
    if (path === '/auth/session') return json(route, { authenticated: true, role: 'dispatcher', csrfToken: 'e2e', dispatcherId: 'd-anna', displayName: 'Anna', onboardingCompletedAt: '2026-11-01T00:00:00Z' })
    if (path === '/notifications') return json(route, { notifications: [] })
    if (path === '/customers') return json(route, { customers: [] })
    if (path === '/vehicles' && route.request().method() === 'GET') return json(route, [vehicle])
    if (path === '/imports/pdf/preview') return json(route, preview(false))
    if (path === '/address-rules/city-codes') { calls.push({ path, body: route.request().postDataJSON() }); return json(route, { id: 'rule-1', pattern: 'qx', kind: 'CITY_CODE', city: 'Salzgitter' }, 201) }
    if (path === '/documents/doc-3/refresh') { calls.push({ path, body: route.request().postDataJSON() }); return json(route, preview(true)) }
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
  await expect(page.getByLabel('Номер Auftrag')).toHaveValue('20566263')
  const review = page.getByRole('region', { name: 'Проверка Auftrag' })
  const form = review.getByRole('form', { name: 'Расшифровка QX' })
  await expect(form.getByText('Что значит «QX»?')).toBeVisible()
  await expect(form.getByRole('button', { name: 'Запомнить' })).toBeDisabled()
  await expect(form.getByRole('group', { name: 'Города из этого Auftrag' }).getByRole('button')).toHaveText(['Crimmitschau', 'Salzgitter', 'Wolfsburg'])

  await page.setViewportSize({ width: 393, height: 851 })
  const reviewBox = (await review.boundingBox())!
  for (const item of await form.locator('button, input, p').all()) {
    const box = (await item.boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(reviewBox.x)
    expect(box.x + box.width).toBeLessThanOrEqual(reviewBox.x + reviewBox.width + 0.5)
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
  if (process.env.B_SHOTS) { await form.scrollIntoViewIfNeeded(); await page.screenshot({ path: 'test-results/b-question-393.png' }) }

  await form.getByLabel('Город для «QX»').fill('Salzgitter')
  await form.getByRole('button', { name: 'Запомнить' }).click()
  await expect(review.getByRole('status').filter({ hasText: 'Запомнено: QX = Salzgitter. Auftrag пересчитан.' })).toBeVisible()
  await expect(review.getByRole('form', { name: 'Расшифровка QX' })).toHaveCount(0)
  await expect(review.getByText('Industriestraße Nord 1, 38239 Salzgitter').first()).toBeVisible()
  expect(calls).toEqual([
    { path: '/address-rules/city-codes', body: { code: 'QX', city: 'Salzgitter' } },
    { path: '/documents/doc-3/refresh', body: { customerId: null } }
  ])
})
