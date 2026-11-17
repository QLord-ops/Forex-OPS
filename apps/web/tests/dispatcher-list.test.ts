import { describe, expect, it } from 'vitest'

import type { DispatcherAccount } from '../src/lib/api'
import { accountCounts, filterAccounts, initialsOf, lastLoginText } from '../src/lib/dispatcher-list'

const account = (id: string, extra: Partial<DispatcherAccount> = {}): DispatcherAccount => ({
  id, login: id, displayName: id, role: 'dispatcher', active: true, lastLoginAt: null, createdAt: '2026-11-01T00:00:00Z', lines: [{ lineId: 'nord', isPrimary: true }], ...extra
})
const accounts = [
  account('anna.k', { displayName: 'Anna Keller', role: 'admin' }),
  account('ben.h', { displayName: 'Ben Hoffmann', lines: [{ lineId: 'dsv', isPrimary: true }] }),
  account('dmitri.s', { displayName: 'Dmitri Sokol', lines: [] }),
  account('erik.l', { displayName: 'Erik Lang', active: false, lines: [] })
]
const names: Record<string, string> = { nord: 'Schnellecke · Nord', dsv: 'DSV · DSV' }

describe('the dispatchers list', () => {
  it('counts the active, those without lines, the switched-off and the admins', () => {
    expect(accountCounts(accounts)).toEqual({ active: 3, noLines: 1, off: 1, admins: 1 })
  })

  it('shows the active ones, only those without lines, or the switched-off ones', () => {
    const ids = (filter: Parameters<typeof filterAccounts>[1], query = '') => filterAccounts(accounts, filter, query, (id) => names[id]).map((item) => item.id)
    expect(ids('active')).toEqual(['anna.k', 'ben.h', 'dmitri.s'])
    expect(ids('no-lines')).toEqual(['dmitri.s'])
    expect(ids('off')).toEqual(['erik.l'])
    expect(ids('active', 'dsv')).toEqual(['ben.h'])
    expect(ids('active', 'SOKOL')).toEqual(['dmitri.s'])
    expect(ids('active', 'anna.k')).toEqual(['anna.k'])
    expect(ids('active', 'nobody')).toEqual([])
  })

  it('writes initials and the last sign-in in Germany time', () => {
    expect(initialsOf('Anna Keller')).toBe('AK')
    expect(initialsOf('Yurii van der Berg')).toBe('YB')
    expect(initialsOf('chef')).toBe('CH')
    expect(initialsOf('  ')).toBe('?')
    const now = new Date('2026-11-17T21:40:00Z') // 22:40 in Germany
    expect(lastLoginText(null, now)).toBe('ещё не входил')
    expect(lastLoginText('2026-11-17T20:34:00Z', now)).toBe('сегодня, 21:34')
    expect(lastLoginText('2026-11-16T06:02:00Z', now)).toBe('вчера, 07:02')
    expect(lastLoginText('2026-11-11T08:25:00Z', now)).toBe('11.11, 09:25')
    // 23:30 UTC is already the next day in Germany.
    expect(lastLoginText('2026-11-16T23:30:00Z', now)).toBe('сегодня, 00:30')
  })
})
