import { expect, test, type Route } from '@playwright/test'

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}
const field = (score: number, level: 'OK' | 'CHECK' | 'DOUBT', reasons: string[] = [], evidence: string | null = null) => ({ score, level, reasons, evidence })
const ok = field(0.95, 'OK')

test('поле под сомнением держит «Подтвердить», пока его не исправят или не отметят «Верно»', async ({ page }) => {
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, '')
    if (path === '/auth/session') return json(route, { authenticated: true, role: 'dispatcher', csrfToken: 'e2e', dispatcherId: 'd1', displayName: 'Anna', onboardingCompletedAt: '2026-11-01T00:00:00Z' })
    if (path === '/notifications') return json(route, { notifications: [] })
    if (path === '/customers') return json(route, { customers: [] })
    if (path === '/vehicles') return json(route, [{ id: 'v1', vehicleNumber: '321', licensePlate: null, maxSpeedKmh: 85 }])
    if (path === '/geocode') return json(route, { address: 'x', latitude: 53.08, longitude: 8.8, city: 'Bremen', provider: 'e2e' })
    if (path === '/imports/pdf/preview') return json(route, { source: 'OPENAI', detectedLayout: 'PDF', documentKind: 'ORDER', aiAvailable: true, documentId: 'doc-1', warnings: [], customer: null,
      drafts: [{ orderNumber: '71123515', vehicleNumber: '321', vehiclePlate: null, trailerPlate: null, tourRemarks: 'Hydro Crimmitschau für Seifert Bremen', warnings: [],
        orderConfidence: { orderNumber: ok }, confidenceSummary: { doubt: 2, check: 1 },
        stops: [
          { sequence: 1, type: 'LOAD', company: 'Hydro', address: 'Robert-Koch-Str. 4, 08451 Crimmitschau', city: 'Crimmitschau', appointmentLocal: '2026-11-01T08:00', confidence: 0.9,
            fieldConfidence: { type: ok, company: ok, address: ok, city: ok, time: field(0.3, 'DOUBT', ['DATE_PAST'], '01.11. 08:00') } },
          { sequence: 2, type: 'UNLOAD', company: 'Seifert', address: 'Bremen', city: 'Bremen', appointmentLocal: null, confidence: 0.4,
            fieldConfidence: { type: ok, company: field(0.6, 'CHECK', ['PLACEHOLDER']), address: field(0.4, 'DOUBT', ['PLACEHOLDER', 'ADDRESS_NO_HOUSE_NUMBER']), city: ok } }
        ] }] })
    return json(route, [])
  })
  await page.route('https://tile.openstreetmap.org/**', (route) => route.abort())

  await page.goto('/orders/new')
  await page.locator('main input[type="file"][multiple]').first().setInputFiles({ name: 'auftrag.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7 e2e') })
  const summary = page.getByRole('status').filter({ hasText: 'Под сомнением' })
  await expect(summary).toContainText('Под сомнением: 2')
  await expect(summary).toContainText('Проверить: 1')
  await expect(page.getByText('Адрес — под сомнением: только название из Tourbemerkung, нет улицы с номером дома')).toBeVisible()
  await expect(page.getByText(/Время — под сомнением: дата уже прошла · в документе: «01\.11\. 08:00»/)).toBeVisible()
  const confirm = page.getByRole('button', { name: 'Подтвердить' })
  await expect(confirm).toBeDisabled()


  // The date really is the printed one: «Верно».
  await page.getByRole('button', { name: 'Время: значение верно' }).click()
  await expect(summary).toContainText('Под сомнением: 1')
  await expect(confirm).toBeDisabled()

  // The address is completed in the stop editor: the change settles the doubt.
  const unloading = page.locator('article[id^="order-stop-"]').nth(1)
  await unloading.getByRole('button').first().click()
  await unloading.getByLabel('Адрес', { exact: true }).fill('Hafenstraße 5, 28197 Bremen')
  await expect(page.getByRole('status').filter({ hasText: 'Под сомнением' })).toHaveCount(0)
  await expect(page.getByText('Проверьте поля, отмеченные жёлтым: 1.')).toBeVisible()
  await expect(confirm).toBeEnabled()
})
