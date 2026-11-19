import { Check, ChevronRight, LogOut, MapPin, Navigation, RefreshCw, Undo2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, driverApi, type DriverSession, type DriverStop, type TourView } from './api'
import { cargoLine, clock, clockWithDay, dayLabel, doneWord, etaMargin, etaSourceText, minutesText, navigationLink, terminOf, windowLabel } from './format'
import { StopScreen } from './StopScreen'
import { useServerNow } from './useServerNow'

const REFRESH_MS = 30_000

export function Shift({ session, onSignedOut }: { session: Extract<DriverSession, { authenticated: true }>; onSignedOut: () => void }) {
  const [view, setView] = useState<TourView | null>(null)
  const [error, setError] = useState('')
  const [openStopId, setOpenStopId] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const alive = useRef(true)

  const failed = useCallback((cause: unknown) => {
    // A new code, the end of the shift or «end shift» at the office: back to the sign-in.
    if (cause instanceof ApiError && cause.status === 401) return onSignedOut()
    setError(cause instanceof Error ? cause.message : 'Не удалось загрузить тур.')
  }, [onSignedOut])

  const load = useCallback(async () => {
    setRefreshing(true)
    try {
      const fresh = await driverApi.tour()
      if (!alive.current) return
      setView(fresh)
      setError('')
    } catch (cause) {
      if (alive.current) failed(cause)
    } finally {
      if (alive.current) setRefreshing(false)
    }
  }, [failed])

  useEffect(() => {
    alive.current = true
    void load()
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void load() }, REFRESH_MS)
    const onVisible = () => { if (document.visibilityState === 'visible') void load() }
    document.addEventListener('visibilitychange', onVisible)
    return () => { alive.current = false; window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisible) }
  }, [load])

  const logout = async () => {
    if (!window.confirm('Выйти из смены? Войти снова можно тем же кодом.')) return
    try { await driverApi.logout() } catch { /* The cookie is dropped either way on the next sign-in. */ }
    onSignedOut()
  }

  const openStop = view?.tour?.stops.find(stop => stop.id === openStopId) ?? null
  if (view?.tour && openStop) {
    return <StopScreen tour={view.tour} stop={openStop} serverTime={view.serverTime} onBack={() => setOpenStopId(null)} onOpen={setOpenStopId}
      onChanged={fresh => { setView(fresh); setError('') }} onFailed={failed} />
  }

  const vehicle = view?.vehicle ?? session.vehicle
  return (
    <main className="screen">
      <header className="bar">
        <div className="bar-title">
          <h1 className="plate">{vehicle.licensePlate ?? vehicle.vehicleNumber}</h1>
          <p>{view?.tour ? `Тур ${view.tour.orderNumber} · ${dayLabel(view.serverTime)}` : `Машина ${vehicle.vehicleNumber}`}</p>
        </div>
        <button type="button" className="icon-button" onClick={() => { void load() }} aria-label="Обновить" disabled={refreshing}><RefreshCw className={refreshing ? 'turning' : ''} aria-hidden="true" /></button>
        <button type="button" className="icon-button" onClick={() => { void logout() }} aria-label="Выйти из смены"><LogOut aria-hidden="true" /></button>
      </header>

      <div className="body">
        {error && <p className="banner banner-error" role="alert">{error}</p>}
        {!view && !error && <p className="muted center" role="status">Загружаем тур…</p>}
        {view?.lastMark && <LastMark view={view} onChanged={setView} onFailed={failed} />}
        {view && !view.tour && <NoTour view={view} />}
        {view?.tour && <Tour view={view} onOpen={setOpenStopId} onChanged={setView} onFailed={failed} />}
      </div>
    </main>
  )
}

/** The mark that closed the previous tour: the phone already shows the next tour, the mark can still be taken back. */
function LastMark({ view, onChanged, onFailed }: { view: TourView; onChanged: (view: TourView) => void; onFailed: (cause: unknown) => void }) {
  const mark = view.lastMark!
  const [busy, setBusy] = useState(false)
  const left = Date.parse(mark.undoUntil) - useServerNow(view.serverTime)
  if (left <= 0) return null
  const word = doneWord(mark)
  const undo = async () => {
    setBusy(true)
    try { onChanged(await driverApi.undo(mark.stopId)) } catch (cause) { onFailed(cause) } finally { setBusy(false) }
  }
  return (
    <section className="card card-ok" aria-label="Последняя отметка">
      <p className="row"><Check aria-hidden="true" /><span><strong>{word} записан в {clock(mark.completedAt)} — тур {mark.orderNumber} выполнен.</strong> {[mark.company, mark.city].filter(Boolean).join(', ')}. Диспетчер уведомлён.</span></p>
      <button type="button" className="button button-secondary" onClick={() => { void undo() }} disabled={busy}><Undo2 aria-hidden="true" /><span>Отменить · {minutesText(left / 60_000 + 0.49)}</span></button>
    </section>
  )
}

function NoTour({ view }: { view: TourView }) {
  return (
    <section className="card empty">
      <h2>Активного тура нет</h2>
      <p className="muted">Когда диспетчер назначит тур, он появится здесь сам.</p>
      {view.next && <p>Следующий: <strong>{view.next.orderNumber}</strong>{view.next.company ? ` — ${view.next.company}` : ''}{view.next.city ? `, ${view.next.city}` : ''}
        {view.next.appointmentAt ? ` · Termin ${clockWithDay(view.next.appointmentAt, view.serverTime)}` : ''}</p>}
    </section>
  )
}

