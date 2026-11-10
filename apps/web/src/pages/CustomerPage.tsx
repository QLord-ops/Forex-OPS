import { ArrowLeft, Archive, FileText, Plus } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router-dom'

import { ErrorState, LoadingState } from '../components/States'
import { usePolling } from '../hooks/usePolling'
import { customersApi, documentFileUrl, type Customer, type CustomerCategory, type CustomerOverview, type CustomerProfile } from '../lib/api'
import { currentDispatcher, currentDispatcherRole } from '../lib/auth'
import { CATEGORY_LABEL, CORRECTED_FIELD_LABEL, customerColor, joinWords, ROUTE_SOURCE_LABEL, splitWords } from '../lib/customers'
import { formatDateTime } from '../lib/format'
import '../components/customers.css'

type Tab = 'overview' | 'lines' | 'auftrag' | 'status' | 'documents'
const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'overview', label: 'Обзор' }, { id: 'lines', label: 'Линии и диспетчеры' }, { id: 'auftrag', label: 'Auftrag' },
  { id: 'status', label: 'Статус' }, { id: 'documents', label: 'Документы' }
]
type Detail = Customer & { overview: CustomerOverview }

/** One customer: what the program has gathered about it, its lines and dispatchers, how its Auftrag and status list work. */
export function CustomerPage() {
  const { id = '' } = useParams()
  const { data, error, loading, refetch } = usePolling(() => customersApi.get(id), 0, Boolean(id), id)
  const [tab, setTab] = useState<Tab>('overview')
  const isAdmin = currentDispatcherRole() === 'admin'
  const me = currentDispatcher()

  if (loading && !data) return <LoadingState />
  if (error && !data) return <ErrorState error={error} onRetry={refetch} />
  if (!data) return null
  const canEditProfile = isAdmin || Boolean(me && data.lines.some((line) => line.dispatchers.some((item) => item.id === me.id)))

  return <div className="space-y-4">
    <Link to="/customers" className="customer-back"><ArrowLeft className="h-4 w-4" aria-hidden="true" />Все заказчики</Link>
    <Header customer={data} isAdmin={isAdmin} onSaved={() => void refetch()} />
    <div className="customer-tabs" role="tablist" aria-label="Разделы заказчика">
      {TABS.map((item) => <button key={item.id} type="button" role="tab" id={`customer-tab-${item.id}`} aria-selected={tab === item.id} aria-controls="customer-panel"
        className={tab === item.id ? 'customer-tab customer-tab-active' : 'customer-tab'} onClick={() => setTab(item.id)}>{item.label}</button>)}
    </div>
    <div id="customer-panel" role="tabpanel" aria-labelledby={`customer-tab-${tab}`}>
      {tab === 'overview' ? <Overview customer={data} /> : null}
      {tab === 'lines' ? <Lines customer={data} isAdmin={isAdmin} onSaved={() => void refetch()} /> : null}
      {tab === 'auftrag' ? <AuftragProfile customer={data} editable={canEditProfile} onSaved={() => void refetch()} /> : null}
      {tab === 'status' ? <StatusProfile customer={data} editable={canEditProfile} onSaved={() => void refetch()} /> : null}
      {tab === 'documents' ? <Documents overview={data.overview} /> : null}
    </div>
  </div>
}

function useSave(onSaved: () => void) {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  async function save(work: () => Promise<unknown>, done = 'Сохранено.') {
    setBusy(true); setMessage(null)
    try { await work(); setMessage({ tone: 'ok', text: done }); onSaved() }
    catch (cause) { setMessage({ tone: 'error', text: cause instanceof Error ? cause.message : 'Не сохранено.' }) }
    finally { setBusy(false) }
  }
  const note = message ? <p className={message.tone === 'ok' ? 'customer-message' : 'customer-message customer-message-error'} role={message.tone === 'ok' ? 'status' : 'alert'}>{message.text}</p> : null
  return { busy, save, note }
}

