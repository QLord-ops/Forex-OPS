import { expect, test, type Route } from '@playwright/test'

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
const base = { vehicleId: 'v', bemerkung: null, weNortheim: null, servicePhone: null, aSchild: false, appSped: true, ortSource: 'WEBFLEET', trailerSource: null, version: 1, edited: false, flags: [] as string[] }
const rows = [
  { ...base, id: 'r1', vehicleNumber: '9724', statusGroup: 'NORD', rule: 'STUCK', startKind: 'TACHO', ankunftKind: 'ARRIVED', bemerkungAuto: 'Fahrzeug konnte gestern nicht entladen werden', servicePhone: '49 1575 8235111',
    shown: { ort: 'Emden', start: '06:08', ziel: 'Emden', ankunft: '04.11. 18:40', bemerkung: 'Fahrzeug konnte gestern nicht entladen werden', trailer: 'Z-S3280' } },
  { ...base, id: 'r2', vehicleNumber: '720', statusGroup: 'NORD', rule: 'EN_ROUTE', startKind: 'TERMIN_LATEST', ankunftKind: 'TERMIN', bemerkungAuto: null,
    shown: { ort: 'Schlüsselfeld', start: '~06:45', ziel: 'München', ankunft: '11:30', bemerkung: '', trailer: '' } },
  { ...base, id: 'r3', vehicleNumber: '124', statusGroup: 'SUED', rule: 'EMPTY', startKind: 'NONE', ankunftKind: 'NONE', bemerkungAuto: 'Fahrzeug ist leer',
    shown: { ort: 'Ingolstadt', start: '', ziel: '', ankunft: '', bemerkung: 'Fahrzeug ist leer', trailer: '' } },
  { ...base, id: 'r4', vehicleNumber: '777', statusGroup: null, rule: 'EN_ROUTE', startKind: 'DEFAULT', ankunftKind: 'ETA', bemerkungAuto: null, flags: ['GPS_STALE'],
    shown: { ort: 'Kassel', start: '~07:00', ziel: 'Baunatal', ankunft: '~08:10', bemerkung: '', trailer: '' } }
]
const report = { id: 'rep', line: 'SCHNELLECKE', date: today, status: 'READY', preliminary: false, generatedAt: `${today}T06:00:00.000Z`, generatedByRole: 'system' }

test('статус Schnellecke: блоки NORD/SÜD/без группы, оценка старта, правка Bemerkung и скачивание Excel', async ({ page }) => {
  let patched: unknown = null
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname.replace(/^\/api/, '')
    if (path === '/auth/session') return json(route, { authenticated: true, role: 'dispatcher', csrfToken: 'e2e' })
    if (path === '/notifications') return json(route, { notifications: [] })
    if (path === '/daily-status') return json(route, { date: url.searchParams.get('date') ?? today, editable: (url.searchParams.get('date') ?? today) === today, report, rows })
    if (path === '/daily-status/rows/r3' && route.request().method() === 'PATCH') {
      patched = route.request().postDataJSON()
      return json(route, { ...rows[2], version: 2, bemerkung: 'Fahrer hat heute frei', edited: true, shown: { ...rows[2].shown, bemerkung: 'Fahrer hat heute frei' } })
    }
    if (path === `/daily-status/${today}/export.xlsx`) return route.fulfill({ status: 200, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', body: Buffer.from('PK e2e') })
    return json(route, [])
  })
  await page.route('https://tile.openstreetmap.org/**', (route) => route.abort())
  await page.goto('/status')

  await expect(page.getByRole('heading', { name: 'Статус Schnellecke' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Статус' })).toBeVisible()
  const blocks = page.locator('.status-block-title')
  await expect(blocks).toHaveText([/^NORD/, /^SÜD/, /^LuFe/, /^Без группы/])
  await expect(page.getByText('1 машина без группы')).toBeVisible()
  const truck720 = page.getByRole('row', { name: /720/ })
  await expect(truck720.getByText('~06:45')).toHaveAttribute('title', /успеть к Termin/)
  await expect(page.getByRole('row', { name: /9724/ })).toContainText('Fahrzeug konnte gestern nicht entladen werden')
  await expect(page.getByRole('row', { name: /777/ })).toContainText('GPS устарел')
  await page.screenshot({ path: 'test-results/status-page.png', fullPage: true })

  await page.getByRole('button', { name: 'Изменить Bemerkung LKW 124' }).click()
  await page.getByLabel('Bemerkung LKW 124').fill('Fahrer hat heute frei')
  await page.getByRole('button', { name: 'Сохранить' }).click()
  await expect.poll(() => patched).toEqual({ version: 1, bemerkung: 'Fahrer hat heute frei' })
  await expect(page.getByRole('row', { name: /124/ })).toContainText('изменено')

  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Скачать Excel' }).click()
  expect((await download).suggestedFilename()).toBe(`Status ${today}.xlsx`)

  await page.getByLabel('День').fill('2026-01-02')
  await expect(page.getByText('Прошлый день: только просмотр')).toBeVisible()
  await expect(page.getByRole('button', { name: /Изменить Bemerkung/ })).toHaveCount(0)
})