function Tour({ view, onOpen, onChanged, onFailed }: { view: TourView; onOpen: (id: string) => void; onChanged: (view: TourView) => void; onFailed: (cause: unknown) => void }) {
  const tour = view.tour!
  const [busy, setBusy] = useState(false)
  const done = tour.stops.filter(stop => stop.completedAt).length
  const current = tour.stops.find(stop => stop.id === tour.currentStopId) ?? null
  const rest = tour.stops.filter(stop => stop.id !== current?.id)

  const arrive = async (stop: DriverStop) => {
    setBusy(true)
    try {
      onChanged(await driverApi.arrived(stop.id))
      onOpen(stop.id)
    } catch (cause) { onFailed(cause) } finally { setBusy(false) }
  }

  return (
    <>
      <section className="progress" aria-label="Ход тура">
        <div className="progress-label"><strong>{current ? `Точка ${current.sequence} из ${tour.stops.length}` : 'Все точки выполнены'}</strong><span className="ok-text">{done} выполнено</span></div>
        <div className="progress-track"><span style={{ width: `${Math.round(done / tour.stops.length * 100)}%` }} /></div>
      </section>

      {current && <CurrentStop stop={current} view={view} busy={busy} onArrive={() => { void arrive(current) }} onOpen={() => onOpen(current.id)} />}

      {tour.tourRemarks && <section className="card"><h2 className="label">Tourbemerkung</h2><p className="remarks">{tour.tourRemarks}</p></section>}

      {rest.length > 0 && <>
        <h2 className="section-title">{current ? 'Остальные точки' : 'Точки тура'}</h2>
        <ul className="stop-list">
          {rest.map(stop => <li key={stop.id}>
            <button type="button" className="stop-row" onClick={() => onOpen(stop.id)}>
              <span className={`badge${stop.completedAt ? ' badge-done' : ''}`}>{stop.completedAt ? <Check aria-hidden="true" /> : stop.sequence}</span>
              <span className="stop-row-text">
                <span className="stop-row-type">{doneWord(stop)}{stop.samePlaceAsPrevious ? ' · то же место' : ''}</span>
                <span className={`stop-row-company${stop.completedAt ? ' muted' : ''}`}>{stop.company ?? stop.address}</span>
                <span className="stop-row-meta">{stop.completedAt ? `Выполнено ${clockWithDay(stop.completedAt, view.serverTime)}`
                  : [stop.city, terminOf(stop) ? `Termin ${clockWithDay(terminOf(stop)!, view.serverTime)}` : 'без Termin'].filter(Boolean).join(' · ')}</span>
              </span>
              <ChevronRight className="stop-row-chevron" aria-hidden="true" />
            </button>
          </li>)}
        </ul>
      </>}

      {view.next && <p className="muted next-tour">Следующий тур: {view.next.orderNumber}{view.next.city ? `, ${view.next.city}` : ''}</p>}
    </>
  )
}

/** A time with its date («20.11. 00:05») is longer than the tile: it gets the smaller size. */
const tileValue = (text: string) => text.length > 5 ? 'tile-value tile-value-dated' : 'tile-value'

function CurrentStop({ stop, view, busy, onArrive, onOpen }: { stop: DriverStop; view: TourView; busy: boolean; onArrive: () => void; onOpen: () => void }) {
  const eta = view.tour!.eta
  const termin = terminOf(stop)
  const margin = etaMargin(stop, eta)
  const cargo = cargoLine(stop)
  const needsArrival = !stop.arrivedAt && !stop.samePlaceAsPrevious
  return (
    <section className="card current" aria-label="Текущая точка">
      <div className="chips">
        <span className="chip chip-blue">{doneWord(stop)}</span>
        {stop.arrivedAt ? <span className="chip chip-orange">На точке с {clock(stop.arrivedAt)}</span>
          : stop.samePlaceAsPrevious ? <span className="chip chip-orange">Здесь же</span> : <span className="chip chip-green">В пути</span>}
      </div>
      <div>
        <h2 className="company">{stop.company ?? stop.address}</h2>
        <p className="address"><MapPin aria-hidden="true" /><span>{stop.address}</span></p>
      </div>
      {(termin || eta?.at) && <div className="tiles">
        {termin && <div className="tile tile-purple"><span className="tile-label">Termin</span><span className={tileValue(clockWithDay(termin, view.serverTime))}>{clockWithDay(termin, view.serverTime)}</span>{windowLabel(stop) && <span className="tile-sub">{windowLabel(stop)}</span>}</div>}
        {eta?.at && !stop.arrivedAt && <div className={`tile ${margin?.late ? 'tile-red' : 'tile-green'}`}><span className="tile-label">ETA · {etaSourceText(eta)}</span><span className={tileValue(clockWithDay(eta.at, view.serverTime))}>{clockWithDay(eta.at, view.serverTime)}</span>{margin && <span className="tile-sub">{margin.text}</span>}</div>}
      </div>}
      {cargo && <p className="muted cargo">{cargo}</p>}
      <div className="actions">
        {needsArrival ? <>
          <a className="button button-secondary" href={navigationLink(stop)} target="_blank" rel="noreferrer"><Navigation aria-hidden="true" /><span>Навигация</span></a>
          <button type="button" className="button button-primary" onClick={onArrive} disabled={busy}><MapPin aria-hidden="true" /><span>{busy ? 'Записываем…' : 'Прибыл'}</span></button>
        </> : <button type="button" className="button button-primary" onClick={onOpen}><span>Открыть точку</span><ChevronRight aria-hidden="true" /></button>}
      </div>
    </section>
  )
}
