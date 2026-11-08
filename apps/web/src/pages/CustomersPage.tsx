import { Building2, ChevronRight, Plus, Shuffle } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'

import { EmptyState, ErrorState, LoadingState } from '../components/States'
import { usePolling } from '../hooks/usePolling'
import { customersApi, type CustomerCategory, type CustomerMigrationItem } from '../lib/api'
import { currentDispatcherRole } from '../lib/auth'
import { CATEGORY_LABEL, customerColor, splitWords } from '../lib/customers'
import '../components/customers.css'

/** Customers the fleet drives for, with their lines and dispatchers; each opens its profile. */
export function CustomersPage() {
  const isAdmin = currentDispatcherRole() === 'admin'
  const { data, error, loading, refetch } = usePolling(customersApi.list, 0)
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState({ name: '', category: 'OEM_LOGISTICS' as CustomerCategory, aliases: '' })
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  async function create(event: FormEvent) {
    event.preventDefault()
    setBusy(true); setMessage(null)
    try {
      await customersApi.create({ name: form.name.trim(), category: form.category, aliases: splitWords(form.aliases || form.name) })
      setForm({ name: '', category: 'OEM_LOGISTICS', aliases: '' }); setCreating(false)
      setMessage({ tone: 'ok', text: 'Заказчик создан. Добавьте ему линии в профиле.' })
      await refetch()
    } catch (cause) { setMessage({ tone: 'error', text: cause instanceof Error ? cause.message : 'Не создан.' }) } finally { setBusy(false) }
  }

  if (loading && !data) return <LoadingState />
  if (error && !data) return <ErrorState error={error} onRetry={refetch} />
  const customers = data ?? []

  return <div className="space-y-5">
    <div className="page-header">
      <div className="min-w-0">
        <h2 className="page-title">Заказчики</h2>
        <p className="page-subtitle">У каждого заказчика свой Auftrag, свои линии и свой статус. Машины и диспетчеры привязаны к линиям.</p>
      </div>
      {isAdmin ? <button type="button" className="primary-button" onClick={() => setCreating((value) => !value)}><Plus className="h-4 w-4" aria-hidden="true" />Новый заказчик</button> : null}
    </div>

    {isAdmin ? <MigrationPanel onDone={() => void refetch()} /> : null}

    {creating ? <form className="work-surface customer-form" onSubmit={(event) => void create(event)} aria-label="Новый заказчик">
      <label><span className="field-label">Название</span><input className="field-input" value={form.name} required minLength={2} maxLength={80} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
      <label><span className="field-label">Категория</span>
        <select className="field-input" value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value as CustomerCategory })}>
          {(Object.keys(CATEGORY_LABEL) as CustomerCategory[]).map((category) => <option key={category} value={category}>{CATEGORY_LABEL[category]}</option>)}
        </select>
      </label>
      <label className="customer-form-wide"><span className="field-label">Как пишется в Auftrag (через запятую)</span>
        <input className="field-input" value={form.aliases} placeholder="Schnellecke, Schnellecke Transportlogistik GmbH" onChange={(event) => setForm({ ...form, aliases: event.target.value })} />
      </label>
      <div className="customer-form-actions">
        <button type="button" className="secondary-button" onClick={() => setCreating(false)}>Отмена</button>
        <button type="submit" className="primary-button" disabled={busy || form.name.trim().length < 2}>Создать</button>
      </div>
    </form> : null}
    {message ? <p className={message.tone === 'ok' ? 'customer-message' : 'customer-message customer-message-error'} role={message.tone === 'ok' ? 'status' : 'alert'}>{message.text}</p> : null}

    {customers.length ? <div className="customer-grid">
      {customers.map((customer) => <Link key={customer.id} to={`/customers/${customer.id}`} className={customer.active ? 'customer-card' : 'customer-card customer-card-archived'}>
        <span className="customer-card-head">
          <span className="customer-swatch" style={{ background: customerColor(customer) }} aria-hidden="true" />
          <strong>{customer.name}</strong>
          <span className="customer-category">{CATEGORY_LABEL[customer.category]}{customer.active ? '' : ' · в архиве'}</span>
          <ChevronRight className="customer-card-chevron" aria-hidden="true" />
        </span>
        <span className="customer-card-meta">
          {customer.profile.statusList.enabled ? <span>Статус в {customer.profile.statusList.dueLocalTime}</span> : null}
          <span>Машин: {customer.lines.reduce((total, line) => total + line.vehicleCount, 0)}</span>
        </span>
        {customer.lines.length ? <ul className="customer-lines" aria-label={`Линии ${customer.name}`}>
          {customer.lines.filter((line) => line.active).map((line) => <li key={line.id}>
            <span className="customer-line-name">{line.name}</span>
            <span className="customer-line-meta">{line.vehicleCount} маш.{line.dispatchers.length ? ` · ${line.dispatchers.map((item) => item.name).join(', ')}` : ' · без диспетчера'}</span>
          </li>)}
        </ul> : <span className="customer-line-meta">Линий пока нет</span>}
      </Link>)}
    </div> : <EmptyState label={isAdmin ? 'Заказчиков пока нет. Создайте их из линий машин или добавьте вручную.' : 'Заказчиков пока нет — их заводит администратор.'} />}
  </div>
}

/** Admin: Schnellecke and Walter from the trucks' old line fields, after seeing exactly what will be created. */
function MigrationPanel({ onDone }: { onDone: () => void }) {
  const [preview, setPreview] = useState<CustomerMigrationItem[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  async function open() {
    setBusy(true); setMessage('')
    try {
      const items = await customersApi.migrationPreview()
      if (!items.length) setMessage('Все машины уже на линиях заказчиков — переносить нечего.')
      setPreview(items.length ? items : null)
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : 'Предпросмотр не загрузился.') } finally { setBusy(false) }
  }
  async function apply() {
    setBusy(true); setMessage('')
    try {
      const result = await customersApi.migrate()
      setMessage(`Готово: ${result.map((item) => `${item.slug} — линий ${item.lines}, машин ${item.vehicles}`).join('; ')}.`)
      setPreview(null); onDone()
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : 'Не перенесено.') } finally { setBusy(false) }
  }

  return <section className="work-surface customer-migration" aria-label="Перенос из линий машин">
    <div className="customer-migration-head">
      <Shuffle className="h-5 w-5" aria-hidden="true" />
      <p>У машин уже указаны линии Schnellecke и Walter Tesla и группы NORD / SÜD / LuFe. Из них можно одним шагом создать заказчиков и линии.</p>
      {!preview ? <button type="button" className="secondary-button" disabled={busy} onClick={() => void open()}>Показать, что будет создано</button> : null}
    </div>
    {preview ? <div className="space-y-3">
      {preview.map((item) => <div key={item.slug} className="customer-migration-item">
        <strong><Building2 className="h-4 w-4" aria-hidden="true" />{item.name}{item.exists ? ' (уже есть)' : ''}</strong>
        {item.statusList ? <span className="customer-line-meta">Статус 07:00 продолжит формироваться как раньше.</span> : null}
        <ul>{item.lines.map((line) => <li key={line.code}>Линия {line.name}: {line.vehicles.join(', ')}</li>)}</ul>
      </div>)}
      <div className="customer-form-actions">
        <button type="button" className="secondary-button" disabled={busy} onClick={() => setPreview(null)}>Отмена</button>
        <button type="button" className="primary-button" disabled={busy} onClick={() => void apply()}>Создать заказчиков и линии</button>
      </div>
    </div> : null}
    {message ? <p className="customer-message" role="status">{message}</p> : null}
  </section>
}
