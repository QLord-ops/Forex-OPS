import { describe, expect, it } from 'vitest'
import { answerRequired, closableWith, isLead, stackOf, type AlertNotification } from '../src/lib/alerts'

const note = (id: string, type: string, leadId: string, minute: number, extra: Partial<AlertNotification> = {}): AlertNotification =>
  ({ id, vehicleId: 'v1', type, message: id, createdAt: `2026-11-08T10:${String(minute).padStart(2, '0')}:00Z`, leadId, stackSize: 4, priority: 'RISK', ...extra })

describe('one card per truck', () => {
  const left = note('left', 'STOP_DEPARTED', 'jam-3', 1, { priority: 'ACTION' })
  const items = [note('jam-1', 'TRAFFIC_DELAY', 'jam-3', 2), note('jam-2', 'TRAFFIC_DELAY', 'jam-3', 3), note('jam-3', 'TRAFFIC_DELAY', 'jam-3', 4), left]

  it('shows only the lead; an older server without stack data shows every notification', () => {
    expect(items.filter(isLead).map((item) => item.id)).toEqual(['jam-3'])
    expect(isLead({ id: 'a', vehicleId: 'v', type: 'X', message: '', createdAt: '' })).toBe(true)
  })

  it('lists the rest of the truck newest first and closes it with the card, except a decision waiting for its answer', () => {
    const lead = items[2]
    expect(stackOf(items, lead).map((item) => item.id)).toEqual(['jam-2', 'jam-1', 'left'])
    expect(answerRequired(left)).toBe(true)
    expect(answerRequired({ ...left, resolved: true })).toBe(false)
    expect(closableWith(items, lead)).toEqual(['jam-3', 'jam-2', 'jam-1'])
    expect(closableWith(items, items[0])).toEqual(['jam-1'])
  })
})
