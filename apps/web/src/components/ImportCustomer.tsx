import { RefreshCw } from 'lucide-react'

import type { Customer } from '../lib/api'
import { customerColor } from '../lib/customers'
import { AUTO_CUSTOMER } from '../lib/import-customer'
import type { ImportCustomer, ImportCustomerSource } from '../types/domain'
import './customers.css'

const SOURCE_LABEL: Record<ImportCustomerSource, string> = {
  SELECTED: 'выбран вами',
  DOCUMENT: 'по шапке документа',
  AI: 'по ответу ИИ',
  VEHICLE: 'по линии машины'
}

/** Which customer's profile the AI reads the next Auftrag with. Hidden until customers exist. */
export function ImportCustomerSelect({ customers, value, onChange, disabled }: { customers: Customer[]; value: string; onChange: (id: string) => void; disabled?: boolean }) {
  if (!customers.length) return null
  return <label className="import-customer-select">
    <span className="field-label">Заказчик Auftrag</span>
    <select className="field-input" value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
      <option value={AUTO_CUSTOMER}>Определить автоматически</option>
      {customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.name}</option>)}
    </select>
  </label>
}

/**
 * Whose Auftrag the check shows and how that was found. When the parse did not use that customer's profile, or the
 * letterhead names another customer, the stored file can be read again with the right profile.
 */
export function ImportCustomerNote({ customer, customers, busy, canReparse, onReparse }: {
  customer: ImportCustomer | null | undefined; customers: Customer[]; busy: boolean; canReparse: boolean; onReparse: (customerId: string | null) => void
}) {
  if (!customers.length) return null
  const known = customer ? customers.find((item) => item.id === customer.id) : null
  const suggested = !customer ? null
    : !customer.profileApplied ? customer
      : customer.detected && customer.detected.id !== customer.id && customer.detected.source === 'DOCUMENT' ? customer.detected : null
  const others = customers.filter((item) => item.id !== customer?.id || !customer.profileApplied)
  return <div className="import-customer-note" role="group" aria-label="Чей это Auftrag">
    {customer ? <span className="import-customer-name">
      <span className="customer-swatch" style={{ background: known ? customerColor(known) : undefined }} aria-hidden="true" />
      <strong>{customer.name}</strong>
      <span>{SOURCE_LABEL[customer.source]}{customer.profileApplied ? '' : ' · разобран без его профиля'}</span>
    </span> : <span className="import-customer-name"><strong>Заказчик не определён</strong></span>}
    {canReparse && suggested ? <button type="button" className="secondary-button compact-button" disabled={busy} onClick={() => onReparse(suggested.id)}>
      <RefreshCw className="h-4 w-4" aria-hidden="true" />Разобрать по профилю {suggested.name}
    </button> : null}
    {canReparse ? <label className="import-customer-other">
      <span className="sr-only">Разобрать заново для другого заказчика</span>
      <select className="field-input" value="" disabled={busy} onChange={(event) => { if (event.target.value) onReparse(event.target.value === AUTO_CUSTOMER ? null : event.target.value) }}>
        <option value="">Другой заказчик…</option>
        {others.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        {customer ? <option value={AUTO_CUSTOMER}>Определить автоматически</option> : null}
      </select>
    </label> : null}
  </div>
}
