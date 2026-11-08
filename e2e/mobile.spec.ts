import { devices, expect, test, type Page, type Route } from '@playwright/test'

// The phone: Chromium in the Pixel 5 profile (touch, 393 px wide).
test.use({ ...devices['Pixel 5'] })

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}
const stop = (id: string, type: 'LOAD' | 'UNLOAD', city: string) => ({ id, tourId: 't1', sequence: type === 'LOAD' ? 1 : 2, type, company: `Werk ${city}`, address: `Werkstraße 1, ${city}`, city,
  latitude: 51.2, longitude: 6.8, serviceMinMinutes: 60, serviceMaxMinutes: 120, arrivedAt: null, completedAt: null })
const row = (id: string, number: string) => ({
  vehicle: { id, vehicleNumber: number, licensePlate: null, maxSpeedKmh: 85 },
  tour: { id: `t-${id}`, vehicleId: id, orderNumber: '71123727', status: 'ACTIVE', stops: [stop(`${id}a`, 'LOAD', 'Düsseldorf'), stop(`${id}b`, 'UNLOAD', 'Ludwigsfelde')], legs: [] },
  statusText: 'EN_ROUTE', operationVersion: 1, assignedTo: null, mine: true
})
const deviation = { id: 'n1', vehicleId: 'v2', stopId: null, type: 'ROUTE_DEVIATION', message: 'LKW 997: 2,4 km vom Kurs', createdAt: new Date().toISOString(), payloadJson: '{}',
  priority: 'ACTION', urgent: false, resolved: false, resolvedReason: null, leadId: 'n1', stackSize: 1 }

async function phone(page: Page, onImage?: () => void, vehicles: unknown[] = [row('v1', '321'), row('v2', '997')]) {
  // Headless Chromium always reports notifications as blocked; a phone where the dispatcher allowed them is the usual case.
  await page.addInitScript(() => Object.defineProperty(Notification, 'permission', { get: () => 'granted' }))
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, '')
    if (path === '/auth/session') return json(route, { authenticated: true, role: 'dispatcher', csrfToken: 'e2e', dispatcherId: 'd1', displayName: 'Anna Beispiel', onboardingCompletedAt: '2026-11-01T00:00:00Z' })
    if (path === '/notifications') return json(route, { notifications: [deviation] })
    if (path === '/dashboard') return json(route, { me: 'd1', vehicles })
    if (path.endsWith('/current-position')) return json(route, { status: 'EN_ROUTE' })
    if (path.endsWith('/card')) return json(route, { vehicleNumber: '321', webfleet: null, events: { unresolved: 0, items: [] } })
    if (path === '/imports/image/preview') { onImage?.(); return json(route, { source: 'OPENAI', detectedLayout: 'IMAGE', drafts: [], warnings: [], aiAvailable: true }) }
    return json(route, [])
  })
  await page.route('https://tile.openstreetmap.org/**', (route) => route.abort())
}
const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)

/** Pieces of text that are drawn over each other, and labels that broke onto a second line or were cut. */
const textClashes = (page: Page, selector: string) => page.locator(selector).evaluate((root) => {
  const textBoxes = (element: Element) => {
    const boxes: Array<{ node: Node; text: string; rect: DOMRect }> = []
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent?.trim()
      const parent = node.parentElement
      if (!text || !parent || parent.closest('.sr-only') || !parent.checkVisibility()) continue
      const range = document.createRange()
      range.selectNodeContents(node)
      for (const rect of range.getClientRects()) if (rect.width > 0 && rect.height > 0) boxes.push({ node, text, rect })
    }
    return boxes
  }
  const boxes = textBoxes(root)
  const clashes: string[] = []
  // Pieces of one text (lines of a wrapped text, a line cut with «…») never count against each other.
  boxes.forEach((a, index) => boxes.slice(index + 1).filter((b) => b.node !== a.node).forEach((b) => {
    const x = Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left)
    const y = Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top)
    if (x > 1 && y > 1) clashes.push(`«${a.text}» × «${b.text}»`)
  }))
  for (const label of root.querySelectorAll('strong, .status-pill')) {
    const [first, ...rest] = textBoxes(label).map((box) => box.rect)
    // A second line starts below the first one; pieces of one line overlap it in height.
    if (first && rest.some((rect) => rect.top >= first.bottom - 2)) clashes.push(`«${label.textContent}» перенесён на вторую строку`)
    if (label.scrollWidth > label.clientWidth + 1) clashes.push(`«${label.textContent}» обрезан`)
  }
  return clashes
})

