import { Download, RefreshCw, Pencil, RotateCcw, UserPlus } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'

import { EmptyState, ErrorState, LoadingState } from '../components/States'
import { usePolling } from '../hooks/usePolling'
import { api } from '../lib/api'
import { ankunftHint, downloadStatusExcel, flagNotes, groupByOwner, groupRows, LEGACY_LIST, ownedBy, startHint, statusApi, type DailyStatusList, type DailyStatusListConfig, type DailyStatusRow, type StatusScope } from '../lib/daily-status'
import '../components/status-page.css'

const BERLIN_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' })
const BERLIN_STAMP = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
const todayKey = () => BERLIN_DAY.format(new Date())
const SCOPE_STORAGE_KEY = 'ops-status-scope'
/** Up to this many customers fit as tabs on a phone; more become a select. */
const MAX_TABS = 5

function readScope(key: string): StatusScope | null {
  try { const value = window.localStorage.getItem(key); return value === 'MINE' || value === 'ALL' ? value : null } catch { return null }
}
function writeScope(key: string, scope: StatusScope) {
  try { window.localStorage.setItem(key, scope) } catch { /* the choice just is not remembered */ }
}
const trucks = (count: number) => count === 1 ? '1 машина' : count >= 2 && count <= 4 ? `${count} машины` : `${count} машин`

