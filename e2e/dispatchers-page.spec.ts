import { expect, test, type Page, type Route } from '@playwright/test'

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

const recent = new Date(Date.now() - 40 * 60_000).toISOString()
const accounts = [
  { id: 'd-chef', login: 'chef', displayName: 'Chef Admin', role: 'admin', active: true, lastLoginAt: recent, createdAt: '2026-11-01T00:00:00Z', onboardingCompletedAt: '2026-11-01T00:00:00Z',
    lines: [{ lineId: 'nord', isPrimary: false }, { lineId: 'tesla', isPrimary: true }] },
  { id: 'd-ben', login: 'ben.h', displayName: 'Ben Hoffmann', role: 'dispatcher', active: true, lastLoginAt: recent, createdAt: '2026-11-01T00:00:00Z', onboardingCompletedAt: '2026-11-02T00:00:00Z',
    lines: [{ lineId: 'dsv', isPrimary: true }] },
  { id: 'd-dmitri', login: 'dmitri.s', displayName: 'Dmitri Sokol', role: 'dispatcher', active: true, lastLoginAt: null, createdAt: '2026-11-01T00:00:00Z', onboardingCompletedAt: null, lines: [] },
  { id: 'd-erik', login: 'erik.l', displayName: 'Erik Lang', role: 'dispatcher', active: false, lastLoginAt: '2026-11-11T08:25:00Z', createdAt: '2026-11-01T00:00:00Z', onboardingCompletedAt: null, lines: [] }
]
const customers = [
  { id: 'c-sn', name: 'Schnellecke', lines: [{ id: 'nord', name: 'Nord' }] },
  { id: 'c-walter', name: 'Walter (Tesla)', lines: [{ id: 'tesla', name: 'Tesla' }] },
  { id: 'c-dsv', name: 'DSV', lines: [{ id: 'dsv', name: 'DSV' }] }
]

async function signedIn(page: Page, theme: 'light' | 'dark' = 'light') {
  const resets: unknown[] = []
  await page.addInitScript((value) => { try { localStorage.setItem('ops-theme', value) } catch { /* private mode */ } }, theme)
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, '')
    if (path === '/auth/session') return json(route, { authenticated: true, role: 'admin', csrfToken: 'e2e', dispatcherId: 'd-chef', displayName: 'Chef Admin', onboardingCompletedAt: '2026-11-01T00:00:00Z' })
    if (path === '/notifications') return json(route, { notifications: [] })
    if (path === '/customers') return json(route, { customers })
    if (path === '/dispatchers') return json(route, accounts)
    if (path === '/dispatchers/d-ben/password') { resets.push(route.request().postDataJSON()); return json(route, { ok: true }) }
    return json(route, [])
  })
  await page.route('https://tile.openstreetmap.org/**', (route) => route.abort())
  return resets
}

test('диспетчеры: линии метками, фильтры, сброс пароля под строкой', async ({ page }) => {
  const resets = await signedIn(page)
  await page.goto('/dispatchers')
  await expect(page.getByRole('heading', { name: 'Диспетчеры' })).toBeVisible()
  // The form waits behind its button.
  await expect(page.getByPlaceholder('anna.b')).toHaveCount(0)
  await page.getByRole('button', { name: 'Новый диспетчер' }).click()
  await expect(page.getByPlaceholder('anna.b')).toBeVisible()
  await page.getByRole('button', { name: 'Отмена' }).click()
  await expect(page.getByPlaceholder('anna.b')).toHaveCount(0)

  const rows = page.getByRole('table').locator('tbody > tr')
  await expect(rows).toHaveCount(3)
  await expect(page.getByRole('row', { name: /Chef Admin.*это вы/ })).toContainText('Walter (Tesla) · Teslaосновная')
  await expect(page.getByRole('row', { name: /Dmitri Sokol/ })).toContainText('Нет линий — видит только взятые машины')
  await expect(page.getByRole('row', { name: /Dmitri Sokol/ })).toContainText('ещё не входил')
  await expect(page.getByRole('row', { name: /Ben Hoffmann/ })).toContainText(/сегодня, \d\d:\d\d|вчера, \d\d:\d\d/)

  const filters = page.getByRole('group', { name: 'Показать' })
  await filters.getByRole('button', { name: /Без линий/ }).click()
  await expect(rows).toHaveCount(1)
  await filters.getByRole('button', { name: /Отключённые/ }).click()
  await expect(page.getByRole('row', { name: /Erik Lang/ })).toContainText('11.11, 09:25')
  await expect(page.getByRole('row', { name: /Erik Lang/ }).getByRole('button', { name: 'Включить' })).toBeVisible()
  await filters.getByRole('button', { name: /Активные/ }).click()
  await page.getByLabel('Найти диспетчера по имени, логину или линии').fill('dsv')
  await expect(rows).toHaveCount(1)
  await page.getByLabel('Найти диспетчера по имени, логину или линии').fill('')

  const ben = page.getByRole('row', { name: /Ben Hoffmann/ })
  await ben.getByRole('button', { name: 'Сбросить пароль' }).click()
  await page.getByLabel('Новый пароль для Ben Hoffmann').fill('ben long password')
  await page.getByRole('button', { name: 'Сохранить' }).click()
  await expect(page.getByRole('status')).toContainText('Пароль для Ben Hoffmann изменён')
  expect(resets).toEqual([{ password: 'ben long password' }])

  // Nothing in the table breaks into syllables at office width.
  for (const button of await page.locator('.accounts-actions button').all()) {
    const box = (await button.boundingBox())!
    expect(box.height).toBeLessThanOrEqual(40)
  }
  if (process.env.ACCOUNTS_SHOTS) await page.screenshot({ path: 'test-results/accounts-light.png', fullPage: true })
})

for (const theme of ['light', 'dark'] as const) {
  test(`диспетчеры на телефоне, ${theme === 'dark' ? 'Ночная смена' : 'дневная тема'}: карточки не вылезают за экран`, async ({ page }) => {
    await page.setViewportSize({ width: 393, height: 851 })
    await signedIn(page, theme)
    await page.goto('/dispatchers')
    await expect(page.getByRole('row', { name: /Ben Hoffmann/ })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
    for (const row of await page.getByRole('table').locator('tbody > tr').all()) {
      const box = (await row.boundingBox())!
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width).toBeLessThanOrEqual(393 + 0.5)
    }
    if (process.env.ACCOUNTS_SHOTS) await page.screenshot({ path: `test-results/accounts-phone-${theme}.png`, fullPage: true })
  })
}

test('диспетчеры, Ночная смена на компьютере', async ({ page }) => {
  test.skip(!process.env.ACCOUNTS_SHOTS, 'only for screenshots')
  await signedIn(page, 'dark')
  await page.goto('/dispatchers')
  await page.getByRole('row', { name: /Ben Hoffmann/ }).getByRole('button', { name: 'Сбросить пароль' }).click()
  await page.screenshot({ path: 'test-results/accounts-dark.png', fullPage: true })
})
