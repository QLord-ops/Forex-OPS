import { ArrowUpRight, Pencil, RefreshCw } from 'lucide-react'
import type { FormEvent } from 'react'
import { useState } from 'react'
import { Link } from 'react-router-dom'

import { DataTable } from '../components/DataTable'
import { WebfleetConnectionPanel } from '../components/WebfleetConnectionPanel'
import { SchnelleckePreset, VehicleStatusCells } from '../components/VehicleStatusSettings'
import { CustomerLineSelect } from '../components/CustomerLineCells'
import { EmptyState, ErrorState, LoadingState } from '../components/States'
import { usePolling } from '../hooks/usePolling'
import { api, customersApi } from '../lib/api'

export function VehiclesPage() {
  const { data, error, loading, refetch } = usePolling(api.vehicles, 30_000)
  const customersQuery = usePolling(customersApi.list, 0)
  const customers = customersQuery.data ?? []
  // With customers set up, a truck gets one customer line; before that, the old line and block fields stay.
  const byCustomer = customers.length > 0
  const [vehicleNumber, setVehicleNumber] = useState('')
  const [licensePlate, setLicensePlate] = useState('')
  const [maxSpeedKmh, setMaxSpeedKmh] = useState(85)
  const [createError, setCreateError] = useState<Error | null>(null)
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<{ id: string; vehicleNumber: string; licensePlate: string; maxSpeedKmh: number; busy: boolean; error: string } | null>(null)

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
      await api.createVehicle({
        vehicleNumber: vehicleNumber.trim(),
        licensePlate: licensePlate.trim() || undefined,
        maxSpeedKmh
      })
      setVehicleNumber('')
      setLicensePlate('')
      setMaxSpeedKmh(85)
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

  return (
    <div className="space-y-5">
      <div className="page-header">
        <div className="min-w-0">
          <h2 className="page-title">Грузовики</h2>
          <p className="page-subtitle">Основные данные и текущее состояние каждого грузовика</p>
        </div>
        <button className="secondary-button" onClick={refetch}>
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          Обновить
        </button>
      </div>

      <WebfleetConnectionPanel vehicles={vehicles} />
      {byCustomer ? null : <SchnelleckePreset onApplied={() => void refetch()} />}

      <form className="work-surface p-4" onSubmit={handleCreateVehicle}>
        <div className="grid items-end gap-3 md:grid-cols-[180px_220px_160px_auto]">
          <label>
            <span className="field-label">Номер грузовика</span>
            <input className="field-input" value={vehicleNumber} onChange={(event) => setVehicleNumber(event.target.value)} required />
          </label>
          <label>
            <span className="field-label">Госномер</span>
            <input className="field-input" value={licensePlate} onChange={(event) => setLicensePlate(event.target.value)} />
          </label>
          <label>
            <span className="field-label">Макс. скорость, км/ч</span>
            <input
              className="field-input"
              type="number"
              min={1}
              max={85}
              value={maxSpeedKmh}
              onChange={(event) => setMaxSpeedKmh(Number(event.target.value))}
              required
            />
          </label>
          <button className="primary-button" disabled={creating || !vehicleNumber.trim()}>
            Добавить грузовик
          </button>
        </div>
        <p className="mt-2 text-sm text-slate-500">Значение по умолчанию — 85 км/ч; расчёт маршрута не превышает этот предел.</p>
      </form>
      {createError ? <ErrorState error={createError} /> : null}

      {vehicles.length ? (
        <DataTable columns={byCustomer ? ['Грузовик', 'Госномер', 'Макс. скорость', 'Заказчик · линия', 'Телефон машины', 'A Schild', 'AppSped', ''] : ['Грузовик', 'Госномер', 'Макс. скорость', 'Линия', 'Группа', 'Телефон машины', 'A Schild', 'AppSped', '']}>
          {vehicles.map((vehicle) => (
            <tr key={vehicle.id} className="hover:bg-slate-50">
              {editing?.id === vehicle.id ? <td className="px-3 py-3" colSpan={3}>
                <form className="vehicle-edit" onSubmit={(event) => void saveEdit(event)} aria-label={`Изменить грузовик ${vehicle.vehicleNumber}`}>
                  <label><span className="field-label">Номер</span><input className="field-input" value={editing.vehicleNumber} required onChange={(event) => setEditing({ ...editing, vehicleNumber: event.target.value })} /></label>
                  <label><span className="field-label">Госномер</span><input className="field-input" value={editing.licensePlate} onChange={(event) => setEditing({ ...editing, licensePlate: event.target.value })} /></label>
                  <label><span className="field-label">Макс. скорость</span><input className="field-input" type="number" min={1} max={85} value={editing.maxSpeedKmh} required onChange={(event) => setEditing({ ...editing, maxSpeedKmh: Number(event.target.value) })} /></label>
                  <button type="submit" className="primary-button compact-button" disabled={editing.busy || !editing.vehicleNumber.trim()}>Сохранить</button>
                  <button type="button" className="secondary-button compact-button" onClick={() => setEditing(null)} disabled={editing.busy}>Отмена</button>
                  {editing.error ? <p className="quick-order-error" role="alert">{editing.error}</p> : null}
                </form>
              </td> : <>
                <td className="px-3 py-3 text-lg font-bold tabular-nums">{vehicle.vehicleNumber}</td>
                <td className="px-3 py-3 text-sm">{vehicle.licensePlate || '–'}</td>
                <td className="px-3 py-3 text-sm tabular-nums">{vehicle.maxSpeedKmh} км/ч</td>
              </>}
              {byCustomer ? <CustomerLineSelect vehicle={vehicle} customers={customers} onSaved={() => void refetch()} /> : null}
              <VehicleStatusCells vehicle={vehicle} onSaved={() => void refetch()} withLine={!byCustomer} />
              <td className="px-3 py-3 text-right">
                <span className="inline-flex gap-1">
                  <button type="button" className="secondary-button min-h-9 px-2" onClick={() => setEditing({ id: vehicle.id, vehicleNumber: vehicle.vehicleNumber, licensePlate: vehicle.licensePlate ?? '', maxSpeedKmh: vehicle.maxSpeedKmh, busy: false, error: '' })} aria-label={`Изменить грузовик ${vehicle.vehicleNumber}`}>
                    <Pencil className="h-4 w-4" aria-hidden="true" />
                  </button>
                  <Link className="secondary-button min-h-9 px-2" to={`/vehicles/${vehicle.id}`} aria-label={`Открыть грузовик ${vehicle.vehicleNumber}`}>
                    <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
                  </Link>
                </span>
              </td>
            </tr>
          ))}
        </DataTable>
      ) : (
        <EmptyState label="Грузовики не найдены. Добавьте первый грузовик с помощью формы выше." />
      )}
      {error ? <ErrorState error={error} onRetry={refetch} /> : null}
    </div>
  )
}
