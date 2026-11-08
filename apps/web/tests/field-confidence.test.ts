import { describe, expect, it } from 'vitest'
import { openCounts, orderViews, reasonText, stopViews, withGeocode, type FieldScore } from '../src/lib/field-confidence'

const score = (value: number, level: FieldScore['level'], reasons: string[] = []): FieldScore => ({ score: value, level, reasons, evidence: null })
const values = { type: 'UNLOAD', company: 'Seifert', address: 'Bremen', city: 'Bremen', time: '', loadingMeters: '', references: '' }

describe('field confidence in the check', () => {
  it('settles a field the dispatcher changed or confirmed, and leaves added stops alone', () => {
    const stop = { draftStopIndex: 1, fieldConfidence: { address: score(0.4, 'DOUBT', ['PLACEHOLDER']), city: score(0.6, 'CHECK', ['NO_EVIDENCE']) }, values, original: values }
    const [open] = stopViews([stop], new Set())
    expect(open.map((view) => [view.field, view.state])).toEqual([['address', 'DOUBT'], ['city', 'CHECK']])
    expect(openCounts(open)).toEqual({ doubt: 1, check: 1 })
    const [edited] = stopViews([{ ...stop, values: { ...values, address: 'Hafenstraße 5, 28197 Bremen' } }], new Set())
    expect(edited[0].state).toBe('RESOLVED')
    const [confirmed] = stopViews([stop], new Set(['1:address']))
    expect(confirmed[0].state).toBe('RESOLVED')
    expect(stopViews([{ values, fieldConfidence: stop.fieldConfidence }], new Set())).toEqual([[]])
  })

  it('doubts an address the map found only as a city', () => {
    expect(withGeocode(score(0.95, 'OK'), 'CITY')).toMatchObject({ score: 0.5, level: 'DOUBT', reasons: ['CITY_ONLY_GEOCODE'] })
    expect(withGeocode(score(0.95, 'OK'), 'EXACT')).toMatchObject({ level: 'OK' })
    expect(withGeocode(undefined, 'CITY')).toBeUndefined()
  })

  it('never lets a doubtful truck reading block the confirmation; the Auftrag number does', () => {
    const views = orderViews({ orderNumber: score(0.2, 'DOUBT', ['MISSING']), vehicle: score(0.3, 'DOUBT') }, { orderNumber: '' }, { orderNumber: '' }, new Set())
    expect(views.map((view) => [view.field, view.state])).toEqual([['orderNumber', 'DOUBT'], ['vehicle', 'CHECK']])
    expect(orderViews({ orderNumber: score(0.2, 'DOUBT') }, { orderNumber: '71123727' }, { orderNumber: '' }, new Set())[0].state).toBe('RESOLVED')
  })

  it('names the reasons that lowered a field', () => {
    expect(reasonText(score(0.4, 'DOUBT', ['PLACEHOLDER', 'ADDRESS_NO_HOUSE_NUMBER', 'DEPARTMENT']))).toBe('только название из Tourbemerkung, нет улицы с номером дома')
    expect(reasonText(score(0.7, 'CHECK', []))).toBe('низкая уверенность распознавания')
  })
})
