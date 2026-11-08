import { Download, RefreshCw, Pencil, RotateCcw } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'

import { EmptyState, ErrorState, LoadingState } from '../components/States'
import { usePolling } from '../hooks/usePolling'
import { ankunftHint, downloadStatusExcel, flagNotes, groupRows, LEGACY_LIST, startHint, statusApi, type DailyStatusList, type DailyStatusListConfig, type DailyStatusRow } from '../lib/daily-status'
import '../components/status-page.css'

const BERLIN_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' })
const BERLIN_STAMP = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
const todayKey = () => BERLIN_DAY.format(new Date())

/** The 07:00 status list of the Schnellecke line: checked and edited here, sent to the customer as Excel. */
export function StatusPage() {
  const [date, setDate] = useState(todayKey)
  const [listKey, setListKey] = useState<string | null>(null)
  const today = date === todayKey()
  const { data, error, loading, refetch } = usePolling(() => statusApi.list(date, listKey), today ? 60_000 : 0, true, `${date}:${listKey ?? ''}`)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<Error | null>(null)
  const [override, setOverride] = useState<DailyStatusList | null>(null)
  const list = override && override.date === date && (!data || override.report?.generatedAt === data.report?.generatedAt) ? mergeRows(override, data) : data
  const config = list?.list ?? LEGACY_LIST

  async function run(action: () => Promise<unknown>) {
    setBusy(true); setActionError(null)
    try { await action() } catch (cause) { setActionError(cause as Error) } finally { setBusy(false) }
  }
  async function regenerate() {
    const reset = window.confirm('Сформировать список заново по текущим данным?\n\nПравки Bemerkung и WE in Northeim сохранятся. Нажмите «Отмена», чтобы не формировать.')
    if (!reset) return
    await run(async () => { setOverride(await statusApi.generate({ list: config.key })); await refetch() })
  }

  if (loading && !list) return <LoadingState />
  if (error && !list) return <ErrorState error={error} onRetry={refetch} />
  const report = list?.report ?? null
  const rows = list?.rows ?? []
  const lists = list?.lists ?? []
  const ungrouped = rows.filter((row) => !row.statusGroup).length

  return <div className="space-y-4 status-page">
    <div className="page-header">
      <div className="min-w-0">
        <h2 className="page-title">Статус {config.name}</h2>
        <p className="page-subtitle">Формируется автоматически в {config.dueLocalTime} по Берлину. Проверьте, поправьте Bemerkung и скачайте Excel для заказчика.</p>
      </div>
      <div className="status-actions">
        <label className="status-date"><span className="field-label">День</span>
          <input className="field-input" type="date" value={date} max={todayKey()} onChange={(event) => { setOverride(null); setDate(event.target.value || todayKey()) }} />
        </label>
        {today ? <button type="button" className="secondary-button" disabled={busy} onClick={() => void regenerate()}><RefreshCw className="h-4 w-4" aria-hidden="true" />Сформировать заново</button> : null}
        {report ? <button type="button" className="primary-button" disabled={busy} onClick={() => void run(() => downloadStatusExcel(date, config))}><Download className="h-4 w-4" aria-hidden="true" />Скачать Excel</button> : null}
      </div>
    </div>

    {lists.length > 1 ? <div className="customer-tabs" role="tablist" aria-label="Заказчик">
      {lists.map((item) => <button key={item.key} type="button" role="tab" aria-selected={item.key === config.key} className={item.key === config.key ? 'customer-tab customer-tab-active' : 'customer-tab'}
        onClick={() => { setOverride(null); setListKey(item.key) }}>{item.name}</button>)}
    </div> : null}
    {report ? <p className="status-meta" role="status">
      <span>Сформирован {report.generatedAt ? BERLIN_STAMP.format(new Date(report.generatedAt)).replace(',', '') : '—'} · {report.generatedByRole === 'system' ? 'автоматически' : 'вручную'}</span>
      {report.preliminary ? <span className="status-chip status-chip-warn">Предварительно: данные Webfleet были неполные</span> : null}
      {report.status === 'FAILED' ? <span className="status-chip status-chip-error">Не удалось сформировать — нажмите «Сформировать заново»</span> : null}
      {!today ? <span className="status-chip">Прошлый день: только просмотр</span> : null}
    </p> : null}
    {ungrouped ? <p className="status-banner" role="status">{ungrouped === 1 ? '1 машина' : `${ungrouped} машин`} без группы {config.groups.map((group) => group.name).join(' / ')} — укажите линию на странице <Link to="/vehicles">«Машины»</Link>.</p> : null}
    {actionError ? <ErrorState error={actionError} /> : null}

    {!report ? <div className="space-y-3">
      <EmptyState label={today ? 'Список на сегодня ещё не сформирован: он появится в 07:00 или по кнопке ниже.' : 'За этот день списка нет.'} />
      {today ? <button type="button" className="primary-button" disabled={busy} onClick={() => void run(async () => { setOverride(await statusApi.generate({ list: config.key })); await refetch() })}>Сформировать сейчас</button> : null}
    </div> : !rows.length ? <EmptyState label={`Нет машин заказчика ${config.name}. Поставьте их на его линии на странице «Машины».`} /> : groupRows(rows, config.groups).map((block) =>
      <section key={block.title} className="work-surface status-block" aria-labelledby={`status-${block.title}`}>
        <h3 id={`status-${block.title}`} className="status-block-title">{block.title} <span className="status-count">{block.rows.length}</span></h3>
        <div className="overflow-x-auto">
          <table className="status-table">
            {/* Same column widths in every block, so NORD, SÜD and LuFe line up like the Excel. */}
            <colgroup>{columnsOf(config).map((column, index) => <col key={index} style={column.width ? { width: column.width } : undefined} />)}</colgroup>
            <thead><tr>{columnsOf(config).map((column) => <th key={column.label} scope="col">{column.label}</th>)}</tr></thead>
            <tbody>
              {block.rows.map((row) => <StatusRow key={row.id} row={row} columns={config.columns} editable={Boolean(list?.editable)}
                onSaved={(saved) => setOverride((current) => replaceRow(current ?? list, saved))} />)}
            </tbody>
          </table>
        </div>
      </section>)}
  </div>
}