function Header({ customer, isAdmin, onSaved }: { customer: Detail; isAdmin: boolean; onSaved: () => void }) {
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState({ name: customer.name, category: customer.category, aliases: joinWords(customer.aliases), color: customerColor(customer) })
  const { busy, save, note } = useSave(() => { setEditing(false); onSaved() })
  useEffect(() => { setForm({ name: customer.name, category: customer.category, aliases: joinWords(customer.aliases), color: customerColor(customer) }) }, [customer])

  return <div className="page-header">
    <div className="min-w-0">
      <h2 className="page-title customer-title"><span className="customer-swatch" style={{ background: customerColor(customer) }} aria-hidden="true" />{customer.name}</h2>
      <p className="page-subtitle">{CATEGORY_LABEL[customer.category]}{customer.active ? '' : ' · в архиве'} · в Auftrag: {customer.aliases.join(', ') || '—'}</p>
      {editing ? <form className="work-surface customer-form" aria-label="Данные заказчика" onSubmit={(event: FormEvent) => { event.preventDefault(); void save(() => customersApi.update(customer.id, { name: form.name.trim(), category: form.category, aliases: splitWords(form.aliases), color: form.color })) }}>
        <label><span className="field-label">Название</span><input className="field-input" value={form.name} minLength={2} maxLength={80} required onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
        <label><span className="field-label">Категория</span>
          <select className="field-input" value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value as CustomerCategory })}>
            {(Object.keys(CATEGORY_LABEL) as CustomerCategory[]).map((category) => <option key={category} value={category}>{CATEGORY_LABEL[category]}</option>)}
          </select>
        </label>
        <label><span className="field-label">Цвет</span><input className="field-input customer-color-input" type="color" value={form.color} onChange={(event) => setForm({ ...form, color: event.target.value })} /></label>
        <label className="customer-form-wide"><span className="field-label">Как пишется в Auftrag (через запятую)</span><input className="field-input" value={form.aliases} onChange={(event) => setForm({ ...form, aliases: event.target.value })} /></label>
        <div className="customer-form-actions">
          <button type="button" className="secondary-button" onClick={() => setEditing(false)}>Отмена</button>
          <button type="submit" className="primary-button" disabled={busy}>Сохранить</button>
        </div>
      </form> : null}
      {note}
    </div>
    {isAdmin && !editing ? <div className="customer-header-actions">
      <button type="button" className="secondary-button" onClick={() => setEditing(true)}>Изменить</button>
      <button type="button" className="secondary-button" disabled={busy} onClick={() => {
        if (customer.active && !window.confirm(`Отправить ${customer.name} в архив? История туров и Auftrag сохранится.`)) return
        void save(() => customersApi.update(customer.id, { active: !customer.active }), customer.active ? 'Заказчик в архиве.' : 'Заказчик снова активен.')
      }}><Archive className="h-4 w-4" aria-hidden="true" />{customer.active ? 'В архив' : 'Вернуть из архива'}</button>
    </div> : null}
  </div>
}

function Overview({ customer }: { customer: Detail }) {
  const { overview } = customer
  const share = overview.documents ? Math.round(overview.documentsWithoutCorrections / overview.documents * 100) : null
  const tiles = [
    { label: 'Машин на линиях', value: String(overview.vehicles) },
    { label: 'Туры сейчас', value: String(overview.activeTours) },
    { label: 'Туров за 30 дней', value: String(overview.tours30d) },
    { label: 'Auftrag сохранено', value: String(overview.documents) },
    { label: 'Разобрано без правок', value: share === null ? '—' : `${share} %` },
    { label: 'Выученных правил', value: String(overview.learnedRules) }
  ]
  return <div className="space-y-4">
    <dl className="customer-stats">
      {tiles.map((tile) => <div key={tile.label} className="customer-stat"><dt>{tile.label}</dt><dd>{tile.value}</dd></div>)}
    </dl>
    <section className="work-surface customer-section" aria-labelledby="customer-corrected">
      <h3 id="customer-corrected" className="section-title">Что чаще всего правят в разборе</h3>
      {overview.mostCorrected.length ? <ul className="customer-bars">
        {overview.mostCorrected.map((item) => <li key={item.field}>
          <span>{CORRECTED_FIELD_LABEL[item.field] ?? item.field}</span>
          <span className="customer-bar" aria-hidden="true"><span style={{ width: `${Math.max(6, item.count / overview.mostCorrected[0].count * 100)}%` }} /></span>
          <span className="tabular-nums">{item.count}</span>
        </li>)}
      </ul> : <p className="page-subtitle">Правок ещё нет: статистика появится после первых подтверждённых Auftrag этого заказчика.</p>}
    </section>
    <Accuracy accuracy={overview.accuracy} />
  </div>
}

const ACCURACY_ROWS = [
  { level: 'OK', label: 'Без пометки' },
  { level: 'CHECK', label: 'Жёлтые «проверьте»' },
  { level: 'DOUBT', label: 'Красные «под сомнением»' }
] as const

