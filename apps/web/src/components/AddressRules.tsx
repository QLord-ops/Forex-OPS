import { Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import { api, type AddressRule } from '../lib/api'

type BuiltIn = Awaited<ReturnType<typeof api.addressRules>>['builtIn']

/** What the import knows about places: rules learned from the dispatchers' corrections and the built-in dictionary. */
export function AddressRules() {
  const [rules, setRules] = useState<AddressRule[]>([])
  const [builtIn, setBuiltIn] = useState<BuiltIn>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const load = useCallback(async () => {
    try { const result = await api.addressRules(); setRules(result.rules); setBuiltIn(result.builtIn); setError('') }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Правила не загрузились.') }
  }, [])
  useEffect(() => { void load() }, [load])

  async function toggleTermin(rule: AddressRule) {
    setBusy(rule.id)
    try { await api.updateAddressRule(rule.id, { requiresTermin: !rule.requiresTermin }); await load() }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Правило не изменено.') } finally { setBusy(null) }
  }
  async function remove(rule: AddressRule) {
    if (!window.confirm(`Удалить правило «${rule.pattern}»? Следующий такой Auftrag снова попросит адрес.`)) return
    setBusy(rule.id)
    try { await api.deleteAddressRule(rule.id); await load() }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Правило не удалено.') } finally { setBusy(null) }
  }

  const companies = builtIn.filter((rule) => rule.kind === 'COMPANY')
  const codes = builtIn.filter((rule) => rule.kind === 'CITY_CODE')
  return <section className="settings-card" aria-labelledby="settings-rules">
    <h3 id="settings-rules" className="section-title">Правила адресов</h3>
    <p className="page-subtitle">Когда вы исправляете адрес в распознанном Auftrag, он запоминается здесь, и следующий такой Auftrag заполнится сам.</p>
    {error ? <p className="quick-order-error" role="alert">{error}</p> : null}
    {rules.length ? <table className="rules-table">
      <thead><tr><th>Из Auftrag</th><th>Адрес</th><th>Termin</th><th><span className="sr-only">Действия</span></th></tr></thead>
      <tbody>{rules.map((rule) => <tr key={rule.id}>
        <td><strong>{rule.pattern}</strong><span>{rule.hits ? `применено ${rule.hits}` : 'новое'}</span></td>
        <td>{[rule.company, rule.street, [rule.postalCode, rule.city].filter(Boolean).join(' ')].filter(Boolean).join(', ') || '–'}</td>
        <td><label className="rules-toggle"><input type="checkbox" checked={rule.requiresTermin} disabled={busy === rule.id} onChange={() => void toggleTermin(rule)} />нужен</label></td>
        <td><button type="button" className="icon-button icon-button-compact" onClick={() => void remove(rule)} disabled={busy === rule.id} aria-label={`Удалить правило ${rule.pattern}`}><Trash2 className="h-4 w-4" /></button></td>
      </tr>)}</tbody>
    </table> : <p className="page-subtitle">Пока нет выученных адресов.</p>}
    <details className="rules-builtin">
      <summary>Встроенный словарь · {builtIn.length}</summary>
      <p><strong>Фирмы:</strong> {companies.map((rule) => `${rule.pattern.toUpperCase()} = ${rule.company}${rule.requiresTermin ? ' (Termin)' : ''}`).join(' · ')}</p>
      <p><strong>Коды городов:</strong> {codes.map((rule) => `${rule.pattern.toUpperCase()} = ${rule.city}`).join(' · ')}</p>
    </details>
  </section>
}
