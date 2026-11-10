import { describe, expect, it } from 'vitest'
import { ankunftHint, flagNotes, groupByOwner, groupRows, ownedBy, startHint, type DailyStatusRow } from '../src/lib/daily-status'

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

describe('status by dispatcher', () => {
  const owner = (id: string, name: string) => ({ owner: { id, name, source: 'LINE' as const, active: true } })
  const rows = [row('101', 'NORD', owner('ben', 'Ben Muster')), row('102', 'NORD'), row('103', 'SUED', owner('me', 'Zoe Weber')),
    row('104', 'SUED', owner('anna', 'Anna Schmidt')), row('105', 'NORD', owner('ben', 'Ben Muster'))]

  it('one section per dispatcher: me first, colleagues by name, trucks of nobody last', () => {
    expect(groupByOwner(rows, 'me').map((section) => [section.owner?.name ?? 'Ничьи', section.rows.map((item) => item.vehicleNumber)])).toEqual([
      ['Zoe Weber', ['103']], ['Anna Schmidt', ['104']], ['Ben Muster', ['101', '105']], ['Ничьи', ['102']]
    ])
    expect(groupByOwner(rows, null)[0]!.owner?.name).toBe('Anna Schmidt')
  })

  it('«Мои машины» are only the trucks this dispatcher sends; without an account there are none', () => {
    expect(ownedBy(rows, 'ben').map((item) => item.vehicleNumber)).toEqual(['101', '105'])
    expect(ownedBy(rows, null)).toEqual([])
  })
})
