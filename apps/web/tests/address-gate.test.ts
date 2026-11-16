import { describe, expect, it } from 'vitest'

import { addressAlertOf, openCounts, stopViews, type FieldScore } from '../src/lib/field-confidence'

const score = (value: number): FieldScore => ({ score: value, level: value >= 0.85 ? 'OK' : value >= 0.6 ? 'CHECK' : 'DOUBT', reasons: [], evidence: null })
const values = { type: 'UNLOAD', company: 'MAN', address: 'Industriestraße Nord 12, 38239 Salzgitter', city: 'Salzgitter', time: '', loadingMeters: '', references: '' }
const stop = (address: number, extra: Record<string, unknown> = {}) => ({ draftStopIndex: 0, fieldConfidence: { address: score(address) }, geocodePrecision: 'EXACT', values, original: values, ...extra })

describe('addresses the services disagree about', () => {
  it('two geocoders apart, or the register against the address, is an alert; agreement is not', () => {
    expect(addressAlertOf({ second: { status: 'DIFFER' } })).toBe('SOURCES_DIFFER')
    expect(addressAlertOf({ check: { status: 'STREET_NOT_IN_POSTCODE' } })).toBe('REGISTER_MISMATCH')
    expect(addressAlertOf({ check: { status: 'OK' }, second: { status: 'AGREE' } })).toBeNull()
    expect(addressAlertOf(null)).toBeNull()
  })

  it('puts a confidently read address in doubt, and a corrected address stays open while the services still object', () => {
    const [[view]] = stopViews([stop(0.95, { addressAlert: 'SOURCES_DIFFER' })], new Set())
    expect(view).toMatchObject({ state: 'DOUBT' })
    expect(view.score.reasons).toContain('SOURCES_DIFFER')
    const changed = { ...values, address: 'Industriestraße Süd 1, 38239 Salzgitter' }
    expect(stopViews([stop(0.95, { addressAlert: 'SOURCES_DIFFER', values: changed })], new Set())[0][0].state).toBe('DOUBT')
    expect(stopViews([stop(0.95, { values: changed })], new Set())[0][0].state).toBe('RESOLVED')
    expect(stopViews([stop(0.95, { addressAlert: 'SOURCES_DIFFER' })], new Set(['0:address']))[0][0].state).toBe('RESOLVED')
  })
})

describe('yellow fields never block confirming an Auftrag (owner, 16.11)', () => {
  it('only doubts count against confirming; a yellow address is a check, not a stop', () => {
    const views = stopViews([stop(0.7), { ...stop(0.95), draftStopIndex: 1, fieldConfidence: { address: score(0.95), company: score(0.7) } }], new Set())
    expect(openCounts(views.flat())).toEqual({ doubt: 0, check: 2 })
  })
})
