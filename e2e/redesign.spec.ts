import { expect, test, type Page, type Route } from '@playwright/test'

// The main screen after the redesign (owner, 18.11.2026): the summary over the map, the questions in a stack,
// «Сообщить заказчику» on a late truck and the Auftrag right on the map.
async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}
const soon = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString()
const stop = (id: string, extra: Record<string, unknown> = {}) => ({ id, tourId: 't187', sequence: 2, type: 'UNLOAD', company: 'Musterwerk Jena', address: 'Werkstraße 1, 07745 Jena', city: 'Jena',
  latitude: 50.92, longitude: 11.58, serviceMinMinutes: 60, serviceMaxMinutes: 120, arrivedAt: null, completedAt: null, appointmentAt: soon(30), ...extra })
const customer = { id: 'c-mw', name: 'Musterwerk', slug: 'MUSTERWERK', color: '#1d4ed8' }
const late = {
  vehicle: { id: 'v187', vehicleNumber: '187', licensePlate: 'GÖ FX 187', maxSpeedKmh: 85 }, customer, line: { id: 'l', code: 'SUED', name: 'Süd' },
  tour: { id: 't187', vehicleId: 'v187', orderNumber: 'FX-48211', status: 'ACTIVE', stops: [stop('s1', { sequence: 1, type: 'LOAD', city: 'Bovenden', completedAt: soon(-200), arrivedAt: soon(-240) }), stop('s2')], legs: [] },
  statusText: 'MOVING', risk: 'RED', eta: soon(70), delayMinutes: 40, remainingKm: 62, mine: true, operationVersion: 1,
  to: stop('s2'), telemetry: { source: 'WEBFLEET', stale: false, ageSeconds: 60, speedKmh: 78 },
  mapPosition: { coordinate: [10.7, 50.95], source: 'WEBFLEET', stale: false, courseDeg: 90, standstill: false }
}
const parked = { vehicle: { id: 'v231', vehicleNumber: '231', licensePlate: 'GÖ FX 231', maxSpeedKmh: 85 }, customer, statusText: 'AT_STOP', risk: 'GREEN', mine: true, operationVersion: 1, dwellMinutes: 110,
  tour: { id: 't231', vehicleId: 'v231', orderNumber: 'FX-1', status: 'ACTIVE', stops: [stop('s3', { tourId: 't231', sequence: 1, type: 'UNLOAD', city: 'Nordhausen', arrivedAt: soon(-110) })], legs: [] },
  currentStop: stop('s3', { tourId: 't231', sequence: 1, city: 'Nordhausen', arrivedAt: soon(-110) }) }
const question = (id: string, vehicleId: string, minutes: number) => ({ id, vehicleId, stopId: 's2', type: 'STOP_DEPARTED', priority: 'ACTION', urgent: true, createdAt: soon(-minutes),
  message: `LKW ${vehicleId} уехала с выгрузки без ENTLADEN`, payloadJson: JSON.stringify({ stopType: 'UNLOAD', leftAt: soon(-minutes) }) })

async function mainScreen(page: Page, notices: unknown[] = []) {
  const recorded: unknown[] = []
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, '')
    if (path === '/auth/session') return json(route, { authenticated: true, role: 'dispatcher', csrfToken: 'e2e', dispatcherId: 'd1', displayName: 'Anna Demo', onboardingCompletedAt: '2026-11-01T00:00:00Z' })
    if (path === '/notifications') return json(route, { notifications: notices })
    if (path === '/dashboard') return json(route, { me: 'd1', vehicles: [late, parked] })
    if (path === '/customers/c-mw') return json(route, { ...customer, category: 'OEM_LOGISTICS', active: true, aliases: [], lines: [], profile: { version: 1, notify: { emails: ['dispo@musterwerk.example'] } }, overview: {} })
    if (path === '/vehicles/v187/customer-notice') { recorded.push(route.request().postDataJSON()); return json(route, { at: new Date().toISOString(), by: 'Anna Demo', channel: 'COPY', stopId: 's2', etaAt: null, delayMinutes: 40 }, 201) }
    if (path.endsWith('/current-position')) return json(route, { status: 'MOVING' })
    return json(route, [])
  })
  await page.route('https://tile.openstreetmap.org/**', (route) => route.abort())
  return recorded
}

