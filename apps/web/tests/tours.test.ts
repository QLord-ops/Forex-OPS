import { describe, expect, it } from 'vitest'

import { sharedTerminLeadIndex, sharedTerminNote, sharedTerminOf } from '../src/lib/tours'
import type { Stop } from '../src/types/domain'

function stop(partial: Partial<Stop>): Stop {
  return { id: 's1', tourId: 't1', sequence: 1, type: 'UNLOAD', address: 'Industriestraße Nord 1, 38239 Salzgitter', city: 'Salzgitter', status: 'PLANNED', ...partial } as Stop
}

describe('one Termin for unloading and loading at one place', () => {
  const load = stop({ id: 'a', sequence: 1, type: 'LOAD', city: 'Zwickau' })
  const unload = stop({ id: 'b', sequence: 2, appointmentAt: '2026-11-03T07:00:00Z' })
  const leergut = stop({ id: 'c', sequence: 3, type: 'LOAD', terminSharedWithStopId: 'b' })

  it('names the stop that keeps the Termin and its time in Berlin', () => {
    expect(sharedTerminOf([load, unload, leergut], leergut)).toEqual({ lead: unload, label: 'общий Termin с точкой 2 · 03.11 08:00' })
    const window = stop({ id: 'b', sequence: 2, appointmentWindowStartAt: '2026-11-03T07:00:00Z', appointmentWindowEndAt: '2026-11-03T09:00:00Z' })
    expect(sharedTerminOf([load, window, leergut], leergut)?.label).toBe('общий Termin с точкой 2 · 03.11 08:00–10:00')
    // The Termin has not come yet: the pair is still named, without a time.
    expect(sharedTerminOf([load, stop({ id: 'b', sequence: 2 }), leergut], leergut)?.label).toBe('общий Termin с точкой 2')
  })

  it('is silent for a stop of its own and for a pair whose first stop is not in the list', () => {
    expect(sharedTerminOf([load, unload, leergut], unload)).toBeNull()
    expect(sharedTerminOf([load, leergut], leergut)).toBeNull()
  })

  it('says where the Termin is kept', () => {
    expect(sharedTerminNote({ sequences: [2, 3], city: 'Salzgitter' }, true)).toBe('Termin общий для точек 2 и 3 (Salzgitter) — сохранён на точке 2.')
    expect(sharedTerminNote({ sequences: [2, 3, 4], city: null }, false)).toBe('Termin общий для точек 2, 3 и 4 — сохранится на точке 2.')
    expect(sharedTerminNote({ sequences: [2], city: 'Salzgitter' }, true)).toBe('')
    expect(sharedTerminNote(null, true)).toBe('')
  })

  it('keeps the pair in the editor until the dispatcher pulls it apart', () => {
    const drafts = [{ id: 'a' }, { id: 'b' }, { id: 'c', terminSharedWithStopId: 'b' }]
    expect(sharedTerminLeadIndex(drafts, 2)).toBe(1)
    expect(sharedTerminLeadIndex(drafts, 1)).toBe(-1)
    // A time of its own, a changed address on either side, another stop in between or a swapped order end the pair.
    expect(sharedTerminLeadIndex([drafts[0], drafts[1], { ...drafts[2], appointmentAt: '2026-11-03T13:00:00Z' }], 2)).toBe(-1)
    expect(sharedTerminLeadIndex([drafts[0], drafts[1], { ...drafts[2], moved: true }], 2)).toBe(-1)
    expect(sharedTerminLeadIndex([drafts[0], { ...drafts[1], moved: true }, drafts[2]], 2)).toBe(-1)
    expect(sharedTerminLeadIndex([drafts[1], drafts[0], drafts[2]], 2)).toBe(-1)
    expect(sharedTerminLeadIndex([drafts[0], drafts[2], drafts[1]], 1)).toBe(-1)
    // Three operations at one plant: the third still goes under the Termin of the first.
    expect(sharedTerminLeadIndex([{ id: 'b' }, { id: 'c', terminSharedWithStopId: 'b' }, { id: 'd', terminSharedWithStopId: 'b' }], 2)).toBe(0)
  })
})
