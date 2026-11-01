import type { Vehicle } from '../types/domain'

export type VehicleMatch = { status: 'MATCHED' | 'AMBIGUOUS' | 'NOT_FOUND'; id?: string; vehicle?: Vehicle; candidates?: Vehicle[] }

export function normalizeVehicleKey(value: string) {
  return value.toLocaleUpperCase('de-DE').replace(/^LKW\s*/i, '').replace(/[^A-ZА-Я0-9ÄÖÜ]/g, '')
}

/** Matches by internal truck number or registration plate, ignoring "LKW", spaces and dashes. */
export function vehicleMatch(requested: string | null | undefined, vehicles: Vehicle[]): VehicleMatch {
  if (!requested?.trim()) return { status: 'NOT_FOUND' }
  const key = normalizeVehicleKey(requested)
  if (!key) return { status: 'NOT_FOUND' }
  const matches = vehicles.filter((vehicle) => [vehicle.vehicleNumber, vehicle.licensePlate ?? ''].some((value) => value && normalizeVehicleKey(value) === key))
  if (matches.length === 1) return { status: 'MATCHED', id: matches[0].id, vehicle: matches[0] }
  return matches.length > 1 ? { status: 'AMBIGUOUS', candidates: matches } : { status: 'NOT_FOUND' }
}

/** Text that clearly means "a truck", not an address: digits only, or an "LKW …" prefix. */
export function looksLikeVehicleReference(value: string) {
  const text = value.trim()
  // Up to four digits: German postcodes have five, so "37120" stays an address.
  return /^\d{1,4}$/.test(text) || /^LKW\b/i.test(text)
}
