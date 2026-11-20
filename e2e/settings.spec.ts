import { expect, test, type Page, type Route } from '@playwright/test'

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

const rule = (id: string, pattern: string, hits: number) => ({ id, pattern, company: 'Seifert Logistics', street: 'Senator-Bauer-Str. 10', postalCode: '28197', city: 'Bremen', requiresTermin: false, hits })

async function signedIn(page: Page, role: 'admin' | 'dispatcher', theme: 'light' | 'dark' = 'light') {
  await page.addInitScript((value) => { try { localStorage.setItem('ops-theme', value) } catch { /* private mode */ } }, theme)
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, '')
    if (path === '/auth/session') return json(route, { authenticated: true, role, csrfToken: 'e2e', dispatcherId: 'd-anna', displayName: 'Anna', onboardingCompletedAt: '2026-11-01T00:00:00Z' })
    if (path === '/notifications') return json(route, { notifications: [] })
    if (path === '/customers') return json(route, { customers: [] })
    if (path === '/import-rules') return json(route, { rules: [], builtIn: [], corrections: { last7d: 0 } })
    if (path === '/address-rules') return json(route, { rules: [rule('r1', 'Seifert Bremen', 4), rule('r2', 'VW SZ', 0), rule('r3', 'MB Werk', 0)], builtIn: [] })
    if (path === '/imports/stats') return json(route, { documents: 0, count: 0, medianMs: null, p90Ms: null })
    return json(route, [])
  })
}

test('админ: группы, сводка и пометка «где хранится» у каждого блока, меню ведёт к блоку', async ({ page }) => {
  await signedIn(page, 'admin')
  await page.goto('/settings')
  const nav = page.getByRole('navigation', { name: 'Разделы настроек' })
  await expect(nav.getByRole('link')).toHaveText(['Тема', 'Уведомления', 'Рабочий день', 'Правила адресов', 'Адреса из Auftrag', 'Координаты точек', 'База и заезды',
    'Правила импорта', 'Скорость распознавания', 'Диспетчеры, команда, Webfleet'])

  const scopeOf = (name: string | RegExp) => page.getByRole('region', { name }).locator('.settings-scope')
  await expect(scopeOf('Тема')).toHaveText('Этот браузер')
  await expect(scopeOf('Уведомления')).toHaveText('Этот браузер')
  await expect(scopeOf('Рабочий день')).toHaveText('Этот браузер')
  await expect(scopeOf('Правила адресов')).toHaveText('Общее для всех')
  await expect(scopeOf(/Адреса из Auftrag/)).toHaveText('Общее для всех')
  await expect(scopeOf('Правила импорта')).toHaveText('Общее для всех')
  await expect(scopeOf('Координаты точек')).toHaveText('Только админ')
  await expect(scopeOf('База и заезды')).toHaveText('Только админ')
  await expect(scopeOf('Скорость распознавания')).toHaveText('Только админ')

  const summary = page.getByLabel('Сводка настроек')
  await expect(summary).toContainText('Правила адресов3 · 2 новых')
  await expect(summary).toContainText('Рабочий деньПн–Сб · 06:00–18:00')

  // The working day changed in its block shows in the summary at once.
  await page.getByRole('region', { name: 'Рабочий день' }).getByRole('button', { name: 'Суббота' }).click()
  await expect(summary).toContainText('Рабочий деньПн–Пт · 06:00–18:00')

  await nav.getByRole('link', { name: 'Скорость распознавания' }).click()
  await expect(page.getByRole('region', { name: 'Скорость распознавания' })).toBeInViewport()
  await expect(nav.getByRole('link', { name: 'Скорость распознавания' })).toHaveAttribute('aria-current', 'location')
  await expect(page.locator('#access').getByRole('link', { name: /Диспетчеры/ })).toBeVisible()
  if (process.env.SETTINGS_SHOTS) { await page.evaluate(() => window.scrollTo(0, 0)); await page.screenshot({ path: 'test-results/settings-admin-light.png', fullPage: true }) }
})

test('диспетчер не видит админских блоков ни в меню, ни на странице', async ({ page }) => {
  await signedIn(page, 'dispatcher')
  await page.goto('/settings')
  const nav = page.getByRole('navigation', { name: 'Разделы настроек' })
  await expect(nav.getByRole('link')).toHaveText(['Тема', 'Уведомления', 'Рабочий день', 'Правила адресов', 'Адреса из Auftrag', 'Правила импорта', 'Команда, Webfleet'])
  await expect(page.locator('.settings-scope-admin')).toHaveCount(0)
  await expect(page.locator('#access').getByRole('link', { name: /Диспетчеры/ })).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Уведомления' })).toContainText('Вам приходят только ваши машины')
})

for (const theme of ['light', 'dark'] as const) {
  test(`телефон, ${theme === 'dark' ? 'Ночная смена' : 'дневная тема'}: ничего не вылезает за экран, пометки читаются`, async ({ page }) => {
    await page.setViewportSize({ width: 393, height: 851 })
    await signedIn(page, 'admin', theme)
    await page.goto('/settings')
    await expect(page.getByRole('region', { name: 'Правила адресов' })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
    for (const badge of await page.locator('.settings-card .settings-scope').all()) {
      const box = (await badge.boundingBox())!
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width).toBeLessThanOrEqual(393 + 0.5)
    }
    // Text of the badges stands out from the card: WCAG AA for small text.
    const ratios = await page.locator('.settings-card .settings-scope').evaluateAll((nodes) => nodes.map((node) => {
      const rgb = (value: string) => (value.match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map(Number)
      const lum = ([r, g, b]: number[]) => [r!, g!, b!].map((c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 })
        .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i]!, 0)
      const card = node.closest('.settings-card') as HTMLElement
      let bg = getComputedStyle(card).backgroundColor
      if (bg === 'rgba(0, 0, 0, 0)') bg = getComputedStyle(document.body).backgroundColor
      const [a, b] = [lum(rgb(getComputedStyle(node).color)), lum(rgb(bg))]
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
    }))
    expect(Math.min(...ratios)).toBeGreaterThanOrEqual(4.5)
    if (process.env.SETTINGS_SHOTS) await page.screenshot({ path: `test-results/settings-phone-${theme}.png`, fullPage: true })
  })
}

test('Ночная смена на компьютере', async ({ page }) => {
  test.skip(!process.env.SETTINGS_SHOTS, 'only for screenshots')
  await signedIn(page, 'admin', 'dark')
  await page.goto('/settings')
  await expect(page.getByRole('region', { name: 'Правила адресов' })).toBeVisible()
  await page.screenshot({ path: 'test-results/settings-admin-dark.png', fullPage: true })
})
