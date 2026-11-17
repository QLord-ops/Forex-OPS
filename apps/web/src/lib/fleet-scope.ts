import { useSyncExternalStore } from 'react'

import { currentDispatcher, currentDispatcherRole } from './auth'

export type FleetScope = 'MINE' | 'FLEET' | 'FREE'
export type FleetViewer = { id: string | null; role: 'admin' | 'dispatcher' | null }

const STORAGE_KEY = 'ops-fleet-scope'
const SCOPES: readonly FleetScope[] = ['MINE', 'FLEET', 'FREE']
const listeners = new Set<() => void>()
/** What the person picked since the page was opened; a dispatcher's pick lives no longer than that. */
let picked: { id: string; scope: FleetScope } | null = null

function stored(id: string): FleetScope | null {
  try {
    const value = window.localStorage.getItem(`${STORAGE_KEY}:${id}`)
    return SCOPES.includes(value as FleetScope) ? value as FleetScope : null
  } catch { return null }
}

/**
 * Whose trucks the map, the list and the notifications show (owner, 17.11): a dispatcher starts every visit with
 * their own and opens the rest only for a look; an admin sees the whole fleet and may hide every line but their own,
 * which is remembered. The shared login belongs to nobody and sees everything.
 */
export function scopeOf(viewer: FleetViewer): FleetScope {
  if (!viewer.id) return 'FLEET'
  if (picked?.id === viewer.id) return picked.scope
  return viewer.role === 'admin' ? stored(viewer.id) ?? 'FLEET' : 'MINE'
}

export function chooseScope(viewer: FleetViewer, scope: FleetScope) {
  if (!viewer.id) return
  picked = { id: viewer.id, scope }
  if (viewer.role === 'admin') {
    try { window.localStorage.setItem(`${STORAGE_KEY}:${viewer.id}`, scope) } catch { /* convenience only */ }
  }
  for (const listener of listeners) listener()
}

/** Only an admin's «Мои линии» narrows the notifications; a dispatcher's are narrowed by the server. */
export function notificationsScope(viewer: FleetViewer): 'mine' | 'all' {
  return viewer.role === 'admin' && scopeOf(viewer) === 'MINE' ? 'mine' : 'all'
}

type ScopedRow = { vehicle: { id: string }; mine?: boolean; assignedTo?: unknown }

export function inScope(row: ScopedRow, scope: FleetScope): boolean {
  return scope === 'FLEET' || (scope === 'MINE' ? Boolean(row.mine) : !row.assignedTo)
}

/** The trucks drawn on the map: those of the chosen scope, and always the one the dispatcher opened. */
export function fleetOnMap<T extends ScopedRow>(rows: T[], scope: FleetScope, selectedId?: string | null): T[] {
  return rows.filter((row) => inScope(row, scope) || row.vehicle.id === selectedId)
}

export const currentViewer = (): FleetViewer => ({ id: currentDispatcher()?.id ?? null, role: currentDispatcherRole() ?? null })
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }

export function useFleetScope(): { viewer: FleetViewer; scope: FleetScope; setScope: (scope: FleetScope) => void } {
  const viewer = currentViewer()
  const scope = useSyncExternalStore(subscribe, () => scopeOf(currentViewer()))
  return { viewer, scope, setScope: (next) => chooseScope(viewer, next) }
}

/** For tests: forget what was picked in this page. */
export function resetFleetScope() { picked = null }