test('телефон: вкладки внизу, машины и карта по отдельности, выбранная машина не теряется', async ({ page }) => {
  await phone(page)
  await page.goto('/')
  const tabs = page.getByRole('navigation', { name: 'Разделы' })
  await expect(tabs).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Основная навигация' })).toBeHidden()
  await expect(tabs.getByRole('link', { name: 'Машины' })).toHaveAttribute('aria-current', 'page')
  await expect(tabs.getByRole('link', { name: /Решения/ })).toContainText('1')
  await expect(page.getByRole('complementary', { name: 'Список грузовиков' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Карта выбранного грузовика' })).toBeHidden()
  expect(await sideways(page)).toBe(0)

  await tabs.getByRole('link', { name: 'Карта' }).click()
  await expect(page).toHaveURL(/view=map/)
  await expect(page).toHaveURL(/vehicleId=v1/)
  await expect(page.getByRole('region', { name: 'Карта выбранного грузовика' })).toBeVisible()
  await expect(page.getByRole('complementary', { name: 'Список грузовиков' })).toBeHidden()
  await tabs.getByRole('link', { name: 'Машины' }).click()
  await expect(page).not.toHaveURL(/view=map/)
  await expect(page).toHaveURL(/vehicleId=v1/)
})

test('телефон: карточка машины — лист над списком, ручка разворачивает и сворачивает', async ({ page }) => {
  await phone(page)
  await page.goto('/')
  await page.locator('.vehicle-row-main').first().click()
  const sheet = page.getByRole('dialog', { name: /LKW 321/ })
  await expect(sheet).toHaveClass(/truck-card-sheet-half/)
  await sheet.getByRole('button', { name: 'Развернуть карточку' }).click()
  await expect(sheet).toHaveClass(/truck-card-sheet-full/)
  await sheet.getByRole('button', { name: 'Свернуть карточку наполовину' }).click()
  await expect(sheet).toHaveClass(/truck-card-sheet-half/)
  await sheet.getByRole('button', { name: 'Закрыть карточку' }).click()
  await expect(page.locator('.truck-card')).toHaveCount(0)
})

test('телефон: «Решения» вместо колокольчика, Auftrag камерой, «Ещё» со всеми разделами', async ({ page }) => {
  let imageSent = false
  await phone(page, () => { imageSent = true })
  await page.goto('/')
  const tabs = page.getByRole('navigation', { name: 'Разделы' })

  await tabs.getByRole('link', { name: /Решения/ }).click()
  await expect(page.getByRole('heading', { name: 'Требует решения' })).toBeVisible()
  await expect(page.getByText(/отклонилась от маршрута/)).toHaveCount(1)
  expect(await sideways(page)).toBe(0)

  await tabs.getByRole('link', { name: 'Auftrag' }).click()
  const camera = page.getByLabel('Снять Auftrag камерой')
  await expect(camera).toHaveAttribute('capture', 'environment')
  await expect(camera).toHaveAttribute('accept', 'image/*')
  await expect(page.getByText('Снять фото')).toBeVisible()
  await camera.setInputFiles({ name: 'auftrag.jpg', mimeType: 'image/jpeg', buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]) })
  await expect.poll(() => imageSent).toBe(true)
  expect(await sideways(page)).toBe(0)

  await tabs.getByRole('link', { name: 'Ещё' }).click()
  await expect(page.getByRole('button', { name: /ИИ-диспетчер/ })).toBeVisible()
  const sections = page.getByRole('navigation', { name: 'Остальные разделы' })
  for (const name of ['Статус 07:00', 'Туры', /Машины и Webfleet/, 'Заказчики', 'Аналитика', /Настройки/]) await expect(sections.getByRole('link', { name })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Выйти' })).toBeVisible()
  // Without VAPID keys on the server the switch says so instead of failing silently.
  await expect(page.getByRole('switch', { name: /Push на этот телефон/ })).toContainText('не настроен на сервере')
  await sections.getByRole('link', { name: 'Туры' }).click()
  await expect(tabs.getByRole('link', { name: 'Ещё' })).toHaveAttribute('aria-current', 'page')
  expect(await sideways(page)).toBe(0)
})

test('телефон: в панели машины внизу карты текст не налезает друг на друга', async ({ page }) => {
  const at = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString()
  const base = row('v1', 'B-WY9724')
  const [load, unload] = base.tour.stops
  // As on the owner's phone: a long plate, the speed in the status and a Termin with its margin.
  const vehicle = {
    ...base,
    tour: { ...base.tour, stops: [{ ...load, completedAt: at(-3) }, { ...unload, city: 'Glauchau', address: 'D 08371 Glauchau', appointmentAt: at(10) }] },
    statusText: 'MOVING', eta: at(2), etaSource: 'GPS', remainingKm: 182,
    telemetry: { source: 'WEBFLEET', speedKmh: 82, ageSeconds: 40, latitude: 51.4, longitude: 11.9 }
  }
  await phone(page, undefined, [vehicle, row('v2', '997')])
  for (const width of [393, 360]) {
    await page.setViewportSize({ width, height: 851 })
    await page.goto('/?view=map&vehicleId=v1')
    const strip = page.getByRole('button', { name: 'Развернуть панель LKW B-WY9724' })
    await expect(strip).toContainText('LKW B-WY9724')
    await expect(strip).toContainText(/Termin .* · запас/)
    await expect(strip).toContainText('82 км/ч')
    expect(await textClashes(page, '.vehicle-panel-collapsed'), `свёрнутая панель, ${width} px`).toEqual([])

    await strip.click()
    await expect(page.getByRole('button', { name: 'Свернуть панель машины' })).toBeVisible()
    expect(await textClashes(page, '.vehicle-panel'), `развёрнутая панель, ${width} px`).toEqual([])
    expect(await sideways(page)).toBe(0)
    await page.getByRole('button', { name: 'Свернуть панель машины' }).click()
  }
})
