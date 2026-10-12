import { ArrowUpRight, RefreshCw } from 'lucide-react'
import type { FormEvent } from 'react'
import { useState } from 'react'
import { Link } from 'react-router-dom'

import { DataTable } from '../components/DataTable'
import { EmptyState, ErrorState, LoadingState } from '../components/States'
import { usePolling } from '../hooks/usePolling'
import { api } from '../lib/api'

export function VehiclesPage() {
  const { data, error, loading, refetch } = usePolling(api.vehicles, 30_000)
  const [vehicleNumber, setVehicleNumber] = useState('')
  const [licensePlate, setLicensePlate] = useState('')
  const [maxSpeedKmh, setMaxSpeedKmh] = useState(85)
  const [createError, setCreateError] = useState<Error | null>(null)
  const [creating, setCreating] = useState(false)

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
        <DataTable columns={['Грузовик', 'Госномер', 'Макс. скорость', '']}>
          {vehicles.map((vehicle) => (
            <tr key={vehicle.id} className="hover:bg-slate-50">
              <td className="px-3 py-3 text-lg font-bold tabular-nums">{vehicle.vehicleNumber}</td>
              <td className="px-3 py-3 text-sm">{vehicle.licensePlate || '–'}</td>
              <td className="px-3 py-3 text-sm tabular-nums">{vehicle.maxSpeedKmh} км/ч</td>
              <td className="px-3 py-3 text-right">
                <Link className="secondary-button min-h-9 px-2" to={`/vehicles/${vehicle.id}`} aria-label={`Открыть грузовик ${vehicle.vehicleNumber}`}>
                  <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
                </Link>
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
