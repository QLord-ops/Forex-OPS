import { expect, test, type Route } from '@playwright/test'

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

const minute = (value: number) => new Date(Date.now() - (60 - value) * 60_000).toISOString()
const jam = (index: number, leadId: string, stackSize: number) => ({
  id: `jam-${index}`, vehicleId: 'v1', stopId: 's2', type: 'TRAFFIC_DELAY', message: `LKW 9724: Stau auf der A7, +${index} min`, createdAt: minute(index),
  payloadJson: '{}', priority: 'RISK', urgent: false, resolved: false, resolvedReason: null, leadId, stackSize
})

test('на одну машину — одна карточка: старые свёрнуты, «Прочитано» закрывает всю стопку, решение остаётся сверху', async ({ page }) => {
  let closed: string[] = []
  let withDecision = false
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, '')
    if (path === '/auth/session') return json(route, { authenticated: true, role: 'dispatcher', csrfToken: 'e2e', onboardingCompletedAt: '2026-11-01T00:00:00Z' })
    if (path === '/notifications') {
      if (withDecision) {
        const left = { id: 'left', vehicleId: 'v1', stopId: 's1', type: 'STOP_DEPARTED', message: 'LKW 9724, Soltau', createdAt: minute(0), payloadJson: JSON.stringify({ stopType: 'LOAD', leftAt: minute(0) }),
          priority: 'ACTION', urgent: true, resolved: false, resolvedReason: null, leadId: 'left', stackSize: 21 }
        return json(route, { notifications: [left, ...Array.from({ length: 20 }, (_, index) => jam(index, 'left', 21))] })
      }
      const open = Array.from({ length: 20 }, (_, index) => jam(index, 'jam-19', 20)).filter((item) => !closed.includes(item.id))
      return json(route, { notifications: open })
    }
    if (path === '/notifications/ack-many') { closed = (route.request().postDataJSON() as { ids: string[] }).ids; return json(route, { ok: true, count: closed.length }) }
    if (path === '/dashboard') return json(route, { me: null, vehicles: [{ vehicle: { id: 'v1', vehicleNumber: '9724', licensePlate: null, maxSpeedKmh: 85 }, tour: null, statusText: 'IDLE', operationVersion: 1 }] })
    if (path.endsWith('/current-position')) return json(route, { status: 'IDLE' })
    return json(route, [])
  })
  await page.route('https://tile.openstreetmap.org/**', (route) => route.abort())

  await page.goto('/')
  const decisions = page.getByRole('region', { name: 'Требует решения' })
  await expect(decisions.locator('.decision-card:not(.decision-card-nested)')).toHaveCount(1)
  await expect(decisions.locator('h2')).toContainText('Требует решения1')
  await expect(decisions).toContainText('Stau auf der A7, +19 min')
  await decisions.getByText('Ещё 19 по этой машине').click()
  await expect(decisions.locator('.decision-card-nested')).toHaveCount(19)
  await decisions.getByRole('button', { name: 'Прочитано · все 20' }).click()
  await expect.poll(() => closed.length).toBe(20)
  await expect(page.getByRole('region', { name: 'Требует решения' })).toHaveCount(0)

  // A truck that left without BELADEN: that decision leads, «Понятно» elsewhere would not close it.
  withDecision = true
  closed = []
  await page.reload()
  const card = page.getByRole('region', { name: 'Требует решения' }).locator('.decision-card:not(.decision-card-nested)')
  await expect(card).toHaveCount(1)
  await expect(card).toContainText('уехала с загрузки без BELADEN')
  await expect(card).toContainText('Ещё 20 по этой машине')
  // Under a decision the folded notifications close in one go; the decision itself stays open.
  page.on('dialog', (dialog) => void dialog.accept())
  await card.getByText('Ещё 20 по этой машине').click()
  await card.getByRole('button', { name: 'Прочитать эти 20' }).click()
  await expect.poll(() => closed.length).toBe(20)
  expect(closed).not.toContain('left')
})
