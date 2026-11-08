import { Trash2, Users } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import { api, customersApi, type Customer, type ImportRule } from '../lib/api'
import { currentDispatcherRole } from '../lib/auth'

const KIND_LABEL: Record<string, string> = { ALIAS: 'Сокращение', IGNORE_LABEL: 'Не точка', STOP_TYPE: 'Тип точки' }
const ALL = ''

function describe(rule: Pick<ImportRule, 'kind' | 'pattern' | 'value'>) {
  const pattern = rule.pattern.toUpperCase()
  if (rule.kind === 'ALIAS') return `${pattern} = ${rule.value ?? '–'}`
  if (rule.kind === 'IGNORE_LABEL') return `${pattern}${rule.value ? ` — груз (${rule.value})` : ' — не точка'}`
  return `${rule.pattern} — всегда ${rule.value === 'LOAD' ? 'загрузка' : 'выгрузка'}`
}

/**
 * What the import learned from the dispatchers' corrections of recognised Auftrag, and the built-in shorthand.
 * A rule belongs to the customer whose Auftrag taught it; one learned at two customers can be made common.
 */
export function ImportRules() {
  const [rules, setRules] = useState<ImportRule[]>([])
  const [builtIn, setBuiltIn] = useState<Array<Pick<ImportRule, 'kind' | 'pattern' | 'value'>>>([])
  const [customers, setCustomers] = useState<Customer[]>([])
  const [customerId, setCustomerId] = useState(ALL)
  const [corrections, setCorrections] = useState(0)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const admin = currentDispatcherRole() === 'admin'
  const load = useCallback(async () => {
    try { const result = await api.importRules(customerId || null); setRules(result.rules); setBuiltIn(result.builtIn); setCorrections(result.corrections.last7d); setError('') }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Правила не загрузились.') }
  }, [customerId])
  useEffect(() => { void load() }, [load])
  useEffect(() => { customersApi.list().then(setCustomers).catch(() => undefined) }, [])

  async function act(rule: ImportRule, action: () => Promise<unknown>, failure: string) {
    setBusy(rule.id)
    try { await action(); await load() }
    catch (cause) { setError(cause instanceof Error ? cause.message : failure) } finally { setBusy(null) }
  }
  const toggle = (rule: ImportRule) => act(rule, () => api.updateImportRule(rule.id, { active: !rule.active }), 'Правило не изменено.')
  function remove(rule: ImportRule) {
    if (!window.confirm(`Удалить правило «${describe(rule)}»? Оно появится снова после двух таких же правок.`)) return
    void act(rule, () => api.deleteImportRule(rule.id), 'Правило не удалено.')
  }
  function promote(rule: ImportRule) {
    if (!window.confirm(`Сделать правило «${describe(rule)}» общим? Оно будет применяться к Auftrag всех заказчиков.`)) return
    void act(rule, () => api.promoteImportRule(rule.id), 'Правило не стало общим.')
  }

  return <section className="settings-card" aria-labelledby="settings-import-rules">
    <h3 id="settings-import-rules" className="section-title">Правила импорта</h3>
    <p className="page-subtitle">Каждая ваша правка распознанного Auftrag запоминается для его заказчика. Правило включается после двух одинаковых правок в Auftrag одного заказчика и применяется к его следующим Auftrag; ИИ получает его вместе с примерами подтверждённых туров.{corrections ? ` Правок за 7 дней: ${corrections}.` : ''}</p>
    {customers.length ? <label className="rules-filter"><span className="field-label">Заказчик</span>
      <select className="field-input" value={customerId} onChange={(event) => setCustomerId(event.target.value)}>
        <option value={ALL}>Все правила</option>
        {customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.name} и общие</option>)}
      </select>
    </label> : null}
    {error ? <p className="quick-order-error" role="alert">{error}</p> : null}
    {rules.length ? <table className="rules-table">
      <thead><tr><th>Вид</th><th>Правило</th><th>Заказчик</th><th>Правок</th><th>Включено</th><th><span className="sr-only">Действия</span></th></tr></thead>
      <tbody>{rules.map((rule) => <tr key={rule.id}>
        <td>{KIND_LABEL[rule.kind] ?? rule.kind}</td>
        <td><strong>{describe(rule)}</strong><span>{rule.lastSeenAt ? `последняя ${new Date(rule.lastSeenAt).toLocaleDateString('ru-RU')}` : ''}</span></td>
        <td>{rule.customer ? rule.customer.name : 'Общее'}{rule.promotable ? <span>выучено и у других заказчиков</span> : null}</td>
        <td>{rule.hits}</td>
        <td><label className="rules-toggle"><input type="checkbox" checked={rule.active} disabled={busy === rule.id} onChange={() => void toggle(rule)} />{rule.active ? 'да' : 'нет'}</label></td>
        <td className="rules-actions">
          {admin && rule.promotable ? <button type="button" className="secondary-button compact-button" onClick={() => promote(rule)} disabled={busy === rule.id}><Users className="h-4 w-4" aria-hidden="true" />Сделать общим</button> : null}
          <button type="button" className="icon-button icon-button-compact" onClick={() => remove(rule)} disabled={busy === rule.id} aria-label={`Удалить правило ${describe(rule)}`}><Trash2 className="h-4 w-4" /></button>
        </td>
      </tr>)}</tbody>
    </table> : <p className="page-subtitle">Пока нет выученных правил: они появятся после ваших правок при проверке Auftrag.</p>}
    <details className="rules-builtin">
      <summary>Встроенные, для всех заказчиков · {builtIn.length}</summary>
      <p>{builtIn.map(describe).join(' · ')}</p>
    </details>
  </section>
}
