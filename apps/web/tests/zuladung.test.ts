import { describe, expect, it } from 'vitest'
import { withZuladungStop, zuladungBeforeStopId, zuladungState } from '../src/lib/zuladung'

const tour = (stops: Array<Record<string, unknown>>, tourRemarks = 'Borken für Königswalde + evt. Zuladung') =>
  ({ tourRemarks, stops: stops.map((stop, index) => ({ id: `s${index + 1}`, sequence: index + 1, type: 'UNLOAD', instructions: null, completedAt: null, ...stop })) })

describe('Zuladung in the web', () => {
  it('matches the server states', () => {
    expect(zuladungState(tour([{ type: 'LOAD' }, {}]))).toBe('OPEN')
    expect(zuladungState(tour([{ type: 'LOAD' }, { type: 'LOAD', instructions: 'Zuladung' }, {}]))).toBe('ADDED')
    expect(zuladungState(tour([{ type: 'LOAD' }, { completedAt: '2026-11-06T10:00:00Z' }]))).toBe('NONE')
    expect(zuladungState(tour([{ type: 'LOAD' }, {}], 'Borken für Königswalde'))).toBe('NONE')
    expect(zuladungState(null)).toBe('NONE')
  })

  it('puts the pick-up before the first unloading still ahead', () => {
    expect(zuladungBeforeStopId(tour([{ type: 'LOAD', completedAt: '2026-11-06T09:00:00Z' }, {}, {}]))).toBe('s2')
    const stops = [{ type: 'LOAD', address: 'A' }, { type: 'UNLOAD', address: 'B', arrivedAt: null }, { type: 'UNLOAD', address: 'C' }]
    expect(withZuladungStop(stops, { type: 'LOAD', address: 'Z' }).map((stop) => stop.address)).toEqual(['A', 'Z', 'B', 'C'])
    expect(withZuladungStop([{ type: 'LOAD', address: 'A' }], { type: 'LOAD', address: 'Z' }).map((stop) => stop.address)).toEqual(['A', 'Z'])
  })
})
