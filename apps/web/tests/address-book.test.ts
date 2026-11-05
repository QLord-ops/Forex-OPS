import { describe, expect, it } from 'vitest'
import { suggestionAddress, suggestionResolution, suggestionSourceLabel, type AddressSuggestion } from '../src/lib/address-book'

const emden: AddressSuggestion = { id: 'a1', source: 'WEBFLEET', label: 'VW Werk Emden', line2: 'Frisiusstraße 1, 26723 Emden', company: 'VW Werk Emden', street: 'Frisiusstraße 1',
  postalCode: '26723', city: 'Emden', latitude: 53.366, longitude: 7.206, radiusMeters: 400 }

describe('address suggestions', () => {
  it('builds the street line and falls back to the name', () => {
    expect(suggestionAddress(emden)).toBe('Frisiusstraße 1, 26723 Emden')
    expect(suggestionAddress({ ...emden, street: null, postalCode: null, city: null })).toBe('VW Werk Emden')
    expect(suggestionSourceLabel(emden)).toBe('Webfleet')
    expect(suggestionSourceLabel({ source: 'RULE' })).toBe('выучено')
  })
  it('a picked address is an exact resolution that is not geocoded again', () => {
    expect(suggestionResolution(emden)).toMatchObject({ sourceAddress: 'Frisiusstraße 1, 26723 Emden', precision: 'EXACT', provider: 'webfleet-address', latitude: 53.366, longitude: 7.206, city: 'Emden' })
    expect(suggestionResolution({ ...emden, source: 'RULE' }).provider).toBe('address-rule')
  })
})
