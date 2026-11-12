import { expect, test, type Page, type Route } from '@playwright/test'

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

const shots = process.env.COVER_SHOTS
const shot = async (page: Page, name: string) => { if (shots) await page.screenshot({ path: `${shots}/${name}.png` }) }
const truck = (id: string, vehicleNumber: string) => ({ id, vehicleNumber, licensePlate: null, maxSpeedKmh: 85 })
const ANNA = { id: 'd-anna', name: 'Anna Beispiel' }, BEN = { id: 'd-ben', name: 'Ben Muster' }
const line = (id: string, name: string, customer: string, color: string) => ({ id, name, customer, color })
const SUED = line('l-sued', 'Süd', 'Schnellecke', '#1d4ed8'), NORD = line('l-nord', 'Nord', 'Schnellecke', '#1d4ed8'), TESLA = line('l-tesla', 'Tesla', 'Walter (Tesla)', '#b91c1c')

/** Anna works on Süd; Ben on Nord and Tesla with one truck taken. A cover of Ben moves his two trucks to Anna. */
async function mock(page: Page, options: { annaWithoutLines?: boolean } = {}) {
  const state: { cover: null | { id: string; endsAt: string; lineIds: string[] | null }; started: unknown; ended: string | null } = { cover: null, started: null, ended: null }
  const cover = () => state.cover ? { id: state.cover.id, startsAt: '2026-11-11T08:00:00.000Z', endsAt: state.cover.endsAt, absent: BEN, cover: ANNA, allLines: state.cover.lineIds === null, lines: [NORD, TESLA], vehicleCount: 2 } : null
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, '')
    const covered = cover()
    if (path === '/auth/session') return json(route, { authenticated: true, role: 'dispatcher', csrfToken: 'e2e', dispatcherId: ANNA.id, displayName: ANNA.name, onboardingCompletedAt: '2026-11-01T00:00:00Z' })
    if (path === '/notifications') return json(route, { notifications: [] })
    if (path === '/dashboard') {
      const mark = covered ? { id: covered.id, absent: BEN, by: ANNA, endsAt: covered.endsAt } : null
      return json(route, { me: ANNA.id, vehicles: [
        { vehicle: truck('v-mine', '2803'), tour: null, statusText: 'IDLE', operationVersion: 1, assignedTo: null, mine: true, cover: null },
        { vehicle: truck('v-ben', '7448'), tour: null, statusText: 'MOVING', operationVersion: 1, assignedTo: BEN, mine: Boolean(covered), cover: mark },
        { vehicle: truck('v-nord', '3786'), tour: null, statusText: 'IDLE', operationVersion: 1, assignedTo: null, mine: Boolean(covered), cover: mark }
      ] })
    }
    if (path === '/team') return json(route, {
      me: ANNA.id,
      dispatchers: [
        options.annaWithoutLines
          ? { ...ANNA, lines: [], takenLines: [{ ...SUED, vehicleCount: 5 }, { ...TESLA, vehicleCount: 1 }], vehicleCount: 6, away: [], covering: [] }
          : { ...ANNA, lines: [{ ...SUED, isPrimary: true }], vehicleCount: covered ? 3 : 1, away: [], covering: covered ? [covered] : [] },
        { ...BEN, lines: [{ ...NORD, isPrimary: true }, { ...TESLA, isPrimary: false }], vehicleCount: covered ? 0 : 2, away: covered ? [covered] : [], covering: [] }
      ],
      unowned: [{ ...line('l-lufe', 'LuFe', 'Schnellecke', '#1d4ed8'), vehicleCount: 3 }],
      covers: covered ? [covered] : []
    })
    if (path === '/covers' && route.request().method() === 'POST') {
      state.started = route.request().postDataJSON()
      const body = state.started as { endsAt: string; lineIds: string[] | null }
      state.cover = { id: 'c-1', endsAt: body.endsAt, lineIds: body.lineIds }
      return json(route, { id: 'c-1', endsAt: body.endsAt }, 201)
    }
    if (path === '/covers/c-1/end') { state.ended = 'c-1'; state.cover = null; return json(route, { id: 'c-1' }) }
    if (path.endsWith('/current-position')) return json(route, { status: 'IDLE' })
    return json(route, [])
  })
  await page.route('https://tile.openstreetmap.org/**', route => route.abort())
  return state
}

