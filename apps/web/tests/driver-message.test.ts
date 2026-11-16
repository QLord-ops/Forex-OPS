import { describe, expect, it } from 'vitest'

import { addressParts, driverMessage } from '../src/lib/driver-message'
import type { Stop, Tour } from '../src/types/domain'

const stop = (sequence: number, extra: Partial<Stop>): Stop => ({ id: `s${sequence}`, tourId: 't1', sequence, type: 'UNLOAD', address: '', latitude: 52.4, longitude: 13.8, geocodePrecision: 'EXACT', ...extra } as Stop)
const tour = (stops: Stop[], extra: Partial<Tour> = {}) => ({ orderNumber: '1698/611/0299', tourRemarks: null, stops, ...extra }) as Tour

// The LKW Walter Auftrag the owner sent to a driver by hand (16.11.2026).
const load = stop(1, { type: 'LOAD', company: 'Fuyao Europe GmbH', address: 'Laichinger Straße 2, 89150 Laichingen', plannedAt: '2026-11-16T05:00:00Z', referenceNumbers: ['SHP2611-A097616'], loadingMeters: 13.6 })
const unload = stop(2, { type: 'UNLOAD', company: 'Tesla Blackbird Warehouse', address: 'Eichenstraße 2b, 15537 Grünheide', appointmentAt: '2026-11-17T13:00:00Z', referenceNumbersJson: '["SHP2611-A097616"]' })

describe('the Auftrag as text for the driver (owner, 16.11)', () => {
  it('is laid out like the owner\'s own message: few signs, full address in lines, each stop with its Referenz', () => {
    expect(driverMessage(tour([unload, load]))).toBe([
      '📄 Auftrag: 1698/611/0299',
      '📦 Загрузка Nr. 1: Fuyao Europe GmbH\nLaichinger Straße 2\n89150 Laichingen\n16.11.2026\n📄 Referenz: SHP2611-A097616',
      '📍 Выгрузка Nr. 1: Tesla Blackbird Warehouse\nEichenstraße 2b\n15537 Grünheide\n17.11.2026 14:00\n📄 Referenz: SHP2611-A097616'
    ].join('\n\n'))
  })

  it('gives the day alone without a Termin, and no links or loading meters', () => {
    const text = driverMessage(tour([load, unload]))
    expect(text).toContain('89150 Laichingen\n16.11.2026\n📄 Referenz')
    expect(text).not.toContain('06:00')
    expect(text).not.toMatch(/https?:|google|LDM/i)
  })

  it('writes a time window and the Termin shared with the stop before; notes stay with the dispatcher', () => {
    const windowed = { ...unload, appointmentAt: null, appointmentWindowStartAt: '2026-11-17T06:00:00Z', appointmentWindowEndAt: '2026-11-17T07:00:00Z', instructions: 'Halle 3, Tor 7' }
    const leergut = stop(3, { type: 'LOAD', company: 'Tesla Leergut', address: 'Eichenstraße 2b, 15537 Grünheide', terminSharedWithStopId: 's2', referenceNumbers: ['LG-55120'] })
    const text = driverMessage(tour([load, windowed, leergut], { tourRemarks: 'Lorberg Ketzin OT Tremmen f Michaelis Braunschweig - Frachtauftrag: 111' }))
    expect(text).toContain('15537 Grünheide\n17.11.2026 07:00–08:00\n📄 Referenz: SHP2611-A097616\n\n')
    // The Leergut stop names only its own reference, not the one of the unloading before it.
    expect(text.endsWith('📦 Загрузка Nr. 2: Tesla Leergut\nEichenstraße 2b\n15537 Grünheide\nTermin как у выгрузки Nr. 1\n📄 Referenz: LG-55120')).toBe(true)
    expect(text).not.toMatch(/Примечание|Halle 3|Frachtauftrag/)
  })

  // The Lorberg Auftrag (owner, 16.11.2026): no postcode printed, so the found address gives it.
  it('adds the postcode of the found address when the Auftrag prints none', () => {
    const lorberg = stop(1, { type: 'LOAD', company: 'Lorberg Quality Plants GmbH & Co. KG', address: 'Zachower Str. 4, Ketzin OT Tremmen', city: 'Ketzin OT Tremmen',
      resolvedAddress: 'Zachower Straße 4, 14669 Ketzin/Havel, Deutschland', plannedAt: '2026-11-16T05:00:00Z' })
    const michaelis = stop(2, { type: 'UNLOAD', company: 'Hr. Michaelis', address: 'Am Lehmanger 50, Braunschweig', city: null, resolvedAddress: 'Am Lehmanger 50, 38120 Braunschweig, Deutschland' })
    const text = driverMessage(tour([lorberg, michaelis]))
    expect(text).toContain('📦 Загрузка Nr. 1: Lorberg Quality Plants GmbH & Co. KG\nZachower Str. 4\n14669 Ketzin OT Tremmen\n16.11.2026')
    expect(text).toContain('📍 Выгрузка Nr. 1: Hr. Michaelis\nAm Lehmanger 50\n38120 Braunschweig')
  })

  it('leaves out what is done, keeps the numbers, and asks to check a stop known only by its town', () => {
    const done = { ...load, completedAt: '2026-11-16T08:00:00Z' }
    const second = stop(3, { type: 'UNLOAD', company: 'Seifert', address: 'Bremen', city: 'Bremen', geocodePrecision: 'CITY' })
    const text = driverMessage(tour([done, unload, second]))
    expect(text).not.toContain('Загрузка')
    expect(text).toContain('📍 Выгрузка Nr. 2: Seifert\nBremen\nТочный адрес уточни у диспетчера')
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
