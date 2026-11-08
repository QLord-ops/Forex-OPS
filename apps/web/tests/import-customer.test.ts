import { describe, expect, it } from 'vitest'
import type { Customer } from '../src/lib/api'
import { AUTO_CUSTOMER, defaultImportCustomer } from '../src/lib/import-customer'

const customer = (id: string, dispatchers: Array<{ id: string; name: string; primary: boolean }>, lineActive = true) => ({
  id, name: id, slug: id.toUpperCase(), category: 'OEM_LOGISTICS', color: null, active: true, aliases: [], createdAt: '', updatedAt: '',
  profile: {} as Customer['profile'],
  lines: [{ id: `${id}-line`, customerId: id, code: 'L', name: 'L', active: lineActive, sortIndex: 0, departmentCompany: null, departmentAddress: null, departmentCity: null, vehicleCount: 1, dispatchers }]
}) as Customer

describe('default customer of an Auftrag upload', () => {
  const schnellecke = customer('sl', [{ id: 'anna', name: 'Anna', primary: true }])
  const walter = customer('wt', [{ id: 'anna', name: 'Anna', primary: false }, { id: 'boris', name: 'Boris', primary: true }])

  it('follows the truck first, then my primary line, else reads automatically', () => {
    expect(defaultImportCustomer([schnellecke, walter], 'wt', 'anna')).toBe('wt')
    expect(defaultImportCustomer([schnellecke, walter], null, 'anna')).toBe('sl')
    expect(defaultImportCustomer([schnellecke, walter], null, 'boris')).toBe('wt')
    expect(defaultImportCustomer([schnellecke, walter], 'archived', null)).toBe(AUTO_CUSTOMER)
    expect(defaultImportCustomer([customer('sl', [{ id: 'anna', name: 'Anna', primary: true }], false)], null, 'anna')).toBe(AUTO_CUSTOMER)
    expect(defaultImportCustomer([], null, 'anna')).toBe(AUTO_CUSTOMER)
  })
})