/** The daily status lists of the customers: each dispatcher checks and sends their own trucks, an admin sees everyone's. */
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
  const me = list?.viewer?.dispatcherId ?? null
  const everyone = !list?.viewer || list.viewer.role === 'admin' || !me
  // Servers before the per-dispatcher status send no owners: the page stays one shared list.
  const perDispatcher = Boolean(list?.owners)
  const scopeKey = `${SCOPE_STORAGE_KEY}:${me ?? ''}`
  const [scope, setScope] = useState<StatusScope | null>(null)
  useEffect(() => { setScope(readScope(scopeKey)) }, [scopeKey])
  const activeScope: StatusScope = !perDispatcher || !me ? 'ALL' : scope ?? (list?.viewer?.role === 'admin' ? 'ALL' : 'MINE')

  async function run(action: () => Promise<unknown>) {
    setBusy(true); setActionError(null)
    try { await action() } catch (cause) { setActionError(cause as Error) } finally { setBusy(false) }
  }
  async function regenerate() {
    const reset = window.confirm('Сформировать список заново по текущим данным?\n\nПравки Bemerkung и WE in Northeim сохранятся. Нажмите «Отмена», чтобы не формировать.')
    if (!reset) return
    await run(async () => { setOverride(await statusApi.generate({ list: config.key })); await refetch() })
  }
  function chooseScope(next: StatusScope) {
    setScope(next)
    writeScope(scopeKey, next)
  }
  const take = (row: DailyStatusRow) => run(async () => {
    if (!row.vehicleId) return
    await api.assignVehicle(row.vehicleId, { action: 'take', expectedDispatcherId: null })
    window.dispatchEvent(new CustomEvent('ops:data-changed'))
    setOverride(null)
    await refetch()
  })

  if (loading && !list) return <LoadingState />
  if (error && !list) return <ErrorState error={error} onRetry={refetch} />
  const report = list?.report ?? null
  const rows = list?.rows ?? []
  const lists = list?.lists ?? []
  const auto = config.auto !== false
  const mine = ownedBy(rows, me)
  const nobodys = rows.filter((row) => !row.owner)
  const shownRows = activeScope === 'MINE' ? mine : rows
  const ungrouped = shownRows.filter((row) => !row.statusGroup).length
  const canEdit = (row: DailyStatusRow) => Boolean(list?.editable) && (everyone || !row.owner || row.owner.id === me)
  const onSaved = (saved: DailyStatusRow) => setOverride((current) => replaceRow(current ?? list, saved))
  const download = (owner?: string) => run(() => downloadStatusExcel(date, config, owner))
  const blocks = (items: DailyStatusRow[], prefix: string) => <LineBlocks rows={items} config={config} prefix={prefix} skipEmpty={perDispatcher} canEdit={canEdit} onSaved={onSaved}
    onTake={me && today ? take : undefined} busy={busy} />

  return <div className="space-y-4 status-page">
    <div className="page-header">
      <div className="min-w-0">
        <h2 className="page-title">Статус {config.name}</h2>
        <p className="page-subtitle">{auto ? `Формируется автоматически в ${config.dueLocalTime} по Берлину.` : 'Формируется по кнопке «Сформировать».'} Проверьте, поправьте Bemerkung и скачайте Excel для заказчика.</p>
      </div>
      <div className="status-actions">
        <label className="status-date"><span className="field-label">День</span>
          <input className="field-input" type="date" value={date} max={todayKey()} onChange={(event) => { setOverride(null); setDate(event.target.value || todayKey()) }} />
        </label>
        {today ? <button type="button" className="secondary-button" disabled={busy} onClick={() => void regenerate()}><RefreshCw className="h-4 w-4" aria-hidden="true" />Сформировать заново</button> : null}
        {report && perDispatcher && me && mine.length ? <button type="button" className="primary-button" disabled={busy} onClick={() => void download('mine')}><Download className="h-4 w-4" aria-hidden="true" />Скачать мой Excel</button> : null}
        {report && everyone && (activeScope === 'ALL' || !perDispatcher) ? <button type="button" className={perDispatcher && me && mine.length ? 'secondary-button' : 'primary-button'} disabled={busy} onClick={() => void download()}>
          <Download className="h-4 w-4" aria-hidden="true" />{perDispatcher ? 'Скачать весь список' : 'Скачать Excel'}</button> : null}
      </div>
    </div>

    {lists.length > MAX_TABS ? <label className="status-customer-select"><span className="field-label">Заказчик</span>
      <select className="field-input" value={config.key} onChange={(event) => { setOverride(null); setListKey(event.target.value) }}>
        {lists.map((item) => <option key={item.key} value={item.key}>{item.name}{item.auto === false ? ' · вручную' : ''}</option>)}
      </select>
    </label> : lists.length > 1 ? <div className="customer-tabs" role="tablist" aria-label="Заказчик">
      {lists.map((item) => <button key={item.key} type="button" role="tab" aria-selected={item.key === config.key} className={item.key === config.key ? 'customer-tab customer-tab-active' : 'customer-tab'}
        onClick={() => { setOverride(null); setListKey(item.key) }}>{item.name}{item.auto === false ? <>{' '}<span className="status-tab-note">вручную</span></> : null}</button>)}
    </div> : null}

    {perDispatcher && me && report ? <div className="fleet-scope status-scope" role="group" aria-label="Чьи машины показать">
      {([['MINE', 'Мои машины', mine.length], ['ALL', 'Все по диспетчерам', rows.length]] as const).map(([value, label, count]) =>
        <button key={value} type="button" aria-pressed={activeScope === value} className={activeScope === value ? 'fleet-scope-button fleet-scope-button-active' : 'fleet-scope-button'} onClick={() => chooseScope(value)}>
          {label}<span className="fleet-scope-count">{count}</span>
        </button>)}
    </div> : null}

    {report ? <p className="status-meta" role="status">
      <span>Сформирован {report.generatedAt ? BERLIN_STAMP.format(new Date(report.generatedAt)).replace(',', '') : '—'} · {report.generatedByRole === 'system' ? 'автоматически' : 'вручную'}</span>
      {report.preliminary ? <span className="status-chip status-chip-warn">Предварительно: данные Webfleet были неполные</span> : null}
      {report.status === 'FAILED' ? <span className="status-chip status-chip-error">Не удалось сформировать — нажмите «Сформировать заново»</span> : null}
      {!today ? <span className="status-chip">Прошлый день: только просмотр</span> : null}
    </p> : null}
    {activeScope === 'MINE' && nobodys.length ? <p className="status-banner" role="status">
      {trucks(nobodys.length)} {config.name} ни у кого: {nobodys.map((row) => row.vehicleNumber).join(', ')} — посмотрите в «Все по диспетчерам».
    </p> : null}
    {ungrouped ? <p className="status-banner" role="status">{ungrouped === 1 ? '1 машина' : `${ungrouped} машин`} без группы {config.groups.map((group) => group.name).join(' / ')} — укажите линию на странице <Link to="/vehicles">«Машины»</Link>.</p> : null}
    {actionError ? <ErrorState error={actionError} /> : null}

    {!report ? <div className="space-y-3">
      <EmptyState label={!today ? 'За этот день списка нет.' : auto ? `Список на сегодня ещё не сформирован: он появится в ${config.dueLocalTime} или по кнопке ниже.`
        : `Для ${config.name} статус формируется по кнопке. Автоматически в ${config.dueLocalTime} — включите в профиле заказчика.`} />
      {today ? <button type="button" className="primary-button" disabled={busy} onClick={() => void run(async () => { setOverride(await statusApi.generate({ list: config.key })); await refetch() })}>Сформировать сейчас</button> : null}
    </div> : !rows.length ? <EmptyState label={`Нет машин заказчика ${config.name}. Поставьте их на его линии на странице «Машины».`} />
      : activeScope === 'MINE' ? (mine.length ? blocks(mine, 'mine')
        : <EmptyState label={`У вас нет машин в статусе ${config.name}. Возьмите машину себе в её карточке или попросите администратора закрепить за вами линию.`} />)
      : !perDispatcher ? blocks(rows, 'all')
      : groupByOwner(rows, me).map((section) => {
        const title = section.owner ? `${section.owner.name}${section.owner.id === me ? ' (вы)' : ''}${section.owner.active ? '' : ' · отключён'}` : 'Ничьи'
        const id = `status-owner-${section.key || 'none'}`
        return <section key={section.key || 'none'} className="status-owner" aria-labelledby={id}>
          <div className="status-owner-head">
            <h3 id={id} className="status-owner-title">{title} <span className="status-count">{trucks(section.rows.length)}</span></h3>
            {everyone && report ? <button type="button" className="secondary-button compact-button" disabled={busy} aria-label={`Скачать Excel: ${section.owner?.name ?? 'ничьи машины'}`}
              onClick={() => void download(section.owner?.id ?? 'none')}><Download className="h-4 w-4" aria-hidden="true" />Excel</button> : null}
          </div>
          {section.owner ? null : <p className="status-owner-note">Их статус не попадёт ни в чей Excel. Возьмите машину себе или закрепите линию за диспетчером.</p>}
          {blocks(section.rows, section.key || 'none')}
        </section>
      })}
  </div>
}

