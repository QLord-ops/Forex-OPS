import { describe, expect, it } from 'vitest'
import { shiftSummary, spacedCode, untilText, type DriverShift } from '../src/lib/driver-shift'

const now = new Date('2026-11-19T09:00:00Z')
const shift = (patch: Partial<DriverShift> = {}): DriverShift => ({ id: 's1', startsAt: '2026-11-19T06:00:00Z', endsAt: '2026-11-19T21:00:00Z', firstUsedAt: null, lastUsedAt: null, locked: false, ...patch })

describe('driver shift code in OPS Disponent', () => {
  it('tells the dispatcher what to do in every state of the code', () => {
    expect(shiftSummary(null, now)).toMatchObject({ tone: 'none', label: 'Смены нет' })
    expect(shiftSummary(shift(), now)).toEqual({ tone: 'waiting', label: 'Код выдан, до 22:00', detail: 'Водитель ещё не входил.' })
    expect(shiftSummary(shift({ firstUsedAt: '2026-11-19T06:05:00Z', lastUsedAt: '2026-11-19T08:30:00Z' }), now))
      .toEqual({ tone: 'active', label: 'В приложении, до 22:00', detail: 'Вход с телефона: 09:30.' })
    expect(shiftSummary(shift({ locked: true, firstUsedAt: '2026-11-19T06:05:00Z' }), now)).toMatchObject({ tone: 'locked', label: 'Код заблокирован' })
  })

  it('shows the day when the code runs past today, in Berlin time', () => {
    expect(untilText('2026-11-19T21:00:00Z', now)).toBe('до 22:00')
    expect(untilText('2026-11-22T09:00:00Z', now)).toBe('до 22.11, 10:00')
    // 23:30 UTC is already the next day in Berlin.
    expect(untilText('2026-11-19T23:30:00Z', now)).toBe('до 20.11, 00:30')
  })

  it('splits the code for reading it out over the phone', () => {
    expect(spacedCode('482915')).toBe('482 915')
    expect(spacedCode('12345')).toBe('12345')
  })
})