/** Same column widths in every block, so the blocks line up like the Excel; optional columns follow the customer's profile. */
function columnsOf(config: DailyStatusListConfig) {
  return [
    { label: 'LKW', width: 64 }, { label: 'Ort', width: 140 }, { label: 'Start', width: 80 }, { label: 'Ziel', width: 140 }, { label: 'Ankunft', width: 104 },
    { label: 'Bemerkung', width: undefined }, { label: 'Trailer', width: 104 },
    ...(config.columns.we ? [{ label: config.columns.we, width: 132 }] : []),
    { label: 'Телефон', width: 140 },
    ...(config.columns.aSchild ? [{ label: 'A Schild', width: 72 }] : []),
    ...(config.columns.appSped ? [{ label: 'AppSped', width: 72 }] : [])
  ]
}

function StatusRow({ row, columns, editable, onSaved }: { row: DailyStatusRow; columns: DailyStatusListConfig['columns']; editable: boolean; onSaved: (row: DailyStatusRow) => void }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(row.shown.bemerkung)
  const [we, setWe] = useState(row.weNortheim ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const notes = flagNotes(row)

  async function save(input: { bemerkung?: string | null; weNortheim?: string | null }) {
    setBusy(true); setError('')
    try { onSaved(await statusApi.editRow(row.id, { version: row.version, ...input })); setEditing(false) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Не сохранено.') }
    finally { setBusy(false) }
  }

  return <tr>
    <th scope="row" className="status-lkw">{row.vehicleNumber}</th>
    <td>{row.shown.ort || '—'}{notes.length ? <span className="status-notes">{notes.join(' · ')}</span> : null}</td>
    <td title={startHint(row)} className="tabular-nums">{row.shown.start || '—'}</td>
    <td>{row.shown.ziel || '—'}</td>
    <td title={ankunftHint(row)} className="tabular-nums">{row.shown.ankunft || '—'}</td>
    <td className="status-remark">
      {editing ? <form onSubmit={(event) => { event.preventDefault(); void save({ bemerkung: draft.trim() ? draft.trim() : null }) }} className="status-edit">
        <label className="sr-only" htmlFor={`remark-${row.id}`}>Bemerkung LKW {row.vehicleNumber}</label>
        <textarea id={`remark-${row.id}`} className="field-input" rows={2} maxLength={500} value={draft} autoFocus
          onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') { setEditing(false); setDraft(row.shown.bemerkung) } }} />
        <span className="status-edit-actions">
          <button type="button" className="secondary-button compact-button" disabled={busy} onClick={() => { setEditing(false); setDraft(row.shown.bemerkung) }}>Отмена</button>
          <button type="submit" className="primary-button compact-button" disabled={busy}>Сохранить</button>
        </span>
      </form> : <>
        <span>{row.shown.bemerkung || '—'}</span>
        {row.bemerkung !== null ? <span className="status-chip">изменено</span> : null}
        {editable ? <span className="status-edit-actions">
          <button type="button" className="status-icon-button" aria-label={`Изменить Bemerkung LKW ${row.vehicleNumber}`} onClick={() => { setDraft(row.shown.bemerkung); setEditing(true) }}><Pencil className="h-3.5 w-3.5" aria-hidden="true" /></button>
          {row.bemerkung !== null ? <button type="button" className="status-icon-button" aria-label={`Вернуть авто-текст LKW ${row.vehicleNumber}`} title="Вернуть авто-текст" disabled={busy} onClick={() => void save({ bemerkung: null })}><RotateCcw className="h-3.5 w-3.5" aria-hidden="true" /></button> : null}
        </span> : null}
      </>}
      {error ? <span className="status-error" role="alert">{error}</span> : null}
    </td>
    <td>{row.shown.trailer || '—'}</td>
    {columns.we ? <td>{editable ? <input className="field-input status-we" aria-label={`${columns.we} LKW ${row.vehicleNumber}`} maxLength={100} value={we}
      onChange={(event) => setWe(event.target.value)} onBlur={() => { if (we.trim() !== (row.weNortheim ?? '')) void save({ weNortheim: we.trim() || null }) }} /> : row.weNortheim || '—'}</td> : null}
    <td className="tabular-nums">{row.servicePhone || '—'}</td>
    {columns.aSchild ? <td className={row.aSchild ? 'status-yes' : 'status-no'}>{row.aSchild ? 'ja' : 'nein'}</td> : null}
    {columns.appSped ? <td className={row.appSped ? 'status-yes' : 'status-no'}>{row.appSped ? 'ja' : 'nein'}</td> : null}
  </tr>
}

function replaceRow(list: DailyStatusList | null, row: DailyStatusRow): DailyStatusList | null {
  return list ? { ...list, rows: list.rows.map((item) => item.id === row.id ? { ...item, ...row } : item) } : list
}
/** A just-saved row stays as saved until the next poll brings it back from the server. */
function mergeRows(local: DailyStatusList, server: DailyStatusList | null): DailyStatusList {
  if (!server) return local
  return { ...server, rows: server.rows.map((row) => { const mine = local.rows.find((item) => item.id === row.id); return mine && mine.version > row.version ? mine : row }) }
}