/** How often the dispatchers changed fields of each level before saving: the levels can be tuned by facts. */
function Accuracy({ accuracy }: { accuracy: Detail['overview']['accuracy'] }) {
  return <section className="work-surface customer-section" aria-labelledby="customer-accuracy">
    <h3 id="customer-accuracy" className="section-title">Точность разбора по уровням</h3>
    {accuracy ? <>
      <p className="page-subtitle">Последние 30 сохранённых Auftrag: сколько полей каждого уровня диспетчеры исправили перед сохранением.</p>
      <table className="customer-table">
        <thead><tr><th>Уровень поля</th><th>Полей</th><th>Исправили</th></tr></thead>
        <tbody>{ACCURACY_ROWS.map((row) => {
          const item = accuracy[row.level]
          return <tr key={row.level}>
            <th scope="row">{row.label}</th>
            <td className="tabular-nums">{item.fields}</td>
            <td className="tabular-nums">{item.fields ? `${Math.round(item.changed / item.fields * 100)} % (${item.changed})` : '—'}</td>
          </tr>
        })}</tbody>
      </table>
    </> : <p className="page-subtitle">Появится после первого сохранённого Auftrag, разобранного с оценкой полей.</p>}
  </section>
}

function Lines({ customer, isAdmin, onSaved }: { customer: Detail; isAdmin: boolean; onSaved: () => void }) {
  const [form, setForm] = useState({ code: '', name: '', departmentCompany: '', departmentAddress: '', departmentCity: '' })
  const { busy, save, note } = useSave(onSaved)
  return <div className="space-y-4">
    <section className="work-surface customer-section">
      {customer.lines.length ? <div className="overflow-x-auto"><table className="customer-table">
        <thead><tr><th>Линия</th><th>Машин</th><th>Диспетчеры</th><th>Склад Abteilung</th>{isAdmin ? <th><span className="sr-only">Действия</span></th> : null}</tr></thead>
        <tbody>{customer.lines.map((line) => <tr key={line.id} className={line.active ? undefined : 'customer-row-archived'}>
          <th scope="row">{line.name}<span className="customer-line-meta">{line.code}{line.active ? '' : ' · в архиве'}</span></th>
          <td className="tabular-nums">{line.vehicleCount}</td>
          <td>{line.dispatchers.length ? line.dispatchers.map((item) => `${item.name}${item.primary ? ' (основная)' : ''}`).join(', ') : <span className="customer-line-meta">назначьте на странице «Диспетчеры»</span>}</td>
          <td>{[line.departmentCompany, line.departmentAddress, line.departmentCity].filter(Boolean).join(', ') || '—'}</td>
          {isAdmin ? <td><button type="button" className="secondary-button compact-button" disabled={busy} onClick={() => {
            if (line.active && !window.confirm(`Отправить линию ${line.name} в архив? Машины с неё снимутся, история туров сохранится.`)) return
            void save(() => customersApi.updateLine(line.id, { active: !line.active }), line.active ? 'Линия в архиве.' : 'Линия снова активна.')
          }}>{line.active ? 'В архив' : 'Вернуть'}</button></td> : null}
        </tr>)}</tbody>
      </table></div> : <p className="page-subtitle">Линий пока нет.</p>}
    </section>
    {isAdmin ? <form className="work-surface customer-form" aria-label="Новая линия" onSubmit={(event: FormEvent) => {
      event.preventDefault()
      void save(async () => {
        await customersApi.addLine(customer.id, { code: form.code.trim() || form.name.trim(), name: form.name.trim(), departmentCompany: form.departmentCompany.trim() || null, departmentAddress: form.departmentAddress.trim() || null, departmentCity: form.departmentCity.trim() || null })
        setForm({ code: '', name: '', departmentCompany: '', departmentAddress: '', departmentCity: '' })
      }, 'Линия добавлена. Машины ставятся на линию на странице «Машины».')
    }}>
      <h3 className="section-title customer-form-wide">Новая линия</h3>
      <label><span className="field-label">Название</span><input className="field-input" value={form.name} required maxLength={80} placeholder="Nord" onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
      <label><span className="field-label">Код (необязательно)</span><input className="field-input" value={form.code} maxLength={40} placeholder="NORD" onChange={(event) => setForm({ ...form, code: event.target.value })} /></label>
      <label><span className="field-label">Склад Abteilung: фирма</span><input className="field-input" value={form.departmentCompany} maxLength={200} onChange={(event) => setForm({ ...form, departmentCompany: event.target.value })} /></label>
      <label><span className="field-label">Адрес</span><input className="field-input" value={form.departmentAddress} maxLength={300} onChange={(event) => setForm({ ...form, departmentAddress: event.target.value })} /></label>
      <label><span className="field-label">Город</span><input className="field-input" value={form.departmentCity} maxLength={120} onChange={(event) => setForm({ ...form, departmentCity: event.target.value })} /></label>
      <div className="customer-form-actions"><button type="submit" className="primary-button" disabled={busy || !form.name.trim()}><Plus className="h-4 w-4" aria-hidden="true" />Добавить линию</button></div>
    </form> : null}
    {note}
  </div>
}

