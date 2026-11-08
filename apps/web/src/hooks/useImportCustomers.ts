import { useEffect, useState } from 'react'

import { customersApi, type Customer } from '../lib/api'
import { currentDispatcher } from '../lib/auth'
import { defaultImportCustomer } from '../lib/import-customer'

/** Active customers for the Auftrag upload and the current choice; until the dispatcher picks, the default follows the truck. */
export function useImportCustomers(preferredId: string | null = null) {
  const [customers, setCustomers] = useState<Customer[]>([])
  const [picked, setPicked] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    customersApi.list().then((list) => { if (alive) setCustomers(list.filter((customer) => customer.active)) }).catch(() => undefined)
    return () => { alive = false }
  }, [])
  const customerId = picked ?? defaultImportCustomer(customers, preferredId, currentDispatcher()?.id ?? null)
  return { customers, customerId, setCustomerId: setPicked }
}