test('«Сообщить заказчику»: маленькое окно с одной строкой как в письмах диспетчера, отметка «заказчик уведомлён» в туре', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const recorded = await mainScreen(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/?vehicleId=v187')
  const panel = page.locator('.vehicle-panel')
  await expect(panel).toContainText('Опоздание 40 мин')
  await panel.getByRole('button', { name: 'Сообщить заказчику' }).click()
  const popup = page.getByRole('dialog', { name: 'Сообщить заказчику · LKW 187' })
  // A small window by its button, not a page-wide dialog.
  const box = await popup.boundingBox()
  expect(box && box.width <= 360 && box.height < 360).toBe(true)
  await expect(popup.getByLabel('Кому')).toHaveValue('dispo@musterwerk.example')
  await expect(popup.getByLabel('Тема')).toHaveValue('187')
  // Run near midnight, the 40 min late arrival falls on the next day and the letter says so.
  await expect(popup.getByLabel('Текст')).toHaveValue(/^Hallo, der Fahrer verspätet sich zum Termin um \d{1,2}(:\d{2})? Uhr bei Musterwerk Jena, er wird voraussichtlich (morgen )?gegen \d{2}:\d{2} Uhr da sein$/)
  // The truck is on the road: a letter about waiting at the stop cannot be written about it.
  await expect(popup.getByRole('button', { name: 'Ждёт на точке' })).toBeDisabled()
  await popup.getByRole('button', { name: 'Копировать' }).click()
  await expect(popup.getByRole('status')).toContainText('Отмечено: заказчик уведомлён')
  expect(recorded).toEqual([{ tourId: 't187', stopId: 's2', channel: 'COPY', etaAt: late.eta, delayMinutes: 40, recipients: 1 }])
  expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/^Hallo, der Fahrer verspätet sich zum Termin/)
  await page.keyboard.press('Escape')
  await expect(popup).toBeHidden()
  // The truck waiting almost two hours at its stop gets the waiting line.
  await page.locator('.vehicle-card').filter({ hasText: 'LKW 231' }).locator('.vehicle-row-main').click()
  await page.getByRole('button', { name: 'Закрыть карточку' }).click()
  await page.locator('.vehicle-panel').getByRole('button', { name: 'Сообщить заказчику' }).click()
  await expect(page.getByRole('dialog', { name: 'Сообщить заказчику · LKW 231' }).getByLabel('Текст')).toHaveValue(/^Hallo, der Fahrer wartet seit 2 Stunden auf die Entladung bei /)
})

