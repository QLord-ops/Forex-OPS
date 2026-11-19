import { Clock, ListChecks, LogOut, Truck } from 'lucide-react'
import { useState } from 'react'
import { driverApi, type DriverSession } from './api'

const clock = (iso: string) => new Intl.DateTimeFormat('ru-RU', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' }).format(new Date(iso))

export function ShiftScreen({ session, onSignedOut }: { session: Extract<DriverSession, { authenticated: true }>; onSignedOut: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const { vehicle } = session

  const logout = async () => {
    setBusy(true)
    setError('')
    try {
      await driverApi.logout()
      onSignedOut()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось выйти.')
      setBusy(false)
    }
  }

  return (
    <main className="shift">
      <header className="shift-bar">
        <div>
          <h1>{vehicle.licensePlate ?? vehicle.vehicleNumber}</h1>
          <p>Машина {vehicle.vehicleNumber}</p>
        </div>
        <span className="chip chip-green">В смене</span>
      </header>

      <section className="shift-body">
        <div className="card">
          <div className="card-row"><Clock aria-hidden="true" /><span>Смена до <strong>{clock(session.expiresAt)}</strong></span></div>
          <div className="card-row"><Truck aria-hidden="true" /><span>Позиция машины берётся из Webfleet, телефон её не передаёт.</span></div>
        </div>

        <div className="card card-quiet" role="status">
          <ListChecks aria-hidden="true" />
          <div>
            <strong>Тур на сегодня</strong>
            <p>Скоро здесь появятся точки тура, «Прибыл», BELADEN и ENTLADEN.</p>
          </div>
        </div>
        {error && <p className="shift-error" role="alert">{error}</p>}
      </section>

      <footer className="shift-foot">
        <button type="button" className="button-secondary" onClick={() => { void logout() }} disabled={busy}>
          <LogOut aria-hidden="true" /><span>Выйти</span>
        </button>
      </footer>
    </main>
  )
}
