import { expect, test, type Page, type Route } from '@playwright/test'

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

const truck = { id: 'v1', vehicleNumber: '321', licensePlate: 'GÖ-FX 321', maxSpeedKmh: 85 }

async function session(page: Page, onboardingCompletedAt: string | null, onDone: (body: unknown) => void) {
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, '')
    if (path === '/auth/session') return json(route, { authenticated: true, role: 'dispatcher', csrfToken: 'e2e', dispatcherId: 'd-neu', displayName: 'Neu Beispiel', onboardingCompletedAt })
    if (path === '/auth/onboarding') { onDone(route.request().postDataJSON()); return json(route, { ok: true, stored: true, onboardingCompletedAt: '2026-11-06T18:00:00Z' }) }
    if (path === '/notifications') return json(route, { notifications: [] })
    if (path === '/dashboard') return json(route, { me: 'd-neu', vehicles: [{ vehicle: truck, tour: null, statusText: 'IDLE', operationVersion: 1, assignedTo: null, mine: false }] })
    if (path.endsWith('/current-position')) return json(route, { status: 'IDLE' })
    return json(route, [])
  })
  await page.route('https://tile.openstreetmap.org/**', (route) => route.abort())
}

test('новый диспетчер видит обучение при первом входе, «Далее» ведёт по экрану, «Пропустить» запоминается', async ({ page }) => {
  let done: unknown = null
  await session(page, null, (body) => { done = body })
  await page.goto('/')
  const tour = page.getByRole('dialog', { name: 'Разделы программы' })
  await expect(tour).toBeVisible()
  await expect(tour).toContainText('шаг 1 из')
  await tour.getByRole('button', { name: 'Далее' }).click()
  await expect(page.getByRole('dialog', { name: 'Список машин' })).toContainText('Поиск находит по номеру LKW')
  await expect(page.locator('.guided-tour-frame')).toBeVisible()
  await page.screenshot({ path: 'test-results/onboarding-step-2.png' })
  await page.keyboard.press('ArrowLeft')
  await expect(page.getByRole('dialog', { name: 'Разделы программы' })).toBeVisible()
  await page.getByRole('button', { name: 'Пропустить' }).click()
  await expect(page.locator('.guided-tour')).toHaveCount(0)
  await expect.poll(() => done).toEqual({ completed: true })
})

test('после обучения тур не показывается, но запускается из меню и со страницы «Справка»', async ({ page }) => {
  await session(page, '2026-11-01T08:00:00Z', () => {})
  await page.goto('/')
  await expect(page.getByRole('region', { name: 'Карта выбранного грузовика' })).toBeVisible()
  await page.waitForTimeout(1500)
  await expect(page.locator('.guided-tour')).toHaveCount(0)
  await page.getByRole('button', { name: /меню$/ }).click()
  await page.getByRole('button', { name: 'Обучение' }).click()
  await expect(page.getByRole('dialog', { name: 'Разделы программы' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('.guided-tour')).toHaveCount(0)

  await page.goto('/help')
  await expect(page.getByRole('heading', { name: 'Справка' })).toBeVisible()
  await page.getByRole('button', { name: 'Показать в программе: Машины' }).click()
  await expect(page).toHaveURL(/\/vehicles$/)
  await expect(page.getByRole('dialog', { name: 'Машины' })).toContainText('Добавить машину')
})
