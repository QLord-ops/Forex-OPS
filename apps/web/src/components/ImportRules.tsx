import { Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import { api, type ImportRule } from '../lib/api'

const KIND_LABEL: Record<string, string> = { ALIAS: 'Сокращение', IGNORE_LABEL: 'Не точка', STOP_TYPE: 'Тип точки' }

function describe(rule: Pick<ImportRule, 'kind' | 'pattern' | 'value'>) {
  const pattern = rule.pattern.toUpperCase()
  if (rule.kind === 'ALIAS') return `${pattern} = ${rule.value ?? '–'}`
  if (rule.kind === 'IGNORE_LABEL') return `${pattern}${rule.value ? ` — груз (${rule.value})` : ' — не точка'}`
  return `${rule.pattern} — всегда ${rule.value === 'LOAD' ? 'загрузка' : 'выгрузка'}`
}

/** What the import learned from the dispatchers' corrections of recognised Auftrag, and the built-in shorthand. */
export function ImportRules() {
  const [rules, setRules] = useState<ImportRule[]>([])
  const [builtIn, setBuiltIn] = useState<Array<Pick<ImportRule, 'kind' | 'pattern' | 'value'>>>([])
  const [corrections, setCorrections] = useState(0)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const load = useCallback(async () => {
    try { const result = await api.importRules(); setRules(result.rules); setBuiltIn(result.builtIn); setCorrections(result.corrections.last7d); setError('') }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Правила не загрузились.') }
  }, [])
  useEffect(() => { void load() }, [load])

  async function toggle(rule: ImportRule) {
    setBusy(rule.id)
    try { await api.updateImportRule(rule.id, { active: !rule.active }); await load() }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Правило не изменено.') } finally { setBusy(null) }
  }
  async function remove(rule: ImportRule) {
    if (!window.confirm(`Удалить правило «${describe(rule)}»? Оно появится снова после двух таких же правок.`)) return
    setBusy(rule.id)
    try { await api.deleteImportRule(rule.id); await load() }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Правило не удалено.') } finally { setBusy(null) }
  }

  return <section className="settings-card" aria-labelledby="settings-import-rules">
    <h3 id="settings-import-rules" className="section-title">Правила импорта</h3>
    <p className="page-subtitle">Каждая ваша правка распознанного Auftrag запоминается. Правило включается после двух одинаковых правок и применяется к следующим Auftrag; ИИ получает его вместе с примерами подтверждённых туров.{corrections ? ` Правок за 7 дней: ${corrections}.` : ''}</p>
    {error ? <p className="quick-order-error" role="alert">{error}</p> : null}
    {rules.length ? <table className="rules-table">
      <thead><tr><th>Вид</th><th>Правило</th><th>Правок</th><th>Включено</th><th><span className="sr-only">Действия</span></th></tr></thead>
      <tbody>{rules.map((rule) => <tr key={rule.id}>
        <td>{KIND_LABEL[rule.kind] ?? rule.kind}</td>
        <td><strong>{describe(rule)}</strong><span>{rule.lastSeenAt ? `последняя ${new Date(rule.lastSeenAt).toLocaleDateString('ru-RU')}` : ''}</span></td>
        <td>{rule.hits}</td>
        <td><label className="rules-toggle"><input type="checkbox" checked={rule.active} disabled={busy === rule.id} onChange={() => void toggle(rule)} />{rule.active ? 'да' : 'нет'}</label></td>
        <td><button type="button" className="icon-button icon-button-compact" onClick={() => void remove(rule)} disabled={busy === rule.id} aria-label={`Удалить правило ${describe(rule)}`}><Trash2 className="h-4 w-4" /></button></td>
      </tr>)}</tbody>
    </table> : <p className="page-subtitle">Пока нет выученных правил: они появятся после ваших правок при проверке Auftrag.</p>}
    <details className="rules-builtin">
      <summary>Встроенные · {builtIn.length}</summary>
      <p>{builtIn.map(describe).join(' · ')}</p>
    </details>
  </section>
}
