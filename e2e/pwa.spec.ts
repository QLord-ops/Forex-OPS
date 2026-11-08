import { expect, test } from '@playwright/test'

// The installed app: this file runs with the service worker on (the other tests block it).
test.use({ serviceWorkers: 'allow' })

test('приложение ставится на телефон: manifest и иконки, service worker, без связи — «Нет связи», а не старые данные', async ({ page, context, request }) => {
  const manifest = await (await request.get('/manifest.webmanifest')).json() as { start_url: string; display: string; icons: Array<{ src: string }> }
  expect(manifest).toMatchObject({ start_url: '/', display: 'standalone' })
  for (const icon of manifest.icons) expect((await request.get(icon.src)).headers()['content-type']).toContain('image/png')

  await context.route('**/api/**', (route) => route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"Войдите"}' }))
  await page.goto('/')
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/manifest.webmanifest')
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope)
  expect(scope).toBe(new URL('/', page.url()).href)
  await page.reload()
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true)

  // No connection: the page and the API cannot be reached (offline emulation does not reach the worker, so the requests drop).
  await context.route(/\/vehicles$/, (route) => route.abort('internetdisconnected'))
  await context.unroute('**/api/**')
  await context.route('**/api/**', (route) => route.abort('internetdisconnected'))
  await page.goto('/vehicles')
  await expect(page.getByRole('heading', { name: 'Нет связи' })).toBeVisible()
  // Live data is never answered from the cache.
  expect(await page.evaluate(() => fetch('/api/dashboard').then(() => 'answered', () => 'no network'))).toBe('no network')
})
