import { expect, test, type Route } from '@playwright/test'

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

const vehicle = { id: 'veh-1', vehicleNumber: '321', licensePlate: 'GÖ-FX321', maxSpeedKmh: 85 }
const plan = {
  kind: 'TERMIN', generatedAt: '2026-11-05T08:00:00.000Z', vehicleId: 'veh-1', vehicleNumber: '321', licensePlate: 'GÖ-FX321', source: 'WEBFLEET', preliminary: false,
  start: { at: '2026-11-05T08:00:00.000Z', atLocal: '09:00', label: 'Позиция машины', address: null, positionSource: 'WEBFLEET', stale: false },
  target: { index: 1, stopId: 's3', label: 'Выгрузка · Werk Hannover, Hannover', type: 'UNLOAD', appointmentAt: null, terminRequired: true },
  stops: [
    { stopId: 's2', label: 'Выгрузка · Meerane', type: 'UNLOAD', driveSeconds: 3600, earliestArrival: '2026-11-05T09:00:00.000Z', latestArrival: '2026-11-05T09:00:00.000Z', earliestArrivalLocal: '10:00', latestArrivalLocal: '10:00', earliestDeparture: '2026-11-05T10:00:00.000Z', latestDeparture: '2026-11-05T11:00:00.000Z', waitingMinutes: 0, breaksBefore: 0, restBefore: false, appointmentAt: null, verdict: 'NONE' },
    { stopId: 's3', label: 'Выгрузка · Werk Hannover, Hannover', type: 'UNLOAD', driveSeconds: 10800, earliestArrival: '2026-11-05T13:45:00.000Z', latestArrival: '2026-11-05T14:45:00.000Z', earliestArrivalLocal: '14:45', latestArrivalLocal: '15:45', earliestDeparture: null, latestDeparture: null, waitingMinutes: 0, breaksBefore: 1, restBefore: false, appointmentAt: null, verdict: 'NONE' }
  ],
  timeline: [
    { type: 'DRIVE', startAt: '2026-11-05T08:00:00.000Z', endAt: '2026-11-05T09:00:00.000Z', startLocal: '09:00', endLocal: '10:00', durationSeconds: 3600, label: 'Движение → Выгрузка · Meerane', stopId: 's2' },
    { type: 'SERVICE', startAt: '2026-11-05T09:00:00.000Z', endAt: '2026-11-05T10:00:00.000Z', startLocal: '10:00', endLocal: '11:00', durationSeconds: 3600, label: 'Выгрузка · Meerane (60–120 мин)', stopId: 's2' },
    { type: 'DRIVE', startAt: '2026-11-05T10:00:00.000Z', endAt: '2026-11-05T11:30:00.000Z', startLocal: '11:00', endLocal: '12:30', durationSeconds: 5400, label: 'Движение → Выгрузка · Werk Hannover, Hannover', stopId: 's3' },
    { type: 'BREAK', startAt: '2026-11-05T11:30:00.000Z', endAt: '2026-11-05T12:15:00.000Z', startLocal: '12:30', endLocal: '13:15', durationSeconds: 2700, label: 'Перерыв', stopId: 's3' },
    { type: 'DRIVE', startAt: '2026-11-05T12:15:00.000Z', endAt: '2026-11-05T13:45:00.000Z', startLocal: '13:15', endLocal: '14:45', durationSeconds: 5400, label: 'Движение → Выгрузка · Werk Hannover, Hannover', stopId: 's3' }
  ],
  recommendation: { terminAt: '2026-11-05T14:15:00.000Z', terminAtLocal: '15:15', basedOnArrival: '2026-11-05T13:45:00.000Z', bufferMinutes: 30, afterDailyRest: false, restEndsAt: null,
    reason: 'Самое раннее прибытие 14:45 по тахографу Webfleet (1 × перерыв 45 мин); Termin = прибытие + 30 мин, округление вверх до 15 мин.' },
  candidates: [
    { label: 'Рекомендуемый', at: '2026-11-05T14:15:00.000Z', atLocal: '15:15', verdict: 'RISK', deltaMinutes: 30, note: 'успевает при коротких стоянках; при максимальных — опоздание до 30 мин.' },
    { label: 'С запасом +1 ч', at: '2026-11-05T15:15:00.000Z', atLocal: '16:15', verdict: 'OK', deltaMinutes: 90, note: 'успевает, запас 90 мин.' }
  ],
  driver: { source: 'WEBFLEET' }, warnings: ['Позиция машины по Webfleet устарела.'], notes: [], geometry: [], routingProviders: []
}

