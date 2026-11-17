import type { DispatcherAccount } from './api'

export type AccountFilter = 'active' | 'no-lines' | 'off'

export interface AccountCounts { active: number; noLines: number; off: number; admins: number }

export const hasNoLines = (account: DispatcherAccount) => !(account.lines?.length)

export function accountCounts(accounts: DispatcherAccount[]): AccountCounts {
  const active = accounts.filter((account) => account.active)
  return {
    active: active.length,
    noLines: active.filter(hasNoLines).length,
    off: accounts.length - active.length,
    admins: active.filter((account) => account.role === 'admin').length
  }
}

/**
 * The accounts the list shows: active ones (or only those without lines), or the switched-off ones, matched by name,
 * login or line. `lineName` turns a line id into «Kunde · Linie».
 */
export function filterAccounts(accounts: DispatcherAccount[], filter: AccountFilter, query: string, lineName: (lineId: string) => string | undefined = () => undefined) {
  const text = query.trim().toLocaleLowerCase('de')
  return accounts.filter((account) => {
    if (filter === 'off' ? account.active : !account.active) return false
    if (filter === 'no-lines' && !hasNoLines(account)) return false
    if (!text) return true
    const haystack = [account.displayName, account.login, ...(account.lines ?? []).map((line) => lineName(line.lineId) ?? '')].join(' ').toLocaleLowerCase('de')
    return haystack.includes(text)
  })
}

export function initialsOf(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1]![0] : parts[0]?.[1] ?? '')).toUpperCase() || '?'
}

const BERLIN_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' })
const BERLIN_TIME = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
const BERLIN_DATE = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit' })

/** «сегодня, 21:34», «вчера, 07:02» or «11.11, 09:25», Germany time; «ещё не входил» when never. */
export function lastLoginText(value: string | null, now = new Date()) {
  if (!value) return 'ещё не входил'
  const at = new Date(value)
  if (Number.isNaN(at.getTime())) return '—'
  const day = BERLIN_DAY.format(at)
  const time = BERLIN_TIME.format(at)
  if (day === BERLIN_DAY.format(now)) return `сегодня, ${time}`
  if (day === BERLIN_DAY.format(new Date(now.getTime() - 86_400_000))) return `вчера, ${time}`
  return `${BERLIN_DATE.format(at).replace(/\.$/, '')}, ${time}`
}
