import { describe, expect, it } from 'vitest'
import { ankunftHint, flagNotes, groupRows, startHint, type DailyStatusRow } from '../src/lib/daily-status'

const row = (vehicleNumber: string, statusGroup: DailyStatusRow['statusGroup'], extra: Partial<DailyStatusRow> = {}) => ({ id: vehicleNumber, vehicleNumber, statusGroup, flags: [], ...extra }) as DailyStatusRow

describe('status page helpers', () => {
  it('shows NORD, SÜD, LuFe in the Excel order and a block for trucks without a group only when there are any', () => {
    const blocks = groupRows([row('124', 'SUED'), row('777', null), row('9724', 'NORD'), row('3010', 'LUFE')])
    expect(blocks.map((block) => [block.title, block.rows.map((item) => item.vehicleNumber)])).toEqual([
      ['NORD', ['9724']], ['SÜD', ['124']], ['LuFe', ['3010']], ['Без группы', ['777']]
    ])
    expect(groupRows([row('9724', 'NORD')]).map((block) => block.title)).toEqual(['NORD', 'SÜD', 'LuFe'])
  })
  it('explains every estimate in words', () => {
    expect(startHint(row('1', 'NORD', { startKind: 'TERMIN_LATEST' }))).toContain('успеть к Termin')
    expect(startHint(row('1', 'NORD', { startKind: 'TACHO' }))).toBe('Начало смены по тахографу Webfleet')
    expect(ankunftHint(row('1', 'NORD', { ankunftKind: 'ETA' }))).toBe('Оценка прибытия с паузами водителя')
    expect(flagNotes(row('1', 'NORD', { flags: ['GPS_STALE', 'TACHO_MISSING', 'ROUTE_ESTIMATE'] }))).toEqual(['GPS устарел', 'путь оценён по прямой'])
  })
})
