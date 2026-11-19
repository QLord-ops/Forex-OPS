import { expect, test, type Route } from '@playwright/test'

import { textClashes } from './text-clashes'

// These tests work with the list filters and the cover buttons open; the dispatcher's list starts with them folded.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => { try { localStorage.setItem('ops-list-filters', '1') } catch { /* no storage */ } })
})

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}
const schnellecke = { id: 'c-sl', name: 'Schnellecke', slug: 'SCHNELLECKE', color: '#1d4ed8' }
const walter = { id: 'c-wt', name: 'Walter (Tesla)', slug: 'WALTER_TESLA', color: '#b91c1c' }
const stop = (id: string, type: 'LOAD' | 'UNLOAD', city: string, company = `Werk ${city}`) => ({ id, tourId: `t-${id}`, sequence: type === 'LOAD' ? 1 : 2, type, company, address: `Werkstraße 1, ${city}`, city,
  latitude: 52.4, longitude: 9.7, serviceMinMinutes: 60, serviceMaxMinutes: 120, arrivedAt: '2026-11-06T16:50:00Z', completedAt: null, appointmentWindowStartAt: '2026-11-06T06:00:00Z', appointmentWindowEndAt: '2026-11-06T13:00:00Z' })
// Real plate-like truck numbers, two customers and the longest action labels, as on the owner's screen (08.11).
const row = (index: number) => {
  const number = ['B-WY9724', 'B-CY2868', 'B-CY2801', 'GÖ-FX997', 'B-CY7490', 'GÖ-FX952'][index % 6] + (index >= 6 ? String(index) : '')
  const action = [{ type: 'MARK_LOADED', label: 'BELADEN' }, { type: 'MARK_UNLOADED', label: 'ENTLADEN' }, { type: 'RESUME', label: 'Продолжить' }][index % 3]
  return {
    vehicle: { id: `v${index}`, vehicleNumber: number, licensePlate: number, maxSpeedKmh: 85 },
    tour: { id: `t${index}`, vehicleId: `v${index}`, orderNumber: `7112${index}`, status: 'ACTIVE', stops: [stop(`a${index}`, 'LOAD', 'Zwickau', 'Schnellecke Transportlogistik GmbH'), stop(`b${index}`, 'UNLOAD', 'Wolfsburg')], legs: [] },
    statusText: 'AT_STOP', operationVersion: 1, assignedTo: null, mine: true, dwellMinutes: 2665,
    customer: index % 4 === 3 ? walter : schnellecke, line: { id: 'l', code: 'NORD', name: 'Nord' }, currentAction: action,
    // The longest tachograph line, as on the owner's screen (09.11): «Пауза с 11:49 · вождения ещё 3 ч 47 мин · смена до 17:00».
    stopActivity: { kind: 'BREAK', stopId: `a${index}`, stopType: 'LOAD', place: 'Zwickau', since: new Date(Date.now() - 20 * 60_000).toISOString(), until: null,
      drivingLeftMs: (3 * 60 + 47) * 60_000, shiftEndAt: new Date(Date.now() + 5 * 3600_000).toISOString() }
  }
}

// The system font decides text width (Segoe on Windows, SF on a Mac, DejaVu in CI); Verdana is wider than all of them.
for (const font of ['system', 'wide'] as const) for (const width of [1280, 1440, 1512]) {
  test(`Диспозиция ${width} px, шрифт ${font}: разделы целиком в колонке, список не ездит вбок, номер машины виден целиком`, async ({ page }) => {
    if (font === 'wide') await page.addInitScript(() => document.addEventListener('DOMContentLoaded', () => {
      const style = document.createElement('style')
      style.textContent = ':root { font-family: Verdana, "DejaVu Sans", sans-serif !important; }'
      document.head.append(style)
    }))
    await page.route('**/api/**', async (route) => {
      const path = new URL(route.request().url()).pathname.replace(/^\/api/, '')
      if (path === '/auth/session') return json(route, { authenticated: true, role: 'admin', csrfToken: 'e2e', dispatcherId: 'd1', displayName: 'Yeevhenii Stolovoi', onboardingCompletedAt: '2026-11-01T00:00:00Z' })
      if (path === '/notifications') return json(route, { notifications: [] })
      if (path === '/dashboard') return json(route, { me: 'd1', vehicles: Array.from({ length: 12 }, (_, index) => row(index)) })
      if (path.endsWith('/current-position')) return json(route, { status: 'AT_STOP' })
      return json(route, [])
    })
    await page.route('https://tile.openstreetmap.org/**', (route) => route.abort())
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/?vehicleId=v0')
    await page.locator('.vehicle-card').first().waitFor()

    const layout = await page.evaluate(() => {
      const box = (element: Element | null) => element!.getBoundingClientRect()
      const links = [...document.querySelectorAll('.rail-nav .rail-link')] as HTMLElement[]
      const nav = box(document.querySelector('.rail-nav'))
      const scroll = document.querySelector('.fleet-scroll') as HTMLElement
      const rail = box(document.querySelector('.fleet-rail'))
      const chips = [...document.querySelectorAll('.fleet-rail .filter-chip')]
      const cards = [...document.querySelectorAll('.vehicle-card')].map((card) => {
        const number = box(card.querySelector('.vehicle-row-title strong'))
        const side = box(card.querySelector('.vehicle-card-side'))
        const title = box(card.querySelector('.vehicle-row-title'))
        return { overlapsButtons: number.right > side.left && number.bottom > side.top, cut: number.right > title.right + 0.5 }
      })
      return {
        sections: links.length,
        sectionsCut: links.filter((link) => link.scrollWidth > link.clientWidth || box(link).bottom > nav.bottom + 0.5 || box(link).right > nav.right + 0.5).length,
        listUnderRail: box(document.querySelector('.app-rail')).right - rail.left,
        sideways: scroll.scrollWidth - scroll.clientWidth,
        chipsOutside: chips.filter((chip) => box(chip).right > rail.right || box(chip).left < rail.left).length,
        numbersHidden: cards.filter((card) => card.overlapsButtons || card.cut).length
      }
    })
    expect(layout.sections).toBe(8)
    expect(layout.sectionsCut).toBe(0)
    expect(layout.listUnderRail).toBeLessThanOrEqual(0)
    expect(layout.sideways).toBe(0)
    expect(layout.chipsOutside).toBe(0)
    expect(layout.numbersHidden).toBe(0)

    // No text drawn over other text: the tachograph line of a card under its GPS chip, a long company under the ETA.
    const cards = await page.locator('.fleet-list .vehicle-card').all()
    for (const [index, card] of cards.slice(0, 4).entries()) {
      expect(await textClashes(page, `.fleet-list .vehicle-card >> nth=${index}`), `карточка ${index + 1}`).toEqual([])
      const box = await card.boundingBox()
      const rest = await card.locator('.rest-at-stop').boundingBox()
      if (box && rest) expect(rest.x + rest.width, `строка паузы карточки ${index + 1} внутри карточки`).toBeLessThanOrEqual(box.x + box.width + 0.5)
    }
    const panel = page.locator('.vehicle-panel')
    if (await panel.locator('.vehicle-panel-bar').count()) expect(await textClashes(page, '.vehicle-panel'), 'нижняя панель').toEqual([])
  })
}