function AuftragProfile({ customer, editable, onSaved }: { customer: Detail; editable: boolean; onSaved: () => void }) {
  const initial = (profile: CustomerProfile) => ({
    routeSource: profile.import.routeSource, warehouseWords: joinWords(profile.import.warehouseWords), carrierNames: joinWords(profile.import.carrierNames),
    zuladungWords: joinWords(profile.import.zuladungWords), dateOnly: profile.import.dateOnlyMeansPlannedStart, aiNotes: profile.import.aiNotes,
    serviceMin: profile.defaults.serviceMinMinutes, serviceMax: profile.defaults.serviceMaxMinutes, radius: profile.defaults.arrivalRadiusMeters
  })
  const [form, setForm] = useState(() => initial(customer.profile))
  const { busy, save, note } = useSave(onSaved)
  useEffect(() => { setForm(initial(customer.profile)) }, [customer.profile])

  return <form className="work-surface customer-form" aria-label="Как читать Auftrag" onSubmit={(event: FormEvent) => {
    event.preventDefault()
    void save(() => customersApi.update(customer.id, { profile: {
      import: { routeSource: form.routeSource, warehouseWords: splitWords(form.warehouseWords), carrierNames: splitWords(form.carrierNames), zuladungWords: splitWords(form.zuladungWords), dateOnlyMeansPlannedStart: form.dateOnly, aiNotes: form.aiNotes },
      defaults: { serviceMinMinutes: form.serviceMin, serviceMaxMinutes: form.serviceMax, arrivalRadiusMeters: form.radius }
    } }), 'Профиль сохранён. Следующие Auftrag этого заказчика разбираются с ним.')
  }}>
    <p className="page-subtitle customer-form-wide">Как этот заказчик пишет Auftrag. ИИ получает эти правила, когда разбирает его документы; правки диспетчеров добавляют к ним выученные правила.</p>
    <fieldset className="customer-fieldset" disabled={!editable}>
      <label><span className="field-label">Где маршрут</span>
        <select className="field-input" value={form.routeSource} onChange={(event) => setForm({ ...form, routeSource: event.target.value as CustomerProfile['import']['routeSource'] })}>
          {(Object.keys(ROUTE_SOURCE_LABEL) as Array<CustomerProfile['import']['routeSource']>).map((source) => <option key={source} value={source}>{ROUTE_SOURCE_LABEL[source]}</option>)}
        </select>
      </label>
      <label><span className="field-label">Слова склада Abteilung</span><input className="field-input" value={form.warehouseWords} placeholder="Lager, vorladen, divers" onChange={(event) => setForm({ ...form, warehouseWords: event.target.value })} /></label>
      <label><span className="field-label">Перевозчик в шапке (не точка)</span><input className="field-input" value={form.carrierNames} placeholder="Schnellecke Transportlogistik" onChange={(event) => setForm({ ...form, carrierNames: event.target.value })} /></label>
      <label><span className="field-label">Слова Zuladung</span><input className="field-input" value={form.zuladungWords} placeholder="Zuladung" onChange={(event) => setForm({ ...form, zuladungWords: event.target.value })} /></label>
      <label className="customer-check"><input type="checkbox" checked={form.dateOnly} onChange={(event) => setForm({ ...form, dateOnly: event.target.checked })} />Дата без времени — это план на 06:00, а не Termin</label>
      <label className="customer-form-wide"><span className="field-label">Заметки для ИИ</span>
        <textarea className="field-input" rows={4} maxLength={2000} value={form.aiNotes} placeholder="Например: Abteilung в шапке — всегда склад Ludwigsfelde; номер в скобках после города — номер ворот." onChange={(event) => setForm({ ...form, aiNotes: event.target.value })} />
      </label>
      <label><span className="field-label">Стоянка на точке, мин (от)</span><input className="field-input" type="number" min={5} max={600} value={form.serviceMin} onChange={(event) => setForm({ ...form, serviceMin: Number(event.target.value) })} /></label>
      <label><span className="field-label">Стоянка, мин (до)</span><input className="field-input" type="number" min={5} max={900} value={form.serviceMax} onChange={(event) => setForm({ ...form, serviceMax: Number(event.target.value) })} /></label>
      <label><span className="field-label">Зона прибытия, м</span><input className="field-input" type="number" min={100} max={5000} step={50} value={form.radius} onChange={(event) => setForm({ ...form, radius: Number(event.target.value) })} /></label>
    </fieldset>
    {editable ? <div className="customer-form-actions"><button type="submit" className="primary-button" disabled={busy}>Сохранить профиль</button></div>
      : <p className="customer-line-meta customer-form-wide">Профиль правят администратор и диспетчеры линий этого заказчика.</p>}
    {note}
  </form>
}

