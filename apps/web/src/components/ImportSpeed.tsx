import { useCallback, useEffect, useState } from 'react'

import { api } from '../lib/api'
import { speedCard } from '../lib/import-stats'
import type { ImportSpeedSummary } from '../types/domain'

/** Admin card: how fast the last Auftrag were read against the 10 s promise, and what the server is set to. */
export function ImportSpeed() {
  const [summary, setSummary] = useState<ImportSpeedSummary | null>(null)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setBusy(true); setError('')
    try { setSummary(await api.importSpeed()) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Скорость не загружена.') }
    finally { setBusy(false) }
  }, [])
  useEffect(() => { void load() }, [load])

  const card = summary ? speedCard(summary) : null
  return <section className="settings-card" aria-labelledby="settings-import-speed">
    <h3 id="settings-import-speed" className="section-title">Скорость распознавания</h3>
    <p className="page-subtitle">{summary?.count
      ? `По ${summary.count} Auftrag с замером из последних ${summary.documents} документов. Время — от загрузки файла до готового разбора на сервере.`
      : 'Сколько секунд сервер читает Auftrag: считается по последним 100 документам.'}</p>
    {card ? <>
      <p className="speed-verdict" role="status">{card.verdict}</p>
      <dl className="speed-rows">{card.rows.map((row) => <div key={row.label} className="contents"><dt>{row.label}</dt><dd>{row.value}</dd></div>)}</dl>
      {card.warning ? <p className="quick-order-error" role="alert">{card.warning}</p> : null}
    </> : null}
    {summary && !card ? <p className="page-subtitle" role="status">Замеров пока нет — появятся после первого PDF или фото, прочитанного после обновления.</p> : null}
    {error ? <p className="quick-order-error" role="alert">{error}</p> : null}
    <div><button type="button" className="secondary-button" onClick={() => void load()} disabled={busy}>{busy ? 'Считаем…' : 'Обновить'}</button></div>
  </section>
}