function LineBlocks({ rows, config, prefix, skipEmpty, canEdit, onSaved, onTake, busy }: {
  rows: DailyStatusRow[]; config: DailyStatusListConfig; prefix: string; skipEmpty: boolean; canEdit: (row: DailyStatusRow) => boolean
  onSaved: (row: DailyStatusRow) => void; onTake?: (row: DailyStatusRow) => void; busy: boolean
}) {
  return <>{groupRows(rows, config.groups).filter((block) => !skipEmpty || block.rows.length).map((block) => {
    const id = `status-${prefix}-${block.group ?? 'none'}`
    return <section key={block.title} className="work-surface status-block" aria-labelledby={id}>
      <h4 id={id} className="status-block-title">{block.title} <span className="status-count">{block.rows.length}</span></h4>
      <div className="overflow-x-auto">
        <table className="status-table">
          {/* Same column widths in every block, so NORD, SÜD and LuFe line up like the Excel. */}
          <colgroup>{columnsOf(config).map((column, index) => <col key={index} style={column.width ? { width: column.width } : undefined} />)}</colgroup>
          <thead><tr>{columnsOf(config).map((column) => <th key={column.label} scope="col">{column.label}</th>)}</tr></thead>
          <tbody>
            {block.rows.map((row) => <StatusRow key={row.id} row={row} columns={config.columns} editable={canEdit(row)} onSaved={onSaved}
              onTake={onTake && !row.owner && row.vehicleId ? () => onTake(row) : undefined} busy={busy} />)}
          </tbody>
        </table>
      </div>
    </section>
  })}</>
}

/** Same column widths in every block, so the blocks line up like the Excel; optional columns follow the customer's profile. */
function columnsOf(config: DailyStatusListConfig) {
  return [
    { label: 'LKW', width: 72 }, { label: 'Ort', width: 140 }, { label: 'Start', width: 80 }, { label: 'Ziel', width: 140 }, { label: 'Ankunft', width: 104 },
    { label: 'Bemerkung', width: undefined }, { label: 'Trailer', width: 104 },
    ...(config.columns.we ? [{ label: config.columns.we, width: 132 }] : []),
    { label: 'Телефон', width: 140 },
    ...(config.columns.aSchild ? [{ label: 'A Schild', width: 72 }] : []),
    ...(config.columns.appSped ? [{ label: 'AppSped', width: 72 }] : [])
  ]
}

function StatusRow({ row, columns, editable, onSaved, onTake, busy: pageBusy }: {
  row: DailyStatusRow; columns: DailyStatusListConfig['columns']; editable: boolean; onSaved: (row: DailyStatusRow) => void; onTake?: () => void; busy: boolean
}) {
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
    <th scope="row" className="status-lkw">{row.vehicleNumber}
      {row.owner?.coverForName ? <span className="status-cover"> за {row.owner.coverForName}</span> : null}
      {onTake ? <button type="button" className="status-take" disabled={pageBusy} aria-label={`Взять себе LKW ${row.vehicleNumber}`} onClick={onTake}>
        <UserPlus className="h-3.5 w-3.5" aria-hidden="true" />Взять</button> : null}
    </th>
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
