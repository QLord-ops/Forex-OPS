import { authHeaders, notifySessionExpired } from './auth'
import { ApiError, readErrorMessage } from './api'
import type { StatusGroup, VehicleLine } from '../types/domain'

export type StatusFlag = 'NO_WEBFLEET' | 'GPS_STALE' | 'NO_GPS' | 'TACHO_MISSING' | 'ROUTE_ESTIMATE' | 'PRELIMINARY' | 'TERMIN_AT_RISK'
export interface DailyStatusRow {
  id: string; vehicleId: string | null; vehicleNumber: string; statusGroup: StatusGroup | string | null; rule: 'STUCK' | 'EMPTY' | 'AT_STOP' | 'EN_ROUTE'
  startKind: 'TACHO' | 'TERMIN_LATEST' | 'AFTER_REST' | 'DEFAULT' | 'NONE'; ankunftKind: 'TERMIN' | 'ETA' | 'ARRIVED' | 'NONE'
  bemerkungAuto: string | null; bemerkung: string | null; weNortheim: string | null; servicePhone: string | null; aSchild: boolean; appSped: boolean
  ortSource: string | null; trailerSource: string | null; version: number; edited: boolean; flags: StatusFlag[]
  shown: { ort: string; start: string; ziel: string; ankunft: string; bemerkung: string; trailer: string }
  /** Whose Excel the line goes into: the dispatcher who took the truck, or the dispatcher of its line; null = nobody's. */
  owner?: DailyStatusOwner | null
}
export interface DailyStatusOwner { id: string; name: string; source: 'TAKEN' | 'LINE'; active: boolean }
export interface DailyStatusReport {
  id: string; line: string; date: string; status: 'GENERATING' | 'READY' | 'FAILED'; preliminary: boolean
  generatedAt: string | null; generatedByRole: 'system' | 'admin' | 'dispatcher'
}
export interface DailyStatusListConfig {
  key: string; name: string; dueLocalTime: string; groups: Array<{ code: string; name: string }>; columns: { we: string | null; aSchild: boolean; appSped: boolean }
  /** Made by itself every morning; false = by the button only. Absent from older servers, where every list was automatic. */
  auto?: boolean
}
export interface DailyStatusList {
  date: string; editable: boolean; report: DailyStatusReport | null; rows: DailyStatusRow[]
  /** The customer's list; absent from servers before customers, which only had Schnellecke. */
  list?: DailyStatusListConfig; lists?: Array<{ key: string; name: string; auto?: boolean }>
  /** Dispatchers who have trucks in the list; absent from servers before the per-dispatcher status. */
  owners?: Array<{ id: string; name: string; active: boolean; count: number }>
  viewer?: { dispatcherId: string | null; role: 'admin' | 'dispatcher' }
}
export type StatusScope = 'MINE' | 'ALL'
export interface OwnerSection { key: string; owner: Omit<DailyStatusOwner, 'source'> | null; rows: DailyStatusRow[] }
export const LEGACY_LIST: DailyStatusListConfig = {
  key: 'SCHNELLECKE', name: 'Schnellecke', dueLocalTime: '07:00',
  groups: [{ code: 'NORD', name: 'NORD' }, { code: 'SUED', name: 'SÜD' }, { code: 'LUFE', name: 'LuFe' }],
  columns: { we: 'WE in Northeim', aSchild: true, appSped: true }
}
export interface StatusPresetCandidate { id: string; vehicleNumber: string; currentLine: VehicleLine | null; defaultSelected: boolean }

const API = '/api'
async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API}${path}`, { ...init, credentials: 'same-origin',
    headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...authHeaders() } })
  if (!response.ok) {
    if (response.status === 401) notifySessionExpired()
    throw new ApiError(await readErrorMessage(response), response.status)
  }
  return response.json() as Promise<T>
}

export const statusApi = {
  list: (date?: string, list?: string | null) => {
    const query = new URLSearchParams({ ...(date ? { date } : {}), ...(list ? { list } : {}) }).toString()
    return call<DailyStatusList>(`/daily-status${query ? `?${query}` : ''}`)
  },
  generate: (input: { resetEdits?: boolean; list?: string | null } = {}) =>
    call<DailyStatusList>('/daily-status/generate', { method: 'POST', body: JSON.stringify({ resetEdits: input.resetEdits, ...(input.list ? { list: input.list } : {}) }) }),
  editRow: (id: string, input: { version: number; bemerkung?: string | null; weNortheim?: string | null }) =>
    call<DailyStatusRow>(`/daily-status/rows/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(input) }),
  updateVehicle: (id: string, input: { line?: VehicleLine | null; statusGroup?: StatusGroup | null; servicePhone?: string | null; aSchild?: boolean; appSped?: boolean }) =>
    call<{ id: string }>(`/vehicles/${encodeURIComponent(id)}/status-settings`, { method: 'PATCH', body: JSON.stringify(input) }),
  preset: () => call<{ line: VehicleLine; candidates: StatusPresetCandidate[] }>('/vehicles/status-settings/preset?line=SCHNELLECKE'),
  applyPreset: (vehicleIds: string[]) => call<{ changed: number; skipped: number }>('/vehicles/status-settings/bulk', { method: 'POST', body: JSON.stringify({ line: 'SCHNELLECKE', vehicleIds }) })
}

