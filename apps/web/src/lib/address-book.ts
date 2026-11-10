import { authHeaders, notifySessionExpired } from './auth'
import { ApiError, readErrorMessage } from './api'
import type { AddressResolution } from '../types/domain'

export interface AddressSuggestion {
  id: string; source: 'WEBFLEET' | 'OPS' | 'RULE'; label: string; line2: string; company: string | null; street: string | null
  postalCode: string | null; city: string | null; latitude: number; longitude: number; radiusMeters: number | null
}
/** A row of the fleet's own address book (Settings → «Адреса из Auftrag»). */
export interface OwnAddressRow {
  id: string; name: string; street: string | null; postalCode: string | null; city: string | null; groups: string | null
  active: boolean; useCount: number; lastSeenAt: string
}
export interface AddressBookStatus {
  configured: boolean; at: string | null; nextAt: string | null; error: string | null; total: number | null
  added?: number; updated?: number; hidden?: number; message: string | null
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, { ...init, credentials: 'same-origin', headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...authHeaders() } })
  if (!response.ok) {
    if (response.status === 401) notifySessionExpired()
    throw new ApiError(await readErrorMessage(response), response.status)
  }
  return response.json() as Promise<T>
}

export const addressBookApi = {
  search: (q: string, signal?: AbortSignal) => call<{ suggestions: AddressSuggestion[] }>(`/addresses/search?q=${encodeURIComponent(q)}&limit=8`, { signal }),
  used: (id: string) => call<{ ok: true }>(`/addresses/${encodeURIComponent(id)}/used`, { method: 'POST', body: '{}' }),
  own: (q: string) => call<{ total: number; addresses: OwnAddressRow[] }>(`/addresses/own?q=${encodeURIComponent(q)}&limit=50`),
  setOwnActive: (id: string, active: boolean) => call<{ id: string; active: boolean }>(`/addresses/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ active }) }),
  /** Without `apply` only counts what earlier tours would add. */
  backfillOwn: (apply: boolean) => call<{ added: number; counted: number; skipped: number; applied: boolean }>('/addresses/own/backfill', { method: 'POST', body: JSON.stringify({ apply }) }),
  status: () => call<AddressBookStatus>('/integrations/webfleet/address-book'),
  sync: () => call<AddressBookStatus>('/integrations/webfleet/address-book/sync', { method: 'POST', body: '{}' })
}

/** The street line for an address field: "Frisiusstraße 1, 26723 Emden", or the name when the book has no street. */
export function suggestionAddress(item: Pick<AddressSuggestion, 'street' | 'postalCode' | 'city' | 'label'>) {
  const place = [item.postalCode, item.city].filter(Boolean).join(' ')
  return [item.street, place].filter(Boolean).join(', ') || item.label
}
export const suggestionSourceLabel = (item: Pick<AddressSuggestion, 'source'>) => item.source === 'WEBFLEET' ? 'Webfleet' : item.source === 'OPS' ? 'из Auftrag' : 'выучено'
/** The source a stop keeps for a picked suggestion. */
export const suggestionProvider = (item: Pick<AddressSuggestion, 'source'>) => item.source === 'WEBFLEET' ? 'webfleet-address' : item.source === 'OPS' ? 'ops-address' : 'address-rule'

/** A picked suggestion as an exact address resolution: the stop keeps its coordinates and is not geocoded again. */
export function suggestionResolution(item: AddressSuggestion): AddressResolution {
  const address = suggestionAddress(item)
  return { address, sourceAddress: address, resolvedAddress: [item.label, address].join(', '), latitude: item.latitude, longitude: item.longitude,
    city: item.city, provider: suggestionProvider(item), precision: 'EXACT', attempts: [] }
}
