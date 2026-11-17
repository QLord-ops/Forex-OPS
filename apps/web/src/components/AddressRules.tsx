import { Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import { api, type AddressRule } from '../lib/api'
import { SettingsSection } from './SettingsSection'

type BuiltIn = Awaited<ReturnType<typeof api.addressRules>>['builtIn']

/** What the import knows about places: rules learned from the dispatchers' corrections and the built-in dictionary. */
export function AddressRules({ onLoaded }: { onLoaded?: (rules: { total: number; fresh: number }) => void } = {}) {
  const [rules, setRules] = useState<AddressRule[]>([])
  const [builtIn, setBuiltIn] = useState<BuiltIn>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const load = useCallback(async () => {
    try {
      const result = await api.addressRules(); setRules(result.rules); setBuiltIn(result.builtIn); setError('')
      onLoaded?.({ total: result.rules.length, fresh: result.rules.filter((rule) => !rule.hits).length })
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Правила не загрузились.') }
  }, [onLoaded])
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
  return <SettingsSection id="address-rules" titleId="settings-rules" title="Правила адресов" scope="shared"
    subtitle="Когда вы исправляете адрес в распознанном Auftrag, он запоминается здесь, и следующий такой Auftrag заполнится сам.">
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
  </SettingsSection>
}
