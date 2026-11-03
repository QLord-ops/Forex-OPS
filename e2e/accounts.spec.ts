import { expect, test, type Route } from '@playwright/test'

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

test('входит по личному логину и видит своё имя', async ({ page }) => {
  let loginBody: unknown = null
  let signedIn = false
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, '')
    if (path === '/auth/session') return json(route, signedIn ? { authenticated: true, role: 'dispatcher', csrfToken: 'e2e', dispatcherId: 'd-anna', displayName: 'Anna Beispiel' } : { authenticated: false, accountsEnabled: true })
    if (path === '/auth/login') {
      loginBody = route.request().postDataJSON()
      signedIn = true
      return json(route, { authenticated: true, role: 'dispatcher', csrfToken: 'e2e', dispatcherId: 'd-anna', displayName: 'Anna Beispiel' })
    }
    if (path === '/notifications') return json(route, { notifications: [] })
    if (path === '/dashboard') return json(route, { vehicles: [] })
    return json(route, [])
  })
  await page.route('https://tile.openstreetmap.org/**', route => route.abort())
  await page.goto('/')
  await expect(page.locator('#dispatcher-login')).toBeFocused()
  await page.locator('#dispatcher-login').fill('anna.b')
  await page.locator('#dispatcher-password').fill('anna long password')
  await page.getByRole('button', { name: 'SIGN IN' }).click()
  await expect.poll(() => loginBody).toEqual({ login: 'anna.b', password: 'anna long password' })
  await expect(page.getByRole('button', { name: /Anna Beispiel/ }).first()).toBeVisible({ timeout: 10_000 })
  // A dispatcher does not see the admin page.
  await expect(page.getByRole('link', { name: 'Диспетчеры' })).toHaveCount(0)
})

test('администратор создаёт аккаунт диспетчера', async ({ page }) => {
  const accounts = [{ id: 'd-chef', login: 'chef', displayName: 'Chef Admin', role: 'admin', active: true, lastLoginAt: '2026-11-03T08:00:00.000Z', createdAt: '2026-11-03T07:00:00.000Z' }]
  let created: unknown = null
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, '')
    if (path === '/auth/session') return json(route, { authenticated: true, role: 'admin', csrfToken: 'e2e', dispatcherId: 'd-chef', displayName: 'Chef Admin' })
    if (path === '/notifications') return json(route, { notifications: [] })
    if (path === '/dispatchers' && route.request().method() === 'POST') {
      created = route.request().postDataJSON()
      accounts.push({ id: 'd-anna', login: 'anna.b', displayName: 'Anna Beispiel', role: 'dispatcher', active: true, lastLoginAt: null as never, createdAt: '2026-11-03T09:00:00.000Z' })
      return json(route, accounts[1], 201)
    }
    if (path === '/dispatchers') return json(route, accounts)
    return json(route, [])
  })
  await page.goto('/dispatchers')
  await expect(page.getByRole('heading', { name: 'Диспетчеры' })).toBeVisible()
  await expect(page.getByRole('row', { name: /Chef Admin.*это вы/ })).toBeVisible()
  await page.getByPlaceholder('anna.b').fill('Anna.B')
  await page.getByPlaceholder('Anna Beispiel').fill('Anna Beispiel')
  await page.getByLabel('Временный пароль').fill('anna long password')
  await page.getByRole('button', { name: 'Создать' }).click()
  await expect.poll(() => created).toEqual({ login: 'anna.b', displayName: 'Anna Beispiel', role: 'dispatcher', password: 'anna long password' })
  await expect(page.getByRole('status')).toContainText('Аккаунт создан')
  await expect(page.getByRole('row', { name: /Anna Beispiel.*ещё не входил/ })).toBeVisible()
})
