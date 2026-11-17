import { ArrowUpRight, Plus, RefreshCw, Search } from 'lucide-react'
import { Fragment, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { Link } from 'react-router-dom'

import { CustomerLineSelect } from '../components/CustomerLineCells'
import { EmptyState, ErrorState, LoadingState } from '../components/States'
import { SchnelleckePreset, VehicleStatusCells } from '../components/VehicleStatusSettings'
import { WebfleetConnectionPanel } from '../components/WebfleetConnectionPanel'
import { usePolling } from '../hooks/usePolling'
import { api, customersApi } from '../lib/api'
import { gpsState, groupVehicles, matchesVehicle, nowLines, type VehicleFilter } from '../lib/vehicle-board'
import type { DashboardVehicle, Vehicle } from '../types/domain'

type Editing = { id: string; vehicleNumber: string; licensePlate: string; maxSpeedKmh: number; busy: boolean; error: string }

/** The fleet by customer line: whether GPS comes in, what each truck does now, who runs it. Rare edits sit under the row. */
export function VehiclesPage() {
  const { data, error, loading, refetch } = usePolling(api.vehicles, 30_000)
  const board = usePolling(api.dashboard, 30_000)
  const customers = usePolling(customersApi.list, 0).data ?? []
  // With customers set up, a truck gets one customer line; before that, the old line and block fields stay.
  const byCustomer = customers.length > 0
  const [adding, setAdding] = useState(false)
  const [vehicleNumber, setVehicleNumber] = useState('')
  const [licensePlate, setLicensePlate] = useState('')
  const [maxSpeedKmh, setMaxSpeedKmh] = useState(85)
  const [createError, setCreateError] = useState<Error | null>(null)
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<Editing | null>(null)
  const [filter, setFilter] = useState<VehicleFilter>('all')
  const [query, setQuery] = useState('')
  const rows = useMemo(() => new Map((board.data?.vehicles ?? []).map((row) => [row.vehicle.id, row] as const)), [board.data?.vehicles])

  async function saveEdit(event: FormEvent) {
    event.preventDefault()
    if (!editing) return
    setEditing({ ...editing, busy: true, error: '' })
    try {
      await api.updateVehicle(editing.id, { vehicleNumber: editing.vehicleNumber.trim(), licensePlate: editing.licensePlate.trim(), maxSpeedKmh: editing.maxSpeedKmh })
      setEditing(null)
      await refetch()
    } catch (cause) { setEditing({ ...editing, busy: false, error: cause instanceof Error ? cause.message : 'Не удалось сохранить.' }) }
  }

  async function handleCreateVehicle(event: FormEvent) {
    event.preventDefault()
    setCreateError(null)
    setCreating(true)
    try {
      await api.createVehicle({ vehicleNumber: vehicleNumber.trim(), licensePlate: licensePlate.trim() || undefined, maxSpeedKmh })
      setVehicleNumber('')
      setLicensePlate('')
      setMaxSpeedKmh(85)
      setAdding(false)
      await refetch()
    } catch (err) {
      setCreateError(err as Error)
    } finally {
      setCreating(false)
    }
  }

  if (loading && !data) return <LoadingState />
  if (error && !data) return <ErrorState error={error} onRetry={refetch} />

  const vehicles = data ?? []
  const now = Date.now()
  const rowOf = (vehicle: Vehicle) => rows.get(vehicle.id)
  const countOf = (value: VehicleFilter) => vehicles.filter((vehicle) => matchesVehicle(vehicle, rowOf(vehicle), value, '', now)).length
  const live = vehicles.filter((vehicle) => gpsState(rowOf(vehicle), now).kind === 'live').length
  const filters: Array<{ id: VehicleFilter; label: string }> = [
    { id: 'all', label: 'Все' }, { id: 'no-gps', label: 'Без свежего GPS' }, ...(byCustomer ? [{ id: 'no-line' as const, label: 'Без линии' }] : []), { id: 'idle', label: 'Без тура' }
  ]
  const shown = vehicles.filter((vehicle) => matchesVehicle(vehicle, rowOf(vehicle), filter, query, now))
  const groups = groupVehicles(shown, customers)
  const startEdit = (vehicle: Vehicle) => setEditing(editing?.id === vehicle.id ? null : { id: vehicle.id, vehicleNumber: vehicle.vehicleNumber, licensePlate: vehicle.licensePlate ?? '', maxSpeedKmh: vehicle.maxSpeedKmh, busy: false, error: '' })

  return (
    <div className="fleet-page">
      <div className="page-header">
        <div className="min-w-0">
          <h2 className="page-title">Машины</h2>
          <p className="page-subtitle">{vehicles.length} машин · {live} на GPS Webfleet · {countOf('idle')} без тура</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="secondary-button" onClick={() => void Promise.all([refetch(), board.refetch()])}><RefreshCw className="h-4 w-4" aria-hidden="true" />Обновить</button>
          <button type="button" className="primary-button" aria-expanded={adding} aria-controls="new-vehicle" onClick={() => setAdding((value) => !value)}><Plus className="h-4 w-4" aria-hidden="true" />Добавить машину</button>
        </div>
      </div>

      <WebfleetConnectionPanel vehicles={vehicles} />
      {byCustomer ? null : <SchnelleckePreset onApplied={() => void refetch()} />}

      {adding ? <section id="new-vehicle" className="work-surface fleet-new" aria-labelledby="new-vehicle-title">
        <h3 id="new-vehicle-title" className="section-title">Новая машина</h3>
        <form className="fleet-new-form" onSubmit={handleCreateVehicle}>
          <label><span className="field-label">Номер машины</span><input className="field-input" value={vehicleNumber} onChange={(event) => setVehicleNumber(event.target.value)} required placeholder="125" /></label>
          <label><span className="field-label">Госномер</span><input className="field-input" value={licensePlate} onChange={(event) => setLicensePlate(event.target.value)} placeholder="GÖ-FX 125" /></label>
          <label><span className="field-label">Макс. скорость, км/ч</span><input className="field-input" type="number" min={1} max={85} value={maxSpeedKmh} onChange={(event) => setMaxSpeedKmh(Number(event.target.value))} required /></label>
          <div className="fleet-new-actions">
            <button className="primary-button" disabled={creating || !vehicleNumber.trim()}>{creating ? 'Добавляем…' : 'Добавить'}</button>
            <button type="button" className="secondary-button" onClick={() => setAdding(false)}>Отмена</button>
            <p className="fleet-hint">Расчёт маршрута не превышает максимальную скорость, по умолчанию 85 км/ч. Линию, телефон и отметки задайте в «Изменить».</p>
          </div>
        </form>
        {createError ? <ErrorState error={createError} /> : null}
      </section> : null}

      <div className="fleet-toolbar">
        <label className="fleet-search">
          <Search className="h-4 w-4" aria-hidden="true" />
          <input type="search" aria-label="Найти машину по номеру, госномеру или телефону" placeholder="Номер, госномер или телефон" value={query} maxLength={40} onChange={(event) => setQuery(event.target.value)} />
        </label>
        <div className="fleet-filters" role="group" aria-label="Показать">
          {filters.map((item) => <button key={item.id} type="button" className="fleet-filter" aria-pressed={filter === item.id} onClick={() => setFilter(item.id)}>{item.label}<span>{countOf(item.id)}</span></button>)}
        </div>
      </div>

      <section className="work-surface fleet-board" aria-label="Машины">
        {!vehicles.length ? <EmptyState label="Машин пока нет. Добавьте первую кнопкой «Добавить машину»." />
          : !shown.length ? <EmptyState label={query ? 'Ничего не нашли.' : 'В этом фильтре машин нет.'} /> : (
          <table className="fleet-table">
            <thead>
              <tr><th scope="col">Машина</th><th scope="col">GPS Webfleet</th><th scope="col">Сейчас</th><th scope="col">Ведёт</th><th scope="col">Отметки</th><th scope="col"><span className="sr-only">Действия</span></th></tr>
            </thead>
            {groups.map((group) => (
              <tbody key={group.id}>
                <tr className="fleet-group"><th scope="rowgroup" colSpan={6}><span>{group.name}</span>{group.meta}</th></tr>
                {group.vehicles.map((vehicle) => <VehicleRow key={vehicle.id} vehicle={vehicle} row={rowOf(vehicle)} now={now} editing={editing?.id === vehicle.id ? editing : null}
                  onEdit={() => startEdit(vehicle)} onChange={setEditing} onSubmit={saveEdit} extra={<>
                    {byCustomer ? <CustomerLineSelect vehicle={vehicle} customers={customers} onSaved={() => void refetch()} fields /> : null}
                    <VehicleStatusCells vehicle={vehicle} onSaved={() => void refetch()} withLine={!byCustomer} fields />
                  </>} />)}
              </tbody>
            ))}
          </table>
        )}
      </section>
      {error ? <ErrorState error={error} onRetry={refetch} /> : null}
    </div>
  )
}

function VehicleRow({ vehicle, row, now, editing, onEdit, onChange, onSubmit, extra }: {
  vehicle: Vehicle; row: DashboardVehicle | undefined; now: number; editing: Editing | null
  onEdit: () => void; onChange: (value: Editing | null) => void; onSubmit: (event: FormEvent) => void; extra: ReactNode
}) {
  const gps = gpsState(row, now)
  const work = nowLines(row, now)
  const who = row?.assignedTo?.name ?? null
  const marks = [vehicle.aSchild ? 'A Schild' : null, vehicle.appSped ? 'AppSped' : null].filter((item): item is string => Boolean(item))
  return <Fragment>
    <tr className={editing ? 'fleet-row fleet-row-open' : 'fleet-row'}>
      <td><span className="fleet-number">{vehicle.vehicleNumber}</span><span className="fleet-plate">{vehicle.licensePlate || 'без госномера'}</span></td>
      <td><span className={`fleet-gps fleet-gps-${gps.kind}`}><span className="fleet-dot" aria-hidden="true" />{gps.text}</span></td>
      <td><span className="fleet-now">{work.title}</span>{work.sub ? <span className={`fleet-now-sub${work.tone === 'late' ? ' fleet-late' : ''}`}>{work.sub}</span> : null}</td>
      <td className={who ? undefined : 'fleet-muted'}>{who ?? 'свободна'}</td>
      <td><span className="fleet-marks">{marks.map((mark) => <span key={mark} className="fleet-mark">{mark}</span>)}<span className="fleet-speed">{vehicle.maxSpeedKmh} км/ч</span></span></td>
      <td>
        <span className="fleet-actions">
          <button type="button" className="secondary-button" aria-expanded={Boolean(editing)} onClick={onEdit} aria-label={`Изменить машину ${vehicle.vehicleNumber}`}>Изменить</button>
          <Link className="secondary-button" to={`/vehicles/${vehicle.id}`} aria-label={`Открыть машину ${vehicle.vehicleNumber}`}>Открыть<ArrowUpRight className="h-4 w-4" aria-hidden="true" /></Link>
        </span>
      </td>
    </tr>
    {editing ? <tr className="fleet-edit-row">
      <td colSpan={6}>
        <form className="fleet-edit" onSubmit={onSubmit} aria-label={`Изменить машину ${vehicle.vehicleNumber}`}>
          <label className="vehicle-field"><span className="field-label">Номер</span><input className="field-input" value={editing.vehicleNumber} required onChange={(event) => onChange({ ...editing, vehicleNumber: event.target.value })} /></label>
          <label className="vehicle-field"><span className="field-label">Госномер</span><input className="field-input" value={editing.licensePlate} onChange={(event) => onChange({ ...editing, licensePlate: event.target.value })} /></label>
          <label className="vehicle-field"><span className="field-label">Макс. скорость</span><input className="field-input" type="number" min={1} max={85} value={editing.maxSpeedKmh} required onChange={(event) => onChange({ ...editing, maxSpeedKmh: Number(event.target.value) })} /></label>
          <div className="fleet-edit-actions">
            <button type="submit" className="primary-button" disabled={editing.busy || !editing.vehicleNumber.trim()}>{editing.busy ? 'Сохраняем…' : 'Сохранить'}</button>
            <button type="button" className="secondary-button" onClick={() => onChange(null)} disabled={editing.busy}>Закрыть</button>
          </div>
          {editing.error ? <p className="quick-order-error" role="alert">{editing.error}</p> : null}
        </form>
        <div className="fleet-edit-live">{extra}</div>
        <p className="fleet-hint">Номер, госномер и скорость сохраняются кнопкой. Линия, телефон и отметки — сразу; линия решает, кому из диспетчеров приходят уведомления по этой машине.</p>
      </td>
    </tr> : null}
  </Fragment>
}
