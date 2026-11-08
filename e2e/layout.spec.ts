import { expect, test, type Route } from '@playwright/test'

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}
const schnellecke = { id: 'c-sl', name: 'Schnellecke', slug: 'SCHNELLECKE', color: '#1d4ed8' }
const walter = { id: 'c-wt', name: 'Walter (Tesla)', slug: 'WALTER_TESLA', color: '#b91c1c' }
const stop = (id: string, type: 'LOAD' | 'UNLOAD', city: string) => ({ id, tourId: `t-${id}`, sequence: type === 'LOAD' ? 1 : 2, type, company: `Werk ${city}`, address: `Werkstraße 1, ${city}`, city,
  latitude: 52.4, longitude: 9.7, serviceMinMinutes: 60, serviceMaxMinutes: 120, arrivedAt: '2026-11-06T16:50:00Z', completedAt: null, appointmentWindowStartAt: '2026-11-06T06:00:00Z', appointmentWindowEndAt: '2026-11-06T13:00:00Z' })
// Real plate-like truck numbers, two customers and the longest action labels, as on the owner's screen (08.11).
const row = (index: number) => {
  const number = ['B-WY9724', 'B-CY2868', 'B-CY2801', 'GÖ-FX997', 'B-CY7490', 'GÖ-FX952'][index % 6] + (index >= 6 ? String(index) : '')
  const action = [{ type: 'MARK_LOADED', label: 'BELADEN' }, { type: 'MARK_UNLOADED', label: 'ENTLADEN' }, { type: 'RESUME', label: 'Продолжить' }][index % 3]
  return {
    vehicle: { id: `v${index}`, vehicleNumber: number, licensePlate: number, maxSpeedKmh: 85 },
    tour: { id: `t${index}`, vehicleId: `v${index}`, orderNumber: `7112${index}`, status: 'ACTIVE', stops: [stop(`a${index}`, 'LOAD', 'Soltau'), stop(`b${index}`, 'UNLOAD', 'Wolfsburg')], legs: [] },
    statusText: 'AT_STOP', operationVersion: 1, assignedTo: null, mine: true, dwellMinutes: 2665,
    customer: index % 4 === 3 ? walter : schnellecke, line: { id: 'l', code: 'NORD', name: 'Nord' }, currentAction: action
  }
}

// The system font decides text width (Segoe on Windows, SF on a Mac, DejaVu in CI); Verdana is wider than all of them.
for (const font of ['system', 'wide'] as const) for (const width of [1280, 1440, 1512]) {
  test(`Диспозиция ${width} px, шрифт ${font}: шапка не наезжает, список не ездит вбок, номер машины виден целиком`, async ({ page }) => {
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
    await page.goto('/')
    await page.locator('.vehicle-card').first().waitFor()

    const layout = await page.evaluate(() => {
      const box = (element: Element | null) => element!.getBoundingClientRect()
      const links = [...document.querySelectorAll('.topbar-nav .topbar-link')]
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
        navOverlap: box(links.at(-1)!).right - box(document.querySelector('.topbar-tools')).left,
        sideways: scroll.scrollWidth - scroll.clientWidth,
        chipsOutside: chips.filter((chip) => box(chip).right > rail.right || box(chip).left < rail.left).length,
        numbersHidden: cards.filter((card) => card.overlapsButtons || card.cut).length
      }
    })
    expect(layout.navOverlap).toBeLessThanOrEqual(0)
    expect(layout.sideways).toBe(0)
    expect(layout.chipsOutside).toBe(0)
    expect(layout.numbersHidden).toBe(0)
  })
}
