import { describe, expect, it } from 'vitest'

import { firmName, placeName, shortAddress } from '../src/lib/format'

describe('a stop is named by firm and town, in German (owner, 18.11.2026)', () => {
  it('puts the firm before the town and drops the legal form', () => {
    expect(placeName({ company: 'Schnellecke Transportlogistik GmbH', city: '38440 Wolfsburg' })).toBe('Schnellecke 38440 Wolfsburg')
    expect(placeName({ company: 'Schnellecke Transportlogistik GmbH', city: '38440 Wolfsburg' }, false)).toBe('Schnellecke Wolfsburg')
    expect(placeName({ company: 'MB', city: 'Düsseldorf' })).toBe('MB Düsseldorf')
    expect(placeName({ company: 'Forex GmbH', city: 'Bovenden' })).toBe('Forex Bovenden')
    expect(placeName({ company: 'Volkswagen AG', city: 'Wolfsburg' })).toBe('Volkswagen Wolfsburg')
  })

  it('does not repeat the town or cut words that only end like a legal form', () => {
    expect(placeName({ company: 'Demo Lager Göttingen', city: 'Göttingen' })).toBe('Demo Lager Göttingen')
    expect(firmName('Hagemag Spedition')).toBe('Hagemag Spedition')
    expect(firmName('Seifert Logistics & Co. KG')).toBe('Seifert Logistics')
    expect(firmName('MAN Truck & Bus SE Salzgitter Werk')).toBe('MAN')
  })

  it('falls back to the town, and says so when nothing is known', () => {
    expect(placeName({ company: '', city: 'Jena' })).toBe('Jena')
    expect(shortAddress({ id: 's', city: null, company: null } as never)).toBe('Город неизвестен')
  })
})