test('сводка над картой: числа смены и фильтр «на точке» одним нажатием', async ({ page }) => {
  await mainScreen(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/?vehicleId=v187')
  const summary = page.getByRole('group', { name: 'Смена: сводка' })
  await expect(summary).toContainText('2машин')
  await expect(summary).toContainText('1опаздывает')
  await expect(summary).toContainText('1на точке')
  await summary.getByRole('button', { name: /на точке/ }).click()
  await expect(page.locator('.fleet-list .vehicle-card')).toHaveCount(1)
  await expect(page.locator('.fleet-list .vehicle-card')).toContainText('LKW 231')
  // The chips are folded: the filter that is on is named under the search and comes off with one click.
  await expect(page.getByRole('group', { name: 'Фильтр автопарка' })).toBeHidden()
  await page.getByRole('button', { name: 'Снять фильтр «На точке»' }).click()
  await expect(page.locator('.fleet-list .vehicle-card')).toHaveCount(2)
})

test('список без лишнего: машины сразу под поиском, фильтры и подмена за одной кнопкой, «опаздывает» в сводке отбирает', async ({ page }) => {
  await mainScreen(page)
  await page.setViewportSize({ width: 1920, height: 950 })
  await page.goto('/?vehicleId=v187')
  const rail = page.getByRole('complementary', { name: 'Список грузовиков' })
  const cards = rail.locator('.vehicle-card')
  await expect(cards).toHaveCount(2)
  await expect(rail.getByRole('group', { name: 'Фильтр автопарка' })).toBeHidden()
  await expect(rail.getByRole('group', { name: 'Заказчик' })).toHaveCount(0)
  const [search, first] = await Promise.all([rail.locator('.fleet-search-row').boundingBox(), cards.first().boundingBox()])
  expect(Math.round((first?.y ?? 999) - ((search?.y ?? 0) + (search?.height ?? 0)))).toBeLessThanOrEqual(40)
  // Nothing in the head is wider than the list (the search gives way to the button).
  expect(await rail.locator('.fleet-controls').evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
  // The search field stays inside its own frame, also while typing: one box, as high as the button beside it (19.11).
  await rail.getByPlaceholder('LKW, Auftrag, город').focus()
  const [label, field, button] = await Promise.all([rail.locator('.fleet-search').boundingBox(), rail.locator('.fleet-search-input').boundingBox(), rail.getByRole('button', { name: 'Фильтры и подмена' }).boundingBox()])
  expect({ field: field && Math.round(field.height), label: label && Math.round(label.height), button: button && Math.round(button.height) }).toEqual({ field: 44, label: 44, button: 44 })
  expect(field && label && Math.abs(field.y - label.y) <= 1 && Math.abs(field.x - label.x) <= 1 && Math.abs(field.width - label.width) <= 1).toBe(true)
  expect(await rail.locator('.fleet-search').evaluate((element) => getComputedStyle(element).outlineStyle)).toBe('none')
  await page.getByRole('group', { name: 'Смена: сводка' }).getByRole('button', { name: /опаздывает/ }).click()
  await expect(cards).toHaveCount(1)
  await expect(cards).toContainText('LKW 187')
  await rail.getByRole('button', { name: 'Снять фильтр «Опаздывают»' }).click()
  await expect(cards).toHaveCount(2)
  const toggle = rail.getByRole('button', { name: 'Фильтры и подмена' })
  await toggle.click()
  await expect(rail.getByRole('group', { name: 'Фильтр автопарка' }).getByRole('button', { name: /^Опаздывают/ })).toContainText('1')
  // The choice stays in this browser.
  await page.reload()
  await expect(rail.getByRole('group', { name: 'Фильтр автопарка' })).toBeVisible()
  await toggle.click()
  await expect(rail.getByRole('group', { name: 'Фильтр автопарка' })).toBeHidden()
})

test('вкладка, открытая до выкладки, предлагает обновиться и сама не перезагружается', async ({ page }) => {
  await mainScreen(page)
  await page.goto('/?vehicleId=v187')
  await expect(page.locator('.vehicle-card').first()).toBeVisible()
  await expect(page.getByText('Вышла новая версия OPS')).toHaveCount(0)
  // The next look at the site finds another program than the one this tab runs.
  await page.route((url) => url.pathname === '/', (route) => route.request().resourceType() === 'document' ? route.fallback()
    : route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><script type="module" crossorigin src="/assets/index-next.js"></script>' }))
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await expect(page.getByRole('status').filter({ hasText: 'Вышла новая версия OPS' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Обновить' })).toBeVisible()
  await expect(page.locator('.vehicle-card').first()).toBeVisible()
})

test('вопросы над картой: два сразу, остальные за «открыть все»; карта и список не перекрыты', async ({ page }) => {
  await mainScreen(page, [question('n1', 'v187', 5), question('n2', 'v231', 10), question('n3', 'v187', 15)])
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/?vehicleId=v187')
  const stack = page.getByRole('region', { name: 'Требует решения' })
  await expect(stack.getByRole('article')).toHaveCount(2)
  await stack.getByRole('button', { name: /ещё 1/ }).click()
  await expect(stack.locator('.decision-row')).toHaveCount(3)
  await expect(stack.getByRole('button', { name: 'Свернуть' })).toBeVisible()
  const [list, panel] = await Promise.all([page.locator('.fleet-rail').boundingBox(), stack.boundingBox()])
  expect(list && panel && list.x + list.width < panel.x).toBe(true)
})

test('Auftrag на главной: кнопка рядом с «Адрес» и «Маршрут», файл можно бросить прямо на карту', async ({ page }) => {
  await mainScreen(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/?vehicleId=v187')
  const map = page.getByRole('region', { name: 'Карта выбранного грузовика' })
  await map.getByRole('button', { name: 'Auftrag', exact: true }).click()
  await expect(map.getByText('Добавить Auftrag')).toBeVisible()
  await expect(map.getByText('Перетащите Auftrag сюда')).toBeVisible()
  await map.getByRole('button', { name: 'Auftrag', exact: true }).click()
  await expect(map.getByText('Добавить Auftrag')).toBeHidden()
  // A file dragged over the map is accepted quietly: no frame and no banner over the map (owner, 18.11).
  const transfer = await page.evaluateHandle(() => { const data = new DataTransfer(); data.items.add(new File(['x'], 'auftrag.pdf', { type: 'application/pdf' })); return data })
  await page.locator('.dashboard-stage').dispatchEvent('dragover', { dataTransfer: transfer })
  await expect(page.getByText(/Отпустите файл/)).toHaveCount(0)
  expect(await page.locator('.dashboard-stage').evaluate((element) => getComputedStyle(element, '::after').borderStyle)).not.toBe('dashed')
  // Dropped on the map the file is read once: the assistant's own window does not take the same drop (18.11: two readings).
  let readings = 0
  page.on('request', (request) => { if (request.method() === 'POST' && request.url().includes('/api/imports/')) readings += 1 })
  await page.locator('.dashboard-stage').dispatchEvent('drop', { dataTransfer: transfer })
  await expect.poll(() => readings).toBe(1)
  await page.waitForTimeout(700)
  expect(readings).toBe(1)
  // Dropped beside the map (on the list) it is read once too, in the same window: the assistant's window stays shut (19.11).
  await page.locator('.fleet-rail').dispatchEvent('drop', { dataTransfer: transfer })
  await expect.poll(() => readings).toBe(2)
  await page.waitForTimeout(700)
  expect(readings).toBe(2)
  await expect(page.locator('.dispatcher-import')).toBeHidden()
})

test('строка списка не шире карточки: время и кнопки на месте при длинной подписи «ведёт … за …»', async ({ page }) => {
  await mainScreen(page)
  await page.route('**/api/dashboard', (route) => json(route, { me: 'd1', vehicles: [
    { ...late, mine: false, assignedTo: { id: 'd2', name: 'Maximilian Mustermann' }, cover: { id: 'c', absent: { id: 'd3', name: 'Alexandra Beispielfrau' }, by: { id: 'd2', name: 'Maximilian Mustermann' }, endsAt: soon(300) },
      customer: { ...customer, name: 'Beispiel Logistik International' }, line: { id: 'l', code: 'L1', name: 'Linie Nordhessen 1' }, currentAction: { type: 'MARK_UNLOADED', label: 'ENTLADEN', stopId: 's2', manual: true, withoutGpsArrival: true } },
    parked] }))
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto('/?vehicleId=v231')
  await page.getByRole('group', { name: 'Чьи машины показать' }).getByRole('button', { name: /Весь парк/ }).click()
  const card = page.locator('.vehicle-card').filter({ hasText: 'LKW 187' })
  await expect(card).toContainText('ведёт Maximilian Mustermann за Alexandra Beispielfrau')
  expect(await card.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
  const [box, clock, action] = await Promise.all([card.boundingBox(), card.locator('.vehicle-row-clock').boundingBox(), card.getByRole('button', { name: 'ENTLADEN' }).boundingBox()])
  expect(box && clock && clock.x + clock.width <= box.x + box.width).toBe(true)
  expect(box && action && action.x + action.width <= box.x + box.width).toBe(true)
})

test('ноутбук с открытой карточкой: вопросы свёрнуты в заголовок и не закрывают карту; уже 1200 px карточка встаёт на место списка', async ({ page }) => {
  await mainScreen(page, [question('n1', 'v187', 5), question('n2', 'v231', 10), question('n3', 'v187', 15)])
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto('/?vehicleId=v187&card=v187')
  const stack = page.getByRole('region', { name: 'Требует решения' })
  const card = page.locator('.truck-card')
  await expect(card).toBeVisible()
  await expect(stack.getByRole('article')).toHaveCount(0)
  const [cardBox, stackBox] = await Promise.all([card.boundingBox(), stack.boundingBox()])
  // Map stays visible between the card and the folded questions (they used to lie over each other).
  // The folded heading is as wide as its text, so the gap depends on the font: 235 px with Inter, less with the wider CI fonts.
  const gap = Math.round((stackBox?.x ?? 0) - ((cardBox?.x ?? 0) + (cardBox?.width ?? 0)))
  expect({ gap: gap >= 120 ? 'map visible' : `${gap} px`, folded: (stackBox?.height ?? 999) < 60 }).toEqual({ gap: 'map visible', folded: true })
  await stack.getByRole('button', { name: 'Показать' }).click()
  await expect(stack.locator('.decision-row')).toHaveCount(3)
  await stack.getByRole('button', { name: 'Свернуть' }).click()
  await expect(stack.getByRole('article')).toHaveCount(0)
  await page.setViewportSize({ width: 1024, height: 768 })
  await expect(page.locator('.fleet-rail')).toBeHidden()
  const narrow = await card.boundingBox()
  expect(narrow && narrow.x < 120 && 1024 - (narrow.x + narrow.width) >= 500).toBe(true)
  await page.getByRole('button', { name: 'Закрыть карточку' }).click()
  await expect(page.locator('.fleet-rail')).toBeVisible()
})

test('точки тура в нижней панели: Termin и ETA у каждой, у следующих — «≈»', async ({ page }) => {
  await mainScreen(page)
  const stops = [stop('s1', { sequence: 1, type: 'LOAD', city: 'Bovenden', completedAt: soon(-200), arrivedAt: soon(-240) }),
    stop('s2', { predictedEta: soon(70), etaEarliest: soon(70), etaLatest: soon(70), etaBasis: 'ETA' }),
    stop('s4', { sequence: 3, type: 'LOAD', city: 'Jena', appointmentAt: null, terminSharedWithStopId: 's2', predictedEta: soon(160), etaEarliest: soon(130), etaLatest: soon(190), etaBasis: 'ETA' })]
  await page.route('**/api/dashboard', (route) => json(route, { me: 'd1', vehicles: [{ ...late, tour: { ...late.tour, stops } }, parked] }))
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.goto('/?vehicleId=v187')
  const list = page.getByRole('list', { name: 'Точки тура' })
  await expect(list.getByRole('listitem').nth(1)).toContainText(/Termin \d{2}:\d{2}ETA \d{2}:\d{2}/)
  await expect(list.getByRole('listitem').nth(2)).toContainText(/Termin точки 2ETA ≈ \d{2}:\d{2}/)
  await page.getByRole('button', { name: /Точки маршрута/ }).click()
  const track = page.getByRole('list', { name: 'Этапы маршрута' })
  await expect(track).toContainText('общий Termin с точкой 2')
  await expect(track).not.toContainText('Без срока')
  await expect(track).toContainText(/ETA ≈ /)
})

test('телефон: сводка смены отдельной полосой, кнопки карты под ней', async ({ page }) => {
  await mainScreen(page)
  await page.setViewportSize({ width: 393, height: 851 })
  await page.goto('/?vehicleId=v187&view=map')
  const summary = await page.getByRole('group', { name: 'Смена: сводка' }).boundingBox()
  const locate = await page.locator('.map-zoom').boundingBox()
  const layers = await page.locator('.map-layers').boundingBox()
  expect(summary && summary.x >= 0 && summary.x + summary.width <= 393).toBe(true)
  expect(summary && locate && layers && locate.y >= summary.y + summary.height && layers.y >= summary.y + summary.height).toBe(true)
})

test('нижняя панель: одна строка колонок одной высоты на 1280–1920 px, кнопки и строки целиком', async ({ page }) => {
  // 18.11: on a laptop the panel took 323 px of the map in two rows; now every width gives the same one row.
  await mainScreen(page)
  const heights: number[] = []
  for (const [width, height] of [[1280, 720], [1366, 768], [1440, 900], [1920, 1080]]) {
    await page.setViewportSize({ width, height })
    await page.goto('/?vehicleId=v187')
    const panel = page.locator('.vehicle-panel')
    await expect(panel.locator('.vehicle-panel-bar')).toBeVisible()
    await expect(panel).toContainText('Осталось ≈ 62 км')
    const shape = await panel.evaluate((element) => {
      const box = element.getBoundingClientRect()
      const columns = [...element.querySelectorAll<HTMLElement>('.vehicle-panel-bar > *')].filter((item) => getComputedStyle(item).display !== 'none').map((item) => item.getBoundingClientRect())
      const buttons = [...element.querySelectorAll<HTMLElement>('.vehicle-panel-actions button')]
      return { height: Math.round(box.height), oneRow: new Set(columns.map((item) => Math.round(item.top))).size === 1, sameHeight: new Set(columns.map((item) => Math.round(item.height))).size === 1,
        buttonsInside: buttons.every((button) => button.getBoundingClientRect().right <= box.right - 8 && button.scrollWidth <= button.clientWidth + 1) }
    })
    expect(shape, `${width} px`).toMatchObject({ oneRow: true, sameHeight: true, buttonsInside: true })
    heights.push(shape.height)
  }
  expect(Math.max(...heights)).toBeLessThanOrEqual(170)
  expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(12)
})
