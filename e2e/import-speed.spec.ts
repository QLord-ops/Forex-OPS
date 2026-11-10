import { expect, test, type Page, type Route } from '@playwright/test'

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}
const plain = (text: string | null) => (text ?? '').replace(/\u00a0/g, ' ')

const readStats = { model: 'gpt-5.4-mini', effort: 'low', serviceTier: 'priority', readMode: 'text', extractMs: 200, modelMs: 6100, postMs: 300,
  inputTokens: 6210, cachedTokens: 3072, outputTokens: 1480, reasoningTokens: 0, settingsRejected: false, contextMs: 100, totalMs: 6700 }
const summary = { documents: 100, count: 40, targetMs: 10_000, medianMs: 7200, p90Ms: 31_000, modelMedianMs: 6100, withinTarget: 36, cachedShare: 0.49,
  inputTokensMedian: 6210, outputTokensMedian: 1480, reasoningTokensMedian: 0, modes: { text: 34, file: 4, image: 2 }, settingsRejected: 3,
  lastReadAt: '2026-11-09T08:05:00.000Z', last: { model: 'gpt-5.4-mini', effort: 'low', serviceTier: 'default' }, configured: { effort: 'none', serviceTier: 'priority' } }

async function signedIn(page: Page, role: 'admin' | 'dispatcher', handler: (route: Route, path: string) => Promise<boolean> = async () => false) {
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, '')
    if (path === '/auth/session') return json(route, { authenticated: true, role, csrfToken: 'e2e', dispatcherId: 'd-anna', displayName: 'Anna', onboardingCompletedAt: '2026-11-01T00:00:00Z' })
    if (path === '/notifications') return json(route, { notifications: [] })
    if (path === '/customers') return json(route, { customers: [] })
    if (path === '/import-rules') return json(route, { rules: [], builtIn: [], corrections: { last7d: 0 } })
    if (path === '/address-rules') return json(route, { rules: [], builtIn: [] })
    if (await handler(route, path)) return
    return json(route, [])
  })
  await page.route('https://tile.openstreetmap.org/**', (route) => route.abort())
}

