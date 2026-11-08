import type { Customer } from './api'

/** Upload without a chosen customer: the server reads the Auftrag and then names the customer. */
export const AUTO_CUSTOMER = 'auto'

/** The truck's customer, else the customer of my primary line, else automatic detection. */
export function defaultImportCustomer(customers: Customer[], preferredId: string | null, me: string | null): string {
  if (preferredId && customers.some((customer) => customer.id === preferredId)) return preferredId
  const mine = me ? customers.find((customer) => customer.lines.some((line) => line.active && line.dispatchers.some((person) => person.id === me && person.primary))) : null
  return mine?.id ?? AUTO_CUSTOMER
}
