import { describe, expect, it } from 'vitest'

import { driverMessage } from '../src/lib/driver-message'
import type { Stop, Tour } from '../src/types/domain'

const stop = (sequence: number, extra: Partial<Stop>): Stop => ({ id: `s${sequence}`, tourId: 't1', sequence, type: 'UNLOAD', address: '', latitude: 52.4, longitude: 13.8, ...extra } as Stop)
const tour = (stops: Stop[], extra: Partial<Tour> = {}) => ({ orderNumber: 'SHP2611-A097451', trailerPlate: 'HROM2855', tourRemarks: null, stops, vehicle: { licensePlate: 'GÖFX727' }, ...extra }) as Tour

// The LKW Walter Auftrag for Tesla Grünheide (owner, 16.11.2026).
const load = stop(1, { type: 'LOAD', company: 'Thyssenkrupp Presta AG', address: 'Sommerfeld 22-28, 45481 Mülheim an der Ruhr', latitude: 51.41234, longitude: 6.88765,
  plannedAt: '2026-11-16T05:00:00Z', referenceNumbers: ['SHP2611-A097451'], loadingMeters: 13.6, geocodePrecision: 'EXACT' })
const unload = stop(2, { type: 'UNLOAD', company: 'Tesla Blackbird Warehouse', address: 'Eichenstraße 2b, 15537 Grünheide', latitude: 52.39876, longitude: 13.79012,
  appointmentAt: '2026-11-17T11:00:00Z', referenceNumbersJson: '["SHP2611-A097451"]', instructions: 'Halle 3, Tor 7', geocodePrecision: 'EXACT' })

describe('the Auftrag as text for the driver (owner, 16.11)', () => {
  it('lists the stops in order in Russian, Berlin time, references, LDM and a map link', () => {
    expect(driverMessage(tour([unload, load]))).toBe([
      '*Auftrag SHP2611-A097451*\nLKW GÖFX727 · прицеп HROM2855',
      '*1. Загрузка* — Thyssenkrupp Presta AG\nSommerfeld 22-28, 45481 Mülheim an der Ruhr\nПлан: 16.11 06:00, без Termin\nRef: SHP2611-A097451 · 13,6 LDM\nhttps://www.google.com/maps?q=51.41234,6.88765',
      '*2. Выгрузка* — Tesla Blackbird Warehouse\nEichenstraße 2b, 15537 Grünheide\nTermin: 17.11 12:00\nRef: SHP2611-A097451\nПримечание: Halle 3, Tor 7\nhttps://www.google.com/maps?q=52.39876,13.79012'
    ].join('\n\n'))
  })

  it('writes a time window, the Termin shared with the stop before, and the tour remark', () => {
    const windowed = { ...unload, appointmentAt: null, appointmentWindowStartAt: '2026-11-17T06:00:00Z', appointmentWindowEndAt: '2026-11-17T07:00:00Z' }
    const leergut = stop(3, { type: 'LOAD', company: 'Tesla Leergut', address: 'Eichenstraße 2b, 15537 Grünheide', terminSharedWithStopId: 's2', geocodePrecision: 'EXACT' })
    const text = driverMessage(tour([load, windowed, leergut], { tourRemarks: 'Tesla Grünheide, danach Leergut' }))
    expect(text).toContain('Termin: 17.11 07:00–08:00')
    expect(text).toContain('*3. Загрузка* — Tesla Leergut\nEichenstraße 2b, 15537 Grünheide\nTermin: вместе с точкой 2')
    expect(text.endsWith('Примечание к туру: Tesla Grünheide, danach Leergut')).toBe(true)
  })

  it('leaves out what is done, and sends no town centre as a navigation target', () => {
    const done = { ...load, completedAt: '2026-11-16T08:00:00Z' }
    const town = { ...unload, geocodePrecision: 'CITY' as const }
    const text = driverMessage(tour([done, town]))
    expect(text).not.toContain('Загрузка')
    expect(text).toContain('Точный адрес уточнить у диспетчера')
    expect(text).not.toContain('google.com')
  })

  it('carries no phone, no driver and nothing of the system\'s own notes', () => {
    const text = driverMessage(tour([load, unload], { vehicle: { licensePlate: 'GÖFX727', servicePhone: '+49 151 0000000' } as Tour['vehicle'] }))
    expect(text).not.toMatch(/\+49|Fahrer|водител|точност|EXACT/i)
  })
})