// A laptop with the browser's bars leaves about 620 px: the sections may scroll, the bell and the menu never leave the screen.
test('Колонка разделов в низком окне: разделы, колокольчик и меню на экране, списки открываются рядом с колонкой', async ({ page }) => {
  const termin = (id: string) => ({ id, fingerprint: id.repeat(32), documentKind: 'VW_FAHRTENSCHEIN', vehiclePlate: null, company: null, site: null, city: 'München', stopType: 'UNLOAD',
    appointmentAt: '2026-11-04T10:00:00Z', windowStartAt: null, windowEndAt: null, references: [], sourceExcerpt: null, createdAt: new Date().toISOString(),
    match: { status: 'UNMATCHED', vehicle: { status: 'NO_PLATE' }, candidates: [] } })
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, '')
    if (path === '/auth/session') return json(route, { authenticated: true, role: 'admin', csrfToken: 'e2e', dispatcherId: 'd1', displayName: 'Anna Demo', onboardingCompletedAt: '2026-11-01T00:00:00Z' })
    if (path === '/notifications') return json(route, { notifications: [] })
    if (path === '/appointments/pending') return json(route, { items: [termin('p1'), termin('p2')] })
    if (path === '/dashboard') return json(route, { me: 'd1', vehicles: [row(0), row(1)] })
    if (path.endsWith('/current-position')) return json(route, { status: 'AT_STOP' })
    return json(route, [])
  })
  await page.route('https://tile.openstreetmap.org/**', (route) => route.abort())
  await page.setViewportSize({ width: 1366, height: 620 })
  await page.goto('/?vehicleId=v0')
  await page.locator('.vehicle-card').first().waitFor()

  const nav = page.getByRole('navigation', { name: 'Основная навигация' })
  await expect(nav.getByRole('link')).toHaveText(['Карта', 'Auftrag2', 'Машины', 'Заказчики', 'Туры', 'Статус', 'Аналитика', 'Настройки'])
  await expect(nav.getByRole('link', { name: 'Карта' })).toHaveAttribute('aria-current', 'page')
  await expect(nav.getByLabel('2 Termin ждут проверки')).toBeVisible()
  await expect(nav.getByRole('link', { name: 'Настройки' })).toBeInViewport({ ratio: 1 })

  const onScreen = async (selector: string) => page.locator(selector).evaluate((element) => {
    const box = element.getBoundingClientRect()
    return box.top >= 0 && box.left >= 0 && box.bottom <= window.innerHeight && box.right <= window.innerWidth
  })
  await page.getByRole('button', { name: 'Уведомления' }).click()
  await expect(page.getByText('Открытых вопросов нет.')).toBeVisible()
  expect(await onScreen('.bell-popover')).toBe(true)
  expect(await page.evaluate(() => document.querySelector('.bell-popover')!.getBoundingClientRect().left - document.querySelector('.app-rail')!.getBoundingClientRect().right)).toBeGreaterThanOrEqual(0)
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: /меню$/ }).click()
  await expect(page.getByRole('button', { name: 'Ночная смена' })).toBeVisible()
  expect(await onScreen('.account-menu-popover')).toBe(true)
  await page.keyboard.press('Escape')

  await nav.getByRole('link', { name: 'Машины' }).click()
  await expect(page).toHaveURL(/\/vehicles$/)
  await expect(nav.getByRole('link', { name: 'Машины' })).toHaveAttribute('aria-current', 'page')
})
