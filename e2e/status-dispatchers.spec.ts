import { expect, test, type Page, type Route } from '@playwright/test'

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
const anna = { id: 'd-anna', name: 'Anna Schmidt', source: 'LINE', active: true }
const ben = { id: 'd-ben', name: 'Ben Muster', source: 'TAKEN', active: true }
const base = { bemerkung: null, weNortheim: null, servicePhone: null, aSchild: false, appSped: true, ortSource: 'WEBFLEET', trailerSource: null, version: 1, edited: false, flags: [] as string[],
  startKind: 'NONE', ankunftKind: 'NONE', bemerkungAuto: 'Fahrzeug ist leer', rule: 'EMPTY' }
const shown = (ort: string) => ({ ort, start: '', ziel: '', ankunft: '', bemerkung: 'Fahrzeug ist leer', trailer: '' })
const report = { id: 'rep', line: 'SCHNELLECKE', date: today, status: 'READY', preliminary: false, generatedAt: `${today}T06:00:00.000Z`, generatedByRole: 'system' }
const list = { key: 'SCHNELLECKE', name: 'Schnellecke', dueLocalTime: '07:00', auto: true, groups: [{ code: 'NORD', name: 'NORD' }, { code: 'SUED', name: 'SÜD' }, { code: 'LUFE', name: 'LuFe' }],
  columns: { we: 'WE in Northeim', aSchild: true, appSped: true } }

async function mock(page: Page, role: 'admin' | 'dispatcher') {
  const seen = { exports: [] as string[], assignment: null as unknown }
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname.replace(/^\/api/, '')
    if (path === '/auth/session') return json(route, { authenticated: true, role, csrfToken: 'e2e', dispatcherId: 'd-anna', displayName: 'Anna Schmidt', onboardingCompletedAt: '2026-11-01T00:00:00Z' })
    if (path === '/notifications') return json(route, { notifications: [] })
    if (path === '/daily-status') {
      const taken = Boolean(seen.assignment)
      const rows = [
        { ...base, id: 'r1', vehicleId: 'v1', vehicleNumber: '9724', statusGroup: 'NORD', shown: shown('Emden'), owner: anna },
        { ...base, id: 'r2', vehicleId: 'v2', vehicleNumber: '720', statusGroup: 'NORD', shown: shown('München'), owner: ben },
        { ...base, id: 'r3', vehicleId: 'v3', vehicleNumber: '124', statusGroup: 'SUED', shown: shown('Ingolstadt'), owner: taken ? { ...anna, source: 'TAKEN' } : null }
      ]
      const owners = [{ id: 'd-anna', name: 'Anna Schmidt', active: true, count: taken ? 2 : 1 }, { id: 'd-ben', name: 'Ben Muster', active: true, count: 1 }]
      return json(route, { date: today, editable: true, report, list, lists: [{ key: 'SCHNELLECKE', name: 'Schnellecke', auto: true }, { key: 'GEIS', name: 'Geis', auto: false }],
        rows, owners, viewer: { dispatcherId: 'd-anna', role } })
    }
    if (path === '/vehicles/v3/assignment') {
      seen.assignment = route.request().postDataJSON()
      return json(route, { vehicleId: 'v3', assignedTo: { id: 'd-anna', name: 'Anna Schmidt' } })
    }
    if (path === `/daily-status/${today}/export.xlsx`) {
      seen.exports.push(url.search)
      return route.fulfill({ status: 200, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', body: Buffer.from('PK e2e') })
    }
    return json(route, [])
  })
  await page.route('https://tile.openstreetmap.org/**', (route) => route.abort())
  return seen
}

test('диспетчер: «Мои машины» и свой Excel, «Все по диспетчерам», чужая строка без правки, «Взять» ничью машину', async ({ page }) => {
  const seen = await mock(page, 'dispatcher')
  await page.goto('/status')
  await expect(page.getByRole('heading', { name: 'Статус Schnellecke' })).toBeVisible()
  await expect(page.getByRole('tab', { name: 'Geis вручную' })).toBeVisible()
  await expect(page.getByRole('button', { name: /Мои машины/ })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('row', { name: /9724/ })).toBeVisible()
  await expect(page.getByRole('row', { name: /720/ })).toHaveCount(0)
  await expect(page.getByText('1 машина Schnellecke ни у кого: 124 — посмотрите в «Все по диспетчерам».')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Скачать весь список' })).toHaveCount(0)

  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Скачать мой Excel' }).click()
  expect((await download).suggestedFilename()).toBe(`Status ${today}.xlsx`)
  expect(seen.exports).toEqual(['?owner=mine'])

  await page.getByRole('button', { name: /Все по диспетчерам/ }).click()
  await expect(page.getByRole('heading', { level: 3 })).toHaveText([/^Anna Schmidt \(вы\)/, /^Ben Muster/, /^Ничьи/])
  await expect(page.getByRole('button', { name: 'Изменить Bemerkung LKW 9724' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Изменить Bemerkung LKW 720' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Изменить Bemerkung LKW 124' })).toBeVisible()
  await expect(page.getByRole('button', { name: /^Скачать Excel:/ })).toHaveCount(0)
  await expect(page.getByText('Их статус не попадёт ни в чей Excel.', { exact: false })).toBeVisible()

  await page.setViewportSize({ width: 393, height: 851 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
  if (process.env.STATUS_SHOTS) await page.screenshot({ path: 'test-results/status-dispatchers-393.png', fullPage: true })
  await page.setViewportSize({ width: 1280, height: 900 })

  await page.getByRole('button', { name: 'Взять себе LKW 124' }).click()
  await expect.poll(() => seen.assignment).toEqual({ action: 'take', expectedDispatcherId: null })
  await expect(page.getByRole('heading', { level: 3 })).toHaveText([/^Anna Schmidt \(вы\)/, /^Ben Muster/])
})

test('админ: по умолчанию все по диспетчерам, весь список и Excel каждого', async ({ page }) => {
  const seen = await mock(page, 'admin')
  await page.goto('/status')
  await expect(page.getByRole('button', { name: /Все по диспетчерам/ })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('button', { name: 'Изменить Bemerkung LKW 720' })).toBeVisible()
  if (process.env.STATUS_SHOTS) await page.screenshot({ path: 'test-results/status-dispatchers-admin.png', fullPage: true })
  const whole = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Скачать весь список' }).click()
  await whole
  const bens = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Скачать Excel: Ben Muster' }).click()
  await bens
  const nobodys = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Скачать Excel: ничьи машины' }).click()
  await nobodys
  expect(seen.exports).toEqual(['', '?owner=d-ben', '?owner=none'])
})
