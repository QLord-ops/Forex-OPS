import { ArrowRight, Cog, Eye, EyeOff, LockKeyhole, Truck } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { ApiError, driverApi, type DriverSession } from './api'

const LAST_VEHICLE = 'ops-driver-vehicle'

function lastVehicle(): string {
  try { return localStorage.getItem(LAST_VEHICLE) ?? '' } catch { return '' }
}

export function LoginScreen({ onSignedIn }: { onSignedIn: (session: Extract<DriverSession, { authenticated: true }>) => void }) {
  const [vehicle, setVehicle] = useState(lastVehicle)
  const [code, setCode] = useState('')
  const [showCode, setShowCode] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    if (!vehicle.trim()) return setError('Введите номер машины.')
    if (!/^\d{6}$/.test(code)) return setError('Код смены — 6 цифр.')
    setBusy(true)
    setError('')
    try {
      const session = await driverApi.login(vehicle.trim(), code)
      if (!session.authenticated) throw new ApiError('Не удалось войти.', 401)
      try { localStorage.setItem(LAST_VEHICLE, vehicle.trim()) } catch { /* private mode: only a convenience */ }
      onSignedIn(session)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось войти.')
      setCode('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="login">
      <div className="login-hero">
        <img src="/media/hero-driver.jpg" alt="Синяя фура Forex на мокрой трассе на закате" />
        <div className="login-hero-shade" aria-hidden="true" />
        <div className="login-pill"><Truck aria-hidden="true" /><span>Приложение водителя</span></div>
      </div>

      <section className="login-panel" aria-labelledby="login-title">
        <div className="brand" aria-label="OPS FOREX — Fahrer">
          <span className="brand-ops" aria-hidden="true">OPS</span>
          <span className="brand-name" aria-hidden="true"><span>F</span><Cog className="brand-gear" /><span>REX</span></span>
          <span className="brand-tag" aria-hidden="true">FAHRER</span>
        </div>

        <form onSubmit={event => { void submit(event) }} noValidate>
          <h1 id="login-title">Начать смену</h1>
          <p className="login-lead">Номер машины и код смены выдаёт диспетчер.</p>

          <label className="field-label" htmlFor="vehicle">Номер машины</label>
          <div className="field">
            <Truck className="field-icon" aria-hidden="true" />
            <input id="vehicle" className="field-input plate" value={vehicle} onChange={event => { setVehicle(event.target.value); setError('') }}
              autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={20} placeholder="GÖ-FX 214" disabled={busy} />
          </div>

          <label className="field-label" htmlFor="code">Код смены</label>
          <div className={`field${error ? ' field-error' : ''}`}>
            <LockKeyhole className="field-icon" aria-hidden="true" />
            <input id="code" className="field-input code" type={showCode ? 'text' : 'password'} inputMode="numeric" autoComplete="one-time-code"
              value={code} onChange={event => { setCode(event.target.value.replace(/\D/g, '').slice(0, 6)); setError('') }}
              maxLength={6} placeholder="6 цифр" disabled={busy} aria-invalid={Boolean(error)} aria-describedby="login-error" />
            <button type="button" className="field-eye" onClick={() => setShowCode(value => !value)} aria-label={showCode ? 'Скрыть код' : 'Показать код'}>
              {showCode ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
            </button>
          </div>
          <div id="login-error" className="login-error" aria-live="polite">{error && <span role="alert">{error}</span>}</div>

          <button type="submit" className="submit" disabled={busy}>
            <span>{busy ? 'ПРОВЕРЯЕМ' : 'НАЧАТЬ СМЕНУ'}</span>
            {busy ? <span className="spinner spinner-light" aria-hidden="true" /> : <ArrowRight aria-hidden="true" />}
          </button>
        </form>

        <div className="secure"><span /><LockKeyhole aria-hidden="true" /><small>Вход по машине · позиция из Webfleet</small><span /></div>
      </section>
    </main>
  )
}
