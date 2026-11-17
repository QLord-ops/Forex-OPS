import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { chooseScope, fleetOnMap, inScope, notificationsScope, resetFleetScope, scopeOf, type FleetViewer } from '../src/lib/fleet-scope'

const anna: FleetViewer = { id: 'd-anna', role: 'dispatcher' }
const chef: FleetViewer = { id: 'd-chef', role: 'admin' }
const shared: FleetViewer = { id: null, role: 'dispatcher' }

let saved: Record<string, string>
beforeEach(() => {
  saved = {}
  resetFleetScope()
  vi.stubGlobal('window', { localStorage: { getItem: (key: string) => saved[key] ?? null, setItem: (key: string, value: string) => { saved[key] = value } } })
})
afterEach(() => { vi.unstubAllGlobals() })

describe('whose trucks a person sees (owner, 17.11)', () => {
  it('a dispatcher starts with their own, an admin with the whole fleet, the shared login sees everything', () => {
    expect(scopeOf(anna)).toBe('MINE')
    expect(scopeOf(chef)).toBe('FLEET')
    expect(scopeOf(shared)).toBe('FLEET')
  })

  it('a dispatcher opens the rest only for this visit', () => {
    chooseScope(anna, 'FLEET')
    expect(scopeOf(anna)).toBe('FLEET')
    expect(saved).toEqual({})
    resetFleetScope()
    expect(scopeOf(anna)).toBe('MINE')
  })

  it('an admin\'s «Мои линии» is remembered and belongs to that admin', () => {
    chooseScope(chef, 'MINE')
    resetFleetScope()
    expect(scopeOf(chef)).toBe('MINE')
    expect(scopeOf({ id: 'd-other', role: 'admin' })).toBe('FLEET')
    expect(scopeOf(anna)).toBe('MINE')
  })

  it('the pick of one person never becomes another\'s in the same page', () => {
    chooseScope(anna, 'FREE')
    expect(scopeOf({ id: 'd-ben', role: 'dispatcher' })).toBe('MINE')
  })

  it('works without storage and ignores a broken stored value', () => {
    saved['ops-fleet-scope:d-chef'] = 'EVERYTHING'
    expect(scopeOf(chef)).toBe('FLEET')
    vi.stubGlobal('window', { get localStorage(): Storage { throw new Error('blocked') } })
    expect(scopeOf(chef)).toBe('FLEET')
    chooseScope(chef, 'MINE')
    expect(scopeOf(chef)).toBe('MINE')
  })

  it('only an admin\'s own-lines view narrows the notifications', () => {
    expect(notificationsScope(chef)).toBe('all')
    chooseScope(chef, 'MINE')
    expect(notificationsScope(chef)).toBe('mine')
    chooseScope(chef, 'FREE')
    expect(notificationsScope(chef)).toBe('all')
    expect(notificationsScope(anna)).toBe('all')
  })
})

describe('the map follows the list', () => {
  const rows = [
    { vehicle: { id: 'mine' }, mine: true, assignedTo: { id: 'd-anna' } },
    { vehicle: { id: 'line' }, mine: true, assignedTo: null },
    { vehicle: { id: 'ben' }, mine: false, assignedTo: { id: 'd-ben' } },
    { vehicle: { id: 'free' }, mine: false, assignedTo: null }
  ]
  const ids = (list: typeof rows) => list.map((row) => row.vehicle.id)

  it('draws only the trucks of the scope', () => {
    expect(ids(fleetOnMap(rows, 'MINE'))).toEqual(['mine', 'line'])
    expect(ids(fleetOnMap(rows, 'FREE'))).toEqual(['line', 'free'])
    expect(ids(fleetOnMap(rows, 'FLEET'))).toEqual(['mine', 'line', 'ben', 'free'])
    expect(inScope(rows[2]!, 'MINE')).toBe(false)
  })

  it('keeps the opened truck on the map whoever runs it', () => {
    expect(ids(fleetOnMap(rows, 'MINE', 'ben'))).toEqual(['mine', 'line', 'ben'])
  })
})
