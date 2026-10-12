import { CalendarClock, CheckCircle2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { api } from '../lib/api'
import { formatDateTime, formatDurationMinutes, shortAddress } from '../lib/format'
import type { AppointmentAnalysis, Tour } from '../types/domain'

export function AppointmentPlanner({ tour, onChange }: { tour: Tour; onChange: () => Promise<unknown> }) {
  const pendingStops = useMemo(
    () => (tour.stops ?? []).filter((stop) => !stop.completedAt).sort((a, b) => a.sequence - b.sequence),
    [tour.stops]
  )
  const initialStop = pendingStops.find((stop) => stop.appointmentAt) ?? pendingStops[0]
  const [open, setOpen] = useState(Boolean(initialStop?.appointmentAt))
  const [stopId, setStopId] = useState(initialStop?.id ?? '')
  const [appointmentLocal, setAppointmentLocal] = useState(() => toLocalDateTime(initialStop?.appointmentAt))
  const [analysis, setAnalysis] = useState<AppointmentAnalysis | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const selectedStop = pendingStops.find((stop) => stop.id === stopId) ?? pendingStops[0]

  const calculate = useCallback(async () => {
    if (!selectedStop) return
    const appointmentAt = toIsoAppointment(appointmentLocal)
    if (!appointmentAt) {
      setError('Укажите дату и время термина.')
      return
    }
    setBusy(true)
    setError('')
    setSuccess('')
    try {
      setAnalysis(await api.previewAppointment(selectedStop.id, appointmentAt))
    } catch (requestError) {
      setError((requestError as Error).message)
      setAnalysis(null)
    } finally {
      setBusy(false)
    }
  }, [appointmentLocal, selectedStop])

  useEffect(() => {
    if (!selectedStop || !open || analysis || busy || !appointmentLocal) return
    void calculate()
  }, [analysis, appointmentLocal, busy, calculate, open, selectedStop])

  if (!pendingStops.length) return null

  function selectStop(id: string) {
    const stop = pendingStops.find((item) => item.id === id)
    setStopId(id)
    setAppointmentLocal(toLocalDateTime(stop?.appointmentAt))
    setAnalysis(null)
    setError('')
    setSuccess('')
  }

  async function apply() {
    const appointmentAt = toIsoAppointment(appointmentLocal)
    if (!analysis || !appointmentAt) return
    setBusy(true)
    setError('')
    try {
      const result = await api.applyAppointment(selectedStop.id, { appointmentAt, version: analysis.version })
      setAnalysis(result)
      setSuccess('Термин прикреплён к заказу. ETA и предупреждения обновлены.')
      await onChange()
    } catch (requestError) {
      setError((requestError as Error).message)
      setAnalysis(null)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="work-surface min-w-0 p-4">
      <button
        type="button"
        className="secondary-button"
        onClick={() => {
          const nextOpen = !open
          setOpen(nextOpen)
          setError('')
          setSuccess('')
          if (nextOpen && appointmentLocal) void calculate()
        }}
      >
        <CalendarClock className="h-4 w-4" aria-hidden="true" />
        {open ? 'Закрыть термин' : 'Добавить или изменить термин'}
      </button>

      {open ? (
        <div className="mt-3 space-y-3">
          <p className="text-sm text-slate-600">
            Выберите незавершённую загрузку или выгрузку. Сначала система рассчитает ETA и рекомендуемое время выезда, затем термин можно подтвердить.
          </p>
          <label className="block text-sm">
            <span className="field-label">Точка заказа</span>
            <select className="field-input" value={selectedStop.id} onChange={(event) => selectStop(event.target.value)} disabled={busy}>
              {pendingStops.map((stop) => (
                <option key={stop.id} value={stop.id}>
                  {stop.type === 'LOAD' ? 'Загрузка' : 'Выгрузка'} {stop.sequence} · {shortAddress(stop)}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            <span className="field-label">Новый термин</span>
            <input
              className="field-input"
              type="datetime-local"
              value={appointmentLocal}
              onChange={(event) => {
                setAppointmentLocal(event.target.value)
                setAnalysis(null)
                setSuccess('')
              }}
              disabled={busy}
            />
          </label>
          <button type="button" className="secondary-button" disabled={busy || !appointmentLocal} onClick={() => void calculate()}>
            Рассчитать ETA и время выезда
          </button>

          {analysis ? (
            <AppointmentResult
              analysis={analysis}
              busy={busy}
              saved={Boolean(selectedStop.appointmentAt && new Date(selectedStop.appointmentAt).getTime() === new Date(analysis.appointmentAt).getTime())}
              onApply={() => void apply()}
            />
          ) : null}
          {error ? <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p> : null}
          {success ? <p className="flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800"><CheckCircle2 className="h-4 w-4" />{success}</p> : null}
        </div>
      ) : null}
    </section>
  )
}

function AppointmentResult({
  analysis,
  busy,
  saved,
  onApply
}: {
  analysis: AppointmentAnalysis
  busy: boolean
  saved: boolean
  onApply: () => void
}) {
  const riskLabel = analysis.risk === 'ON_TIME'
    ? 'Успевает по расчёту'
    : analysis.risk === 'RISK'
      ? 'Есть риск опоздания'
      : analysis.risk === 'LATE'
        ? 'Расчёт показывает опоздание'
        : 'Недостаточно данных о позиции'
  const tone = analysis.risk === 'ON_TIME' ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-amber-200 bg-amber-50 text-amber-950'

  return (
    <div className={`space-y-2 rounded-md border p-3 text-sm ${tone}`}>
      <p className="font-semibold">{riskLabel}</p>
      <p>Термин: {formatDateTime(analysis.appointmentAt)}</p>
      <p>ETA: {formatDateTime(analysis.earliestArrival)}–{formatDateTime(analysis.latestArrival)}</p>
      {analysis.recommendedStartAt ? <p>Начать движение не позднее: <strong>{formatDateTime(analysis.recommendedStartAt)}</strong></p> : null}
      <p>Запас по верхней ETA: {analysis.bufferMinutes >= 0 ? formatDurationMinutes(analysis.bufferMinutes) : `опоздание ${formatDurationMinutes(Math.abs(analysis.bufferMinutes))}`}</p>
      <p>{analysis.message}</p>
      {analysis.preliminary ? <p className="text-xs">Расчёт предварительный: GPS отсутствует или исходные часы машины заполнены не полностью.</p> : null}
      {saved ? (
        <p className="text-xs font-semibold uppercase tracking-wide">Термин прикреплён к заказу</p>
      ) : (
        <button type="button" className="primary-button" disabled={busy} onClick={onApply}>Подтвердить и прикрепить термин</button>
      )}
    </div>
  )
}

function toLocalDateTime(value?: string | null): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offset).toISOString().slice(0, 16)
}

function toIsoAppointment(value: string): string | null {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}