test('подменить коллегу с Диспозиции: его машины в «Мои» с пометкой, «Вернуть» отдаёт их обратно', async ({ page }) => {
  const state = await mock(page)
  await page.goto('/')
  const rows = page.locator('.fleet-list .vehicle-card')
  await expect(rows).toHaveCount(1)

  const panel = page.getByRole('region', { name: 'Подмена диспетчера' })
  await panel.getByRole('button', { name: 'Подменить коллегу' }).click()
  const form = page.getByRole('form', { name: 'Подменить коллегу' })
  await expect(form.getByRole('button', { name: 'Взять на себя' })).toBeDisabled()
  await form.getByLabel('Кого подменить').selectOption(BEN.id)
  await form.getByLabel('До какого времени').fill('2026-11-15T18:00')
  await shot(page, 'cover-form')
  await form.getByRole('button', { name: 'Взять на себя' }).click()

  await expect.poll(() => state.started).toMatchObject({ absentDispatcherId: BEN.id, coverDispatcherId: ANNA.id, lineIds: null })
  expect(new Date((state.started as { endsAt: string }).endsAt).getTime()).toBe(new Date('2026-11-15T18:00').getTime())
  await expect(form).toHaveCount(0)
  await expect(panel).toContainText('Веду за Ben Muster')
  await expect(panel).toContainText('все линии, 2 машины')
  await expect(rows).toHaveCount(3)
  await expect(rows.filter({ hasText: 'LKW 7448' })).toContainText('за Ben Muster')
  await expect(rows.filter({ hasText: 'LKW 2803' })).not.toContainText('за Ben')
  await shot(page, 'cover-active')

  await rows.filter({ hasText: 'LKW 7448' }).locator('.vehicle-row-main').click()
  await expect(page.getByRole('dialog')).toContainText('Веду за Ben Muster')
  await page.keyboard.press('Escape')

  await panel.getByRole('button', { name: 'Вернуть линии: Ben Muster' }).click()
  await expect.poll(() => state.ended).toBe('c-1')
  await expect(panel).not.toContainText('Веду за')
  await expect(rows).toHaveCount(1)
})

test('«Меня нет»: только выбранные линии уходят коллеге', async ({ page }) => {
  const state = await mock(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Меня нет' }).click()
  const form = page.getByRole('form', { name: 'Меня нет: передать линии' })
  await form.getByLabel('Кому передать').selectOption(BEN.id)
  await form.getByLabel('Только выбранные линии').check()
  await expect(form.getByRole('button', { name: 'Передать' })).toBeDisabled()
  await form.getByLabel('Schnellecke · Süd').check()
  await form.getByRole('button', { name: 'Передать' }).click()
  await expect.poll(() => state.started).toMatchObject({ absentDispatcherId: ANNA.id, coverDispatcherId: BEN.id, lineIds: ['l-sued'] })
})

test('«Меня нет» без своих линий: выбираются линии взятых машин', async ({ page }) => {
  const state = await mock(page, { annaWithoutLines: true })
  await page.goto('/')
  await page.getByRole('button', { name: 'Меня нет' }).click()
  const form = page.getByRole('form', { name: 'Меня нет: передать линии' })
  await form.getByLabel('Кому передать').selectOption(BEN.id)
  await expect(form.getByLabel('Только выбранные линии')).toBeEnabled()
  await form.getByLabel('Только выбранные линии').check()
  await expect(form).toContainText('Schnellecke · Süd — взятых машин: 5')
  await shot(page, 'cover-taken-lines')
  await form.getByLabel('Schnellecke · Süd').check()
  await form.getByRole('button', { name: 'Передать' }).click()
  await expect.poll(() => state.started).toMatchObject({ absentDispatcherId: ANNA.id, coverDispatcherId: BEN.id, lineIds: ['l-sued'] })
})

test('страница «Команда»: кто что ведёт, кого нет и ничьи линии', async ({ page }) => {
  const state = await mock(page)
  await page.goto('/team')
  const people = page.getByRole('region', { name: 'Диспетчеры' }).getByRole('listitem')
  await expect(people).toHaveCount(2)
  await expect(people.nth(0)).toContainText('Anna Beispiel (вы)')
  await expect(people.nth(1)).toContainText('Schnellecke · Nord (основная)')
  await expect(page.getByRole('region', { name: 'Ничьи линии' })).toContainText('Schnellecke · LuFe')
  await expect(page.getByRole('button', { name: 'Назначить подмену' })).toHaveCount(0)

  await page.getByRole('button', { name: 'Подменить: Ben Muster' }).click()
  const form = page.getByRole('form', { name: 'Подменить коллегу' })
  await expect(form.getByLabel('Кого подменить')).toHaveValue(BEN.id)
  await form.getByRole('button', { name: 'Взять на себя' }).click()
  await expect.poll(() => state.started).toMatchObject({ absentDispatcherId: BEN.id, coverDispatcherId: ANNA.id })
  await expect(people.nth(1)).toContainText('нет до')
  await expect(people.nth(1)).toContainText('Ведёт Anna Beispiel: все линии, 2 машины')
  await expect(page.getByRole('button', { name: 'Подменить: Ben Muster' })).toHaveCount(0)
  await shot(page, 'team')

  await page.getByRole('button', { name: 'Вернуть линии: Ben Muster' }).click()
  await expect.poll(() => state.ended).toBe('c-1')
  await expect(people.nth(1)).not.toContainText('нет до')
})
