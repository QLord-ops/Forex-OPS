import { describe, expect, it } from 'vitest'

import { addressParts, driverMessage } from '../src/lib/driver-message'
import type { Stop, Tour } from '../src/types/domain'

const stop = (sequence: number, extra: Partial<Stop>): Stop => ({ id: `s${sequence}`, tourId: 't1', sequence, type: 'UNLOAD', address: '', latitude: 52.4, longitude: 13.8, ...extra } as Stop)
const tour = (stops: Stop[], extra: Partial<Tour> = {}) => ({ orderNumber: 'SHP2611-A097451', trailerPlate: 'HROM2855', tourRemarks: null, stops, vehicle: { licensePlate: 'GÖFX727' }, ...extra }) as Tour

// The LKW Walter Auftrag for Tesla Grünheide (owner, 16.11.2026).
const load = stop(1, { type: 'LOAD', company: 'Thyssenkrupp Presta AG', address: 'Sommerfeld 22-28, 45481 Mülheim an der Ruhr', latitude: 51.41234, longitude: 6.88765,
  plannedAt: '2026-11-16T05:00:00Z', referenceNumbers: ['SHP2611-A097451'], loadingMeters: 13.6, geocodePrecision: 'EXACT' })
const unload = stop(2, { type: 'UNLOAD', company: 'Tesla Blackbird Warehouse', address: 'Eichenstraße 2b, 15537 Grünheide', latitude: 52.39876, longitude: 13.79012,
  appointmentAt: '2026-11-17T11:00:00Z', referenceNumbersJson: '["SHP2611-A097451"]', instructions: 'Halle 3, Tor 7', geocodePrecision: 'EXACT' })

describe('the Auftrag as text for the driver (owner, 16.11)', () => {
  it('reads like a list: a sign per line, firm, street, postcode with town, Berlin time, no links', () => {
    expect(driverMessage(tour([unload, load]))).toBe([
      '🚛 *Auftrag SHP2611-A097451*\nLKW: GÖFX727\nПрицеп: HROM2855',
      '1️⃣ 🟢 *ЗАГРУЗКА*\n🏭 Thyssenkrupp Presta AG\n📍 Sommerfeld 22-28\n🏙️ 45481 Mülheim an der Ruhr\n📅 16.11 (без Termin)\n🔖 Ref: SHP2611-A097451\n📏 13,6 LDM',
      '2️⃣ 🔴 *ВЫГРУЗКА*\n🏭 Tesla Blackbird Warehouse\n📍 Eichenstraße 2b\n🏙️ 15537 Grünheide\n⏰ Termin: 17.11 в 12:00\n🔖 Ref: SHP2611-A097451\n💬 Halle 3, Tor 7'
    ].join('\n\n'))
  })

  it('gives the day alone without a Termin: the planned hour is not the plant\'s', () => {
    const text = driverMessage(tour([load, unload]))
    expect(text).toContain('📅 16.11 (без Termin)')
    expect(text).not.toContain('06:00')
    expect(text).not.toMatch(/https?:|google/i)
  })

  it('writes a time window, the Termin shared with the stop before, and the tour remark', () => {
    const windowed = { ...unload, appointmentAt: null, appointmentWindowStartAt: '2026-11-17T06:00:00Z', appointmentWindowEndAt: '2026-11-17T07:00:00Z' }
    const leergut = stop(3, { type: 'LOAD', company: 'Tesla Leergut', address: 'Eichenstraße 2b, 15537 Grünheide', terminSharedWithStopId: 's2', geocodePrecision: 'EXACT' })
    const text = driverMessage(tour([load, windowed, leergut], { tourRemarks: 'Tesla Grünheide, danach Leergut' }))
    expect(text).toContain('⏰ Termin: 17.11 с 07:00 до 08:00')
    expect(text).toContain('3️⃣ 🟢 *ЗАГРУЗКА*\n🏭 Tesla Leergut\n📍 Eichenstraße 2b\n🏙️ 15537 Grünheide\n⏰ Termin тот же, что у точки 2')
    expect(text.endsWith('📝 *Важно:* Tesla Grünheide, danach Leergut')).toBe(true)
  })

  it('leaves out what is done, and asks to check a stop known only by its town', () => {
    const done = { ...load, completedAt: '2026-11-16T08:00:00Z' }
    const town = { ...unload, address: 'Grünheide', city: 'Grünheide', geocodePrecision: 'CITY' as const }
    const text = driverMessage(tour([done, town]))
    expect(text).not.toContain('ЗАГРУЗКА')
    expect(text).toContain('🏙️ Grünheide\n❗ Точный адрес уточни у диспетчера')
    expect(text).not.toContain('📍')
  })

  it('carries no phone, no driver and nothing of the system\'s own notes', () => {
    const text = driverMessage(tour([load, unload], { vehicle: { licensePlate: 'GÖFX727', servicePhone: '+49 151 0000000' } as Tour['vehicle'] }))
    expect(text).not.toMatch(/\+49|Fahrer|водител|точност|EXACT/i)
  })
})

describe('the address in parts', () => {
  it('splits street with number from postcode with town', () => {
    expect(addressParts({ address: 'Halle 3, Eichenstraße 2b, 15537 Grünheide, Deutschland', city: 'Grünheide' })).toEqual({ street: 'Halle 3, Eichenstraße 2b', town: '15537 Grünheide' })
  })

  it('takes the town from the city field when the address has no postcode', () => {
    expect(addressParts({ address: 'Mühlenweg 78, Bovenden', city: '37120 Bovenden' })).toEqual({ street: 'Mühlenweg 78', town: '37120 Bovenden' })
    expect(addressParts({ address: 'Mühlenweg 78', city: '37120 Bovenden' })).toEqual({ street: 'Mühlenweg 78', town: '37120 Bovenden' })
    expect(addressParts({ address: 'Bremen', city: 'Bremen' })).toEqual({ street: '', town: 'Bremen' })
  })
})