test('ИИ-диспетчер показывает расчёт Termin с паузами карточкой, без сырых полей машины', async ({ page }) => {
  const sent: unknown[] = []
  const messages: Array<{ id: string; role: string; content: string; createdAt: string }> = []
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, '')
    if (path === '/auth/session') return json(route, { authenticated: true, role: 'dispatcher', csrfToken: 'e2e' })
    if (path === '/notifications') return json(route, { notifications: [] })
    if (path === '/vehicles' && route.request().method() === 'GET') return json(route, [vehicle])
    if (path === '/assistant/conversations' && route.request().method() === 'GET') return json(route, [])
    if (path === '/assistant/conversations') return json(route, { id: 'c1', title: 'Новый диалог', createdAt: '2026-11-05T08:00:00Z', updatedAt: '2026-11-05T08:00:00Z' })
    if (path === '/assistant/conversations/c1/messages' && route.request().method() === 'POST') {
      sent.push(route.request().postDataJSON())
      messages.push({ id: 'm1', role: 'user', content: 'посмотри по туру по остатку времени', createdAt: '2026-11-05T08:00:00Z' },
        { id: 'm2', role: 'assistant', content: 'Рекомендую запросить Termin в Hannover на 15:15: прибытие 14:45 с одним перерывом 45 мин.', createdAt: '2026-11-05T08:00:01Z' },
        { id: 'm3', role: 'scenario', content: JSON.stringify(plan), createdAt: '2026-11-05T08:00:02Z' })
      return json(route, { message: messages[1], proposals: [], results: [plan], scenario: plan })
    }
    if (path === '/assistant/conversations/c1/messages') return json(route, { messages, proposals: [] })
    return json(route, [])
  })
  await page.route('https://tile.openstreetmap.org/**', (route) => route.abort())
  await page.goto('/vehicles')
  await page.getByRole('button', { name: /меню$/ }).click()
  await page.getByRole('button', { name: 'ИИ-диспетчер' }).click()
  await page.getByLabel('Машина').selectOption('veh-1')
  await page.getByLabel('Сообщение помощнику').fill('посмотри по туру по остатку времени')
  await page.getByLabel('Сообщение помощнику').press('Control+Enter')
  await expect(page.getByText('Рекомендуемый Termin: 15:15')).toBeVisible()
  expect(sent[0]).toMatchObject({ text: 'посмотри по туру по остатку времени', vehicleId: 'veh-1' })
  const card = page.locator('.termin-plan')
  await expect(card).toHaveCount(1)
  await expect(card).toContainText('по тахографу Webfleet')
  // The fixture is fixed on 05.11: on any other day the card adds the date («до 05.11, 13:15»).
  await expect(card.locator('.termin-timeline .termin-pause')).toContainText(/Перерыв · 45 мин · до (\d\d\.\d\d, )?13:15/)
  await expect(card).toContainText('Прибытие от 14:45 до 15:45')
  await expect(card).toContainText('С запасом +1 ч')
  await expect(card).toContainText('Позиция машины по Webfleet устарела')
  await expect(page.locator('.dispatcher-proposal').first()).toContainText('Termin · LKW 321 · по тахографу Webfleet')
  await expect(page.locator('.dispatcher-messages')).not.toContainText('operationVersion')
  await expect(page.locator('.dispatcher-messages')).not.toContainText('clockState')
  await expect(page.getByText('Рекомендую запросить Termin в Hannover на 15:15')).toBeVisible()
  await page.screenshot({ path: 'test-results/assistant-termin.png', clip: { x: 0, y: 0, width: 1280, height: 900 } })
})