test('админ видит в Настройках скорость распознавания, на телефоне карточка не вылезает', async ({ page }) => {
  let measured = true
  await signedIn(page, 'admin', async (route, path) => {
    if (path === '/imports/stats') { await json(route, measured ? summary : { ...summary, count: 0, medianMs: null, p90Ms: null }); return true }
    return false
  })
  await page.goto('/settings')
  const card = page.getByRole('region', { name: 'Скорость распознавания' })
  await expect(card.locator('.speed-verdict')).toBeVisible()
  expect(plain(await card.locator('.speed-verdict').textContent())).toBe('Медиана 7,2 с, 90 % — до 31 с. Обычно быстрее 10 с, но каждый десятый Auftrag дольше.')
  const rows = plain(await card.locator('.speed-rows').innerText())
  expect(rows).toContain('36 из 40 (90 %)')
  expect(rows).toContain('вход 6 210, выход 1 480')
  expect(rows).toContain('рассуждение none, быстрый режим')
  await expect(card.getByRole('alert')).toContainText('OpenAI отклонил настройки скорости в 3 из 40 разборов')

  await page.setViewportSize({ width: 393, height: 851 })
  const cardBox = (await card.boundingBox())!
  for (const row of await card.locator('.speed-rows dd, .speed-rows dt, .speed-verdict').all()) {
    const box = (await row.boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(cardBox.x)
    expect(box.x + box.width).toBeLessThanOrEqual(cardBox.x + cardBox.width + 0.5)
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

  measured = false
  await card.getByRole('button', { name: 'Обновить' }).click()
  await expect(card).toContainText('Замеров пока нет')
  await expect(card.locator('.speed-verdict')).toHaveCount(0)
})

test('диспетчеру карточка скорости не показывается и замер не запрашивается', async ({ page }) => {
  let asked = false
  await signedIn(page, 'dispatcher', async (_route, path) => { if (path === '/imports/stats') asked = true; return false })
  await page.goto('/settings')
  await expect(page.getByRole('region', { name: 'Правила импорта' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Скорость распознавания' })).toHaveCount(0)
  expect(asked).toBe(false)
})

for (const role of ['admin', 'dispatcher'] as const) {
  test(`проверка Auftrag: «распознан за N с» видят все, разбивку времени — ${role === 'admin' ? 'админ видит' : 'диспетчер не видит'}`, async ({ page }) => {
    const vehicle = { id: 'veh-1', vehicleNumber: '125', licensePlate: 'B-125', maxSpeedKmh: 85 }
    await signedIn(page, role, async (route, path) => {
      if (path === '/vehicles' && route.request().method() === 'GET') { await json(route, [vehicle]); return true }
      if (path === '/imports/pdf/preview') {
        await new Promise((resolve) => setTimeout(resolve, 1100))
        await json(route, { source: 'OPENAI', detectedLayout: 'PDF', documentKind: 'ORDER', warnings: [], aiAvailable: true, readMs: 6800, readStats,
          drafts: [{ orderNumber: '71123515', vehicleNumber: '125', vehiclePlate: null, trailerPlate: null, tourRemarks: null, warnings: [], stops: [
            { sequence: 1, type: 'LOAD', company: 'Lager', address: 'Rudolf-Diesel-Straße 2, 14974 Ludwigsfelde', city: 'Ludwigsfelde', appointmentLocal: null, confidence: 1 },
            { sequence: 2, type: 'UNLOAD', company: 'TST Süderelbe', address: 'Dradenauer Deichweg 3, 21129 Hamburg', city: 'Hamburg', appointmentLocal: null, confidence: 1 }
          ] }] })
        return true
      }
      if (path === '/geocode' || path === '/geocode/resolve') { await json(route, { address: 'x', latitude: 53.08, longitude: 8.8, city: 'Hamburg', provider: 'e2e', precision: 'EXACT' }); return true }
      if (path.startsWith('/vehicles/veh-1')) { await json(route, path.endsWith('/tours') ? [] : vehicle); return true }
      return false
    })
    await page.goto('/vehicles')
    await page.getByRole('button', { name: /меню$/ }).click()
    await page.getByRole('button', { name: 'ИИ-диспетчер' }).click()
    await page.getByRole('button', { name: 'Прикрепить Auftrag' }).click()
    await page.locator('.dispatcher-import-host input[type="file"]').setInputFiles({ name: 'auftrag.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7 e2e') })
    await expect(page.getByLabel('Номер Auftrag')).toHaveValue('71123515')
    const review = page.getByRole('region', { name: 'Проверка Auftrag' })
    // The dispatcher's own wait by the browser clock (about a second here), not the 6,8 s the server reported.
    await expect(review.getByText(/Проверка распознавания · распознан за [12] с/)).toBeVisible()
    const line = review.locator('.read-stats-line')
    if (role === 'dispatcher') { await expect(line).toHaveCount(0); return }
    expect(plain(await line.textContent())).toBe('ИИ 6,1 с · текст 0,2 с · проверка 0,4 с · токены: вход 6 210 (кэш 3 072), выход 1 480 · рассуждение low · быстрый режим')
    const reviewBox = (await review.boundingBox())!
    const lineBox = (await line.boundingBox())!
    expect(lineBox.x + lineBox.width).toBeLessThanOrEqual(reviewBox.x + reviewBox.width + 0.5)
  })
}

test('тот же файл второй раз: сохранённый ответ с пометкой, «Прочитать заново ИИ» читает файл заново', async ({ page }) => {
  const vehicle = { id: 'veh-1', vehicleNumber: '125', licensePlate: 'B-125', maxSpeedKmh: 85 }
  const reused = { code: 'DOCUMENT_REUSED', message: 'Этот файл уже читался — показан сохранённый ответ ИИ, разобранный по текущим правилам.' }
  const preview = (warnings: unknown[]) => ({ source: 'OPENAI', detectedLayout: 'PDF', documentKind: 'ORDER', warnings, aiAvailable: true, documentId: 'doc-1', documentReused: true, answerReused: warnings.length > 0,
    drafts: [{ orderNumber: '71123515', vehicleNumber: '125', vehiclePlate: null, trailerPlate: null, tourRemarks: null, warnings: [], stops: [
      { sequence: 1, type: 'LOAD', company: 'Lager', address: 'Rudolf-Diesel-Straße 2, 14974 Ludwigsfelde', city: 'Ludwigsfelde', appointmentLocal: null, confidence: 1 },
      { sequence: 2, type: 'UNLOAD', company: 'TST Süderelbe', address: 'Dradenauer Deichweg 3, 21129 Hamburg', city: 'Hamburg', appointmentLocal: null, confidence: 1 }
    ] }] })
  const reparsed: unknown[] = []
  await signedIn(page, 'dispatcher', async (route, path) => {
    if (path === '/vehicles' && route.request().method() === 'GET') { await json(route, [vehicle]); return true }
    if (path === '/imports/pdf/preview') { await json(route, preview([reused])); return true }
    if (path === '/documents/doc-1/reparse') { reparsed.push(route.request().postDataJSON()); await json(route, { ...preview([]), readMs: 6800 }); return true }
    if (path === '/geocode' || path === '/geocode/resolve') { await json(route, { address: 'x', latitude: 53.08, longitude: 8.8, city: 'Hamburg', provider: 'e2e', precision: 'EXACT' }); return true }
    if (path.startsWith('/vehicles/veh-1')) { await json(route, path.endsWith('/tours') ? [] : vehicle); return true }
    return false
  })
  await page.goto('/vehicles')
  await page.getByRole('button', { name: /меню$/ }).click()
  await page.getByRole('button', { name: 'ИИ-диспетчер' }).click()
  await page.getByRole('button', { name: 'Прикрепить Auftrag' }).click()
  await page.locator('.dispatcher-import-host input[type="file"]').setInputFiles({ name: 'auftrag.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7 e2e') })
  await expect(page.getByLabel('Номер Auftrag')).toHaveValue('71123515')
  const review = page.getByRole('region', { name: 'Проверка Auftrag' })
  await expect(review.getByText('Этот файл уже читался')).toBeVisible()
  const again = review.getByRole('button', { name: 'Прочитать заново ИИ' })
  await expect(again).toBeVisible()

  await page.setViewportSize({ width: 393, height: 851 })
  const reviewBox = (await review.boundingBox())!
  const buttonBox = (await again.boundingBox())!
  expect(buttonBox.x).toBeGreaterThanOrEqual(reviewBox.x)
  expect(buttonBox.x + buttonBox.width).toBeLessThanOrEqual(reviewBox.x + reviewBox.width + 0.5)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
  if (process.env.A2_SHOTS) await page.screenshot({ path: 'test-results/a2-reused-393.png' })

  await again.click()
  await expect(review.getByText('Этот файл уже читался')).toHaveCount(0)
  await expect(again).toHaveCount(0)
  expect(reparsed).toEqual([{ customerId: null }])
})

test('известное место приходит с координатами: ищется только незнакомый адрес, «Подтвердить» не ждёт', async ({ page }) => {
  const vehicle = { id: 'veh-1', vehicleNumber: '125', licensePlate: 'B-125', maxSpeedKmh: 85 }
  const known = { address: 'Volkswagen AG Werk Salzgitter, Industriestraße Nord 1, 38239 Salzgitter', latitude: 52.19, longitude: 10.4, city: 'Salzgitter', provider: 'webfleet-address',
    sourceAddress: 'Industriestraße Nord 1, 38239 Salzgitter', resolvedAddress: 'Volkswagen AG Werk Salzgitter, Industriestraße Nord 1, 38239 Salzgitter', precision: 'EXACT', attempts: [] }
  const asked: Array<{ address: string }> = []
  await signedIn(page, 'dispatcher', async (route, path) => {
    if (path === '/vehicles' && route.request().method() === 'GET') { await json(route, [vehicle]); return true }
    if (path === '/imports/pdf/preview') {
      await json(route, { source: 'OPENAI', detectedLayout: 'PDF', documentKind: 'ORDER', warnings: [], aiAvailable: true, documentId: 'doc-2',
        drafts: [{ orderNumber: '20566263', vehicleNumber: '125', vehiclePlate: null, trailerPlate: null, tourRemarks: null, warnings: [], stops: [
          { sequence: 1, type: 'LOAD', company: 'Neuer Lieferant', address: 'Unbekannte Straße 9, 08058 Zwickau', city: 'Zwickau', appointmentLocal: null, confidence: 1 },
          { sequence: 2, type: 'UNLOAD', company: 'VW', address: 'Industriestraße Nord 1, 38239 Salzgitter', city: 'Salzgitter', appointmentLocal: null, confidence: 1, resolution: known }
        ] }] })
      return true
    }
    if (path === '/geocode/resolve') {
      asked.push(route.request().postDataJSON() as { address: string })
      await new Promise((resolve) => setTimeout(resolve, 1500))
      await json(route, { address: 'Unbekannte Straße 9, 08058 Zwickau', latitude: 50.7, longitude: 12.5, city: 'Zwickau', provider: 'e2e', sourceAddress: 'Unbekannte Straße 9, 08058 Zwickau', resolvedAddress: 'Unbekannte Straße 9, 08058 Zwickau', precision: 'EXACT', attempts: [] })
      return true
    }
    if (path.startsWith('/vehicles/veh-1')) { await json(route, path.endsWith('/tours') ? [] : vehicle); return true }
    return false
  })
  await page.goto('/vehicles')
  await page.getByRole('button', { name: /меню$/ }).click()
  await page.getByRole('button', { name: 'ИИ-диспетчер' }).click()
  await page.getByRole('button', { name: 'Прикрепить Auftrag' }).click()
  await page.locator('.dispatcher-import-host input[type="file"]').setInputFiles({ name: 'auftrag.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7 e2e') })
  await expect(page.getByLabel('Номер Auftrag')).toHaveValue('20566263')
  const review = page.getByRole('region', { name: 'Проверка Auftrag' })
  // The known place needs no lookup; the unknown one is being looked up and the check is usable meanwhile.
  await expect(review.getByText('Точный адрес подтверждён: Volkswagen AG Werk Salzgitter, Industriestraße Nord 1, 38239 Salzgitter')).toBeVisible()
  await expect(review.getByRole('status').filter({ hasText: 'Ищу адрес на карте' })).toHaveCount(1)
  await expect(review.getByRole('button', { name: 'Подтвердить' })).toBeEnabled()

  await page.setViewportSize({ width: 393, height: 851 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
  if (process.env.A3_SHOTS) await review.getByRole('status').filter({ hasText: 'Ищу адрес на карте' }).scrollIntoViewIfNeeded().then(() => page.screenshot({ path: 'test-results/a3-looking-393.png' }))

  await expect(review.getByText('Точный адрес подтверждён: Unbekannte Straße 9, 08058 Zwickau')).toBeVisible()
  await expect(review.getByRole('status').filter({ hasText: 'Ищу адрес на карте' })).toHaveCount(0)
  expect(asked.map((item) => item.address)).toEqual(['Unbekannte Straße 9, 08058 Zwickau'])
})
