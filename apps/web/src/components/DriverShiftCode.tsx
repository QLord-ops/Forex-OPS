import { Copy, KeyRound, Loader2, LogOut, Smartphone } from 'lucide-react'
import { useState } from 'react'
import { usePolling } from '../hooks/usePolling'
import { SHIFT_LENGTHS, shiftOf, shiftSummary, spacedCode, untilText, type DriverShift } from '../lib/driver-shift'
import { operationsRequest } from './VehicleOperationsPanel'
import './truck-card.css'

/**
 * The shift code for the driver app of one truck. The code is shown once, right after it is issued: the server keeps
 * only its hash. A new code or «Завершить смену» signs the phone out at once.
 */
export function DriverShiftCode({ vehicleId, vehicleLabel }: { vehicleId: string; vehicleLabel: string }) {
  const state = usePolling(() => operationsRequest<unknown>(`/vehicles/${vehicleId}/driver-shift`), 30_000, Boolean(vehicleId), vehicleId)
  const [hours, setHours] = useState<number>(SHIFT_LENGTHS[0].hours)
  const [issued, setIssued] = useState<{ code: string; endsAt: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const shift = shiftOf(state.data)
  const summary = shiftSummary(shift)

  async function act(work: () => Promise<void>) {
    setBusy(true); setError('')
    try { await work(); await state.refetch() } catch (cause) { setError(cause instanceof Error ? cause.message : 'Не получилось. Повторите.') } finally { setBusy(false) }
  }
  const issue = () => {
    if (shift && !window.confirm(`Выдать новый код для ${vehicleLabel}? Старый код перестанет работать, телефон с ним выйдет из приложения.`)) return
    void act(async () => {
      const result = await operationsRequest<{ code: string; shift: DriverShift }>(`/vehicles/${vehicleId}/driver-shift`, 'POST', { hours })
      setIssued({ code: result.code, endsAt: result.shift.endsAt }); setCopied(false)
    })
  }
  const end = () => {
    if (!window.confirm(`Завершить смену ${vehicleLabel}? Телефон сразу выйдет из приложения, код перестанет работать.`)) return
    void act(async () => { await operationsRequest(`/vehicles/${vehicleId}/driver-shift`, 'DELETE'); setIssued(null) })
  }
  const copy = async (code: string) => {
    try { await navigator.clipboard.writeText(code); setCopied(true) } catch { setError('Не удалось скопировать — продиктуйте код водителю.') }
  }

  return <div className="driver-shift">
    {issued ? <div className="driver-shift-code" role="status" aria-live="polite">
      <span className="driver-shift-code-label">Код смены · {untilText(issued.endsAt)}</span>
      <strong className="driver-shift-code-value" aria-label={`Код ${issued.code.split('').join(' ')}`}>{spacedCode(issued.code)}</strong>
      <span className="truck-card-muted">Код показывается один раз. Передайте водителю: номер машины «{vehicleLabel}» и этот код.</span>
      <div className="driver-shift-actions">
        <button type="button" className="secondary-button compact-button" onClick={() => void copy(issued.code)}><Copy className="h-4 w-4" aria-hidden="true" />{copied ? 'Скопировано' : 'Скопировать'}</button>
        <button type="button" className="secondary-button compact-button" onClick={() => setIssued(null)}>Готово</button>
      </div>
    </div> : null}

    {state.error && !state.data ? <p className="truck-card-note">Состояние смены не загрузилось.</p>
      : !state.data ? <p className="truck-card-note">Загружаем…</p>
        : <p className={`driver-shift-state driver-shift-state-${summary.tone}`}><Smartphone className="h-4 w-4" aria-hidden="true" /><span><strong>{summary.label}</strong><span className="truck-card-muted">{summary.detail}</span></span></p>}

    {state.data && !issued ? <div className="driver-shift-actions">
      <label className="driver-shift-hours"><span className="sr-only">Срок кода</span>
        <select value={hours} onChange={(event) => setHours(Number(event.target.value))} disabled={busy} aria-label="Срок кода">
          {SHIFT_LENGTHS.map((item) => <option key={item.hours} value={item.hours}>{item.label}</option>)}
        </select>
      </label>
      <button type="button" className="primary-button compact-button" onClick={issue} disabled={busy}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <KeyRound className="h-4 w-4" aria-hidden="true" />}{shift ? 'Новый код' : 'Выдать код'}
      </button>
      {shift ? <button type="button" className="secondary-button compact-button" onClick={end} disabled={busy}><LogOut className="h-4 w-4" aria-hidden="true" />Завершить смену</button> : null}
    </div> : null}
    {error ? <p className="truck-card-alert" role="alert">{error}</p> : null}
  </div>
}