/** Downloads the list as the dispatcher's Excel ("Status 2026-11-05.xlsx"). */
export async function downloadStatusExcel(date: string, list?: DailyStatusListConfig, owner?: string) {
  const params = new URLSearchParams({ ...(list && list.key !== LEGACY_LIST.key ? { list: list.key } : {}), ...(owner ? { owner } : {}) }).toString()
  const query = params ? `?${params}` : ''
  const response = await fetch(`${API}/daily-status/${encodeURIComponent(date)}/export.xlsx${query}`, { credentials: 'same-origin', headers: authHeaders() })
  if (!response.ok) {
    if (response.status === 401) notifySessionExpired()
    throw new ApiError(await readErrorMessage(response), response.status)
  }
  const url = URL.createObjectURL(await response.blob())
  const link = document.createElement('a')
  link.href = url
  link.download = `Status ${list && list.key !== LEGACY_LIST.key ? `${list.name} ` : ''}${date}.xlsx`
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export const GROUP_LABEL: Record<StatusGroup, string> = { NORD: 'NORD', SUED: 'SÜD', LUFE: 'LuFe' }
export const LINE_LABEL: Record<VehicleLine, string> = { SCHNELLECKE: 'Schnellecke', WALTER_TESLA: 'Walter Tesla', OTHER: 'Другая' }

/** Blocks in the order of the Excel: the customer's lines (NORD, SÜD, LuFe), then the trucks still without a line. */
/** The trucks whose status this dispatcher sends. */
export function ownedBy(rows: DailyStatusRow[], me: string | null): DailyStatusRow[] {
  return me ? rows.filter((row) => row.owner?.id === me) : []
}

/** One section per dispatcher: me first, colleagues by name, the trucks of nobody last. */
export function groupByOwner(rows: DailyStatusRow[], me: string | null): OwnerSection[] {
  const sections = new Map<string, OwnerSection>()
  for (const row of rows) {
    const key = row.owner?.id ?? ''
    const section = sections.get(key) ?? { key, owner: row.owner ? { id: row.owner.id, name: row.owner.name, active: row.owner.active } : null, rows: [] }
    section.rows.push(row)
    sections.set(key, section)
  }
  const rank = (section: OwnerSection) => !section.owner ? 2 : section.owner.id === me ? 0 : 1
  return [...sections.values()].sort((a, b) => rank(a) - rank(b) || (a.owner?.name ?? '').localeCompare(b.owner?.name ?? '', 'de'))
}

export function groupRows(rows: DailyStatusRow[], groups: DailyStatusListConfig['groups'] = LEGACY_LIST.groups) {
  const codes = groups.map((group) => group.code)
  return [
    ...groups.map((group) => ({ group: group.code as string | null, title: group.name, rows: rows.filter((row) => row.statusGroup === group.code) })),
    { group: null as string | null, title: 'Без группы', rows: rows.filter((row) => !row.statusGroup || !codes.includes(row.statusGroup)) }
  ].filter((block) => block.group !== null || block.rows.length > 0)
}

const START_HINT: Record<DailyStatusRow['startKind'], string> = {
  TACHO: 'Начало смены по тахографу Webfleet',
  TERMIN_LATEST: 'Оценка: самый поздний выезд, чтобы успеть к Termin с паузами и запасом 30 мин',
  AFTER_REST: 'Оценка: после суточного отдыха по тахографу',
  DEFAULT: 'Оценка: смена ещё не открыта, данных тахографа нет',
  NONE: ''
}
const ANKUNFT_HINT: Record<DailyStatusRow['ankunftKind'], string> = {
  TERMIN: 'Termin точки', ETA: 'Оценка прибытия с паузами водителя', ARRIVED: 'Фактическое прибытие по GPS', NONE: ''
}
export const startHint = (row: Pick<DailyStatusRow, 'startKind'>) => START_HINT[row.startKind]
export const ankunftHint = (row: Pick<DailyStatusRow, 'ankunftKind'>) => ANKUNFT_HINT[row.ankunftKind]

const FLAG_TEXT: Record<StatusFlag, string | null> = {
  NO_WEBFLEET: 'нет Webfleet', GPS_STALE: 'GPS устарел', NO_GPS: 'нет GPS', TACHO_MISSING: null, ROUTE_ESTIMATE: 'путь оценён по прямой',
  PRELIMINARY: 'предварительно', TERMIN_AT_RISK: 'Termin под угрозой'
}
/** Short notes next to a row: always text, never only a colour. */
export function flagNotes(row: Pick<DailyStatusRow, 'flags'>) {
  return row.flags.map((flag) => FLAG_TEXT[flag]).filter((text): text is string => Boolean(text))
}