function StatusProfile({ customer, editable, onSaved }: { customer: Detail; editable: boolean; onSaved: () => void }) {
  const initial = (profile: CustomerProfile) => ({ ...profile.statusList, excluded: joinWords(profile.statusList.excludedVehicles), we: profile.statusList.weColumnLabel ?? '' })
  const [form, setForm] = useState(() => initial(customer.profile))
  const { busy, save, note } = useSave(onSaved)
  useEffect(() => { setForm(initial(customer.profile)) }, [customer.profile])

  return <form className="work-surface customer-form" aria-label="Статус для заказчика" onSubmit={(event: FormEvent) => {
    event.preventDefault()
    void save(() => customersApi.update(customer.id, { profile: { statusList: {
      enabled: form.enabled, dueLocalTime: form.dueLocalTime, excludedVehicles: form.excluded.split(/[,;\s]+/).map((item) => item.trim()).filter(Boolean),
      weColumnLabel: form.we.trim() || null, showASchild: form.showASchild, showAppSped: form.showAppSped
    } } }), 'Настройки статуса сохранены.')
  }}>
    <p className="page-subtitle customer-form-wide">Ежедневный список для заказчика: блоки — его линии. Список видно на странице «Статус»: каждый диспетчер скачивает там Excel со своими машинами. Без галочки статус формируется вручную, кнопкой на той же странице.</p>
    <fieldset className="customer-fieldset" disabled={!editable}>
      <label className="customer-check customer-form-wide"><input type="checkbox" checked={form.enabled} onChange={(event) => setForm({ ...form, enabled: event.target.checked })} />Формировать статус автоматически каждый день</label>
      <label><span className="field-label">Время (Берлин)</span><input className="field-input" type="time" value={form.dueLocalTime} onChange={(event) => setForm({ ...form, dueLocalTime: event.target.value })} /></label>
      <label><span className="field-label">Машины не в списке</span><input className="field-input" value={form.excluded} placeholder="727, 2853" onChange={(event) => setForm({ ...form, excluded: event.target.value })} /></label>
      <label><span className="field-label">Свободная колонка (пусто — без неё)</span><input className="field-input" value={form.we} maxLength={40} placeholder="WE in Northeim" onChange={(event) => setForm({ ...form, we: event.target.value })} /></label>
      <label className="customer-check"><input type="checkbox" checked={form.showASchild} onChange={(event) => setForm({ ...form, showASchild: event.target.checked })} />Колонка A Schild</label>
      <label className="customer-check"><input type="checkbox" checked={form.showAppSped} onChange={(event) => setForm({ ...form, showAppSped: event.target.checked })} />Колонка AppSped</label>
    </fieldset>
    {editable ? <div className="customer-form-actions"><button type="submit" className="primary-button" disabled={busy}>Сохранить</button></div> : null}
    {note}
  </form>
}

function Documents({ overview }: { overview: CustomerOverview }) {
  return <section className="work-surface customer-section" aria-labelledby="customer-documents">
    <h3 id="customer-documents" className="section-title">Последние Auftrag</h3>
    {overview.recentDocuments.length ? <ul className="customer-documents">
      {overview.recentDocuments.map((document) => <li key={document.id}>
        <FileText className="h-4 w-4" aria-hidden="true" />
        <a href={documentFileUrl(document.id)} target="_blank" rel="noreferrer">{document.filename}</a>
        <span className="customer-line-meta">{formatDateTime(document.createdAt)} · {document.status === 'ATTACHED' ? 'в туре' : 'не сохранён в тур'}</span>
      </li>)}
    </ul> : <p className="page-subtitle">Auftrag этого заказчика появятся здесь после разбора.</p>}
  </section>
}
