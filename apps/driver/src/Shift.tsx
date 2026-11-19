import { Check, ChevronRight, CloudOff, FileText, List, LogOut, MapPin, Navigation, Phone, RefreshCw, Undo2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, driverApi, hasCsrf, offlineError, type DriverSession, type DriverStop, type TourView } from './api'
import { InstallHint } from './InstallHint'
import { DispatcherTab, DocumentsTab } from './Tabs'
import { kept, serverNow, withPending, type PendingMark } from './offline'
import { cargoLine, clock, clockWithDay, countdown, dayLabel, doneWord, etaMargin, etaSourceText, navigationLink, terminOf, windowLabel } from './format'
import { StopScreen } from './StopScreen'
import { useServerNow } from './useServerNow'

const REFRESH_MS = 30_000

export type MarkAction = 'arrived' | 'done'
/** «sent»: the server has it; «kept»: no network, the phone sends it later. */
export type MarkResult = 'sent' | 'kept'

export function Shift({ session, onSignedOut }: { session: Extract<DriverSession, { authenticated: true }>; onSignedOut: () => void }) {
  const [view, setView] = useState<TourView | null>(() => kept.view()?.view ?? null)
  const [marks, setMarks] = useState<PendingMark[]>(() => kept.marks(session.vehicle))
  const [fromPhone, setFromPhone] = useState(() => Boolean(kept.view()))
  const [error, setError] = useState('')
  const [openStopId, setOpenStopId] = useState<string | null>(null)
  const [tab, setTab] = useState<'tour' | 'docs' | 'call'>('tour')
  const [refreshing, setRefreshing] = useState(false)
  const alive = useRef(true)
  const sending = useRef(false)
  const online = useOnline()

  const show = useCallback((fresh: TourView) => {
    kept.saveView(fresh)
    setView(fresh)
    setFromPhone(false)
    setError('')
  }, [])

  const failed = useCallback((cause: unknown) => {
    // A new code, the end of the shift or «end shift» at the office: back to the sign-in.
    if (cause instanceof ApiError && cause.status === 401) return onSignedOut()
    setError(cause instanceof Error ? cause.message : 'Не удалось загрузить тур.')
  }, [onSignedOut])

  /** Sends the kept marks in the order they were pressed; stops at the first one that still finds no network. */
  const sendKept = useCallback(async () => {
    if (sending.current) return
    const waiting = kept.marks(session.vehicle)
    if (!waiting.length) return
    sending.current = true
    try {
      // A session opened without network has no CSRF token yet.
      if (!hasCsrf()) {
        const fresh = await driverApi.session()
        if (!fresh.authenticated) return onSignedOut()
      }
      for (const mark of waiting) {
        try {
          show(await (mark.action === 'arrived' ? driverApi.arrived(mark.stopId, mark.at) : driverApi.done(mark.stopId, mark.at)))
          kept.dropMark(mark.id)
        } catch (cause) {
          if (offlineError(cause)) break
          if (cause instanceof ApiError && cause.status === 401) return onSignedOut()
          // The server said no (the dispatcher changed the tour, too old): the mark cannot be sent any more.
          kept.dropMark(mark.id)
          setError(`${mark.action === 'arrived' ? '«Прибыл»' : 'Отметка'} от ${clock(mark.at)} не записана: ${cause instanceof Error ? cause.message : 'ошибка'}`)
        }
      }
    } catch (cause) {
      if (!offlineError(cause)) failed(cause)
    } finally {
      sending.current = false
      if (alive.current) setMarks(kept.marks(session.vehicle))
    }
  }, [failed, onSignedOut, session.vehicle, show])

  const load = useCallback(async () => {
    setRefreshing(true)
    try {
      await sendKept()
      const fresh = await driverApi.tour()
      if (alive.current) show(fresh)
    } catch (cause) {
      if (!alive.current) return
      if (offlineError(cause)) setFromPhone(true)
      else failed(cause)
    } finally {
      if (alive.current) setRefreshing(false)
    }
  }, [failed, sendKept, show])

  useEffect(() => {
    alive.current = true
    void load()
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void load() }, REFRESH_MS)
    const onVisible = () => { if (document.visibilityState === 'visible') void load() }
    const onOnline = () => { void load() }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('online', onOnline)
    return () => { alive.current = false; window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); window.removeEventListener('online', onOnline) }
  }, [load])

  /** «Прибыл» or «выполнено»: straight to the server, or kept on the phone when there is no network. */
  const mark = useCallback(async (stopId: string, action: MarkAction): Promise<MarkResult> => {
    // Marks kept earlier go first: the server needs them in the order they were pressed.
    if (kept.marks(session.vehicle).length) await sendKept()
    if (!kept.marks(session.vehicle).length) {
      try {
        show(await (action === 'arrived' ? driverApi.arrived(stopId) : driverApi.done(stopId)))
        return 'sent'
      } catch (cause) {
        if (!offlineError(cause)) throw cause
      }
    }
    kept.addMark(session.vehicle, stopId, action, serverNow(kept.view()?.offsetMs ?? 0))
    setMarks(kept.marks(session.vehicle))
    setFromPhone(true)
    return 'kept'
  }, [sendKept, session.vehicle, show])

  const dropKept = useCallback((stopId: string) => {
    kept.dropMarksOf(stopId, 'done')
    setMarks(kept.marks(session.vehicle))
  }, [session.vehicle])

  const logout = async () => {
    const waiting = kept.marks(session.vehicle).length
    if (!window.confirm(waiting ? `Выйти из смены? ${waiting} отметок ещё не отправлены — они уйдут после следующего входа этой машины.` : 'Выйти из смены? Войти снова можно тем же кодом.')) return
    try { await driverApi.logout() } catch { /* The cookie is dropped either way on the next sign-in. */ }
    onSignedOut()
  }

  const shown = view ? withPending(view, marks) : null
  const openStop = shown?.tour?.stops.find(stop => stop.id === openStopId) ?? null
  if (shown?.tour && openStop) {
    return <StopScreen tour={shown.tour} stop={openStop} serverTime={shown.serverTime} onBack={() => setOpenStopId(null)} onOpen={setOpenStopId}
      onMark={mark} onDropKept={dropKept} onChanged={show} onFailed={failed} />
  }

  const vehicle = shown?.vehicle ?? session.vehicle
  return (
    <main className="screen">
      <header className="bar">
        <div className="bar-title">
          <h1 className="plate">{vehicle.licensePlate ?? vehicle.vehicleNumber}</h1>
          <p>{shown?.tour ? `Тур ${shown.tour.orderNumber} · ${dayLabel(shown.serverTime)}` : `Машина ${vehicle.vehicleNumber}`}</p>
        </div>
        <span className={`chip ${online && !fromPhone ? 'chip-green' : 'chip-red'}`}>{online && !fromPhone ? 'Онлайн' : 'Нет сети'}</span>
        <button type="button" className="icon-button" onClick={() => { void load() }} aria-label="Обновить" disabled={refreshing}><RefreshCw className={refreshing ? 'turning' : ''} aria-hidden="true" /></button>
        <button type="button" className="icon-button" onClick={() => { void logout() }} aria-label="Выйти из смены"><LogOut aria-hidden="true" /></button>
      </header>

      <div className="body">
        {error && <p className="banner banner-error" role="alert">{error}</p>}
        {(fromPhone || marks.length > 0) && shown && <p className="banner banner-orange" role="status"><CloudOff aria-hidden="true" /><span>
          <strong>{marks.length ? `${marks.length} ${marks.length === 1 ? 'отметка ждёт' : 'отметки ждут'} связи` : 'Нет связи с сервером'}</strong>
          <small>{marks.length ? 'Сохранены на телефоне с временем нажатия и уйдут сами, когда появится сеть.' : `Тур на ${clock(new Date(kept.view()?.savedAt ?? Date.now()).toISOString())}. Отметки можно ставить — они сохранятся на телефоне.`}</small>
        </span></p>}
        {!shown && !error && <p className="muted center" role="status">Загружаем тур…</p>}
        {tab === 'tour' && <>
          {shown?.lastMark && <LastMark view={shown} onChanged={show} onFailed={failed} />}
          {shown && !shown.tour && <NoTour view={shown} />}
          {shown?.tour && <Tour view={shown} onOpen={setOpenStopId} onMark={mark} onFailed={failed} />}
          <InstallHint />
        </>}
        {tab === 'docs' && shown && <DocumentsTab view={shown} />}
        {tab === 'call' && shown && <DispatcherTab view={shown} />}
      </div>

      <nav className="tabs" aria-label="Разделы">
        {([['tour', 'Тур', List], ['docs', 'Документы', FileText], ['call', 'Диспетчер', Phone]] as const).map(([id, label, Icon]) =>
          <button key={id} type="button" className={`tab${tab === id ? ' tab-on' : ''}`} aria-current={tab === id ? 'page' : undefined} onClick={() => setTab(id)}>
            <Icon aria-hidden="true" /><span>{label}</span>
          </button>)}
      </nav>
    </main>
  )
}

function useOnline() {
  const [online, setOnline] = useState(() => navigator.onLine)
  useEffect(() => {
    const update = () => setOnline(navigator.onLine)
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update) }
  }, [])
  return online
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
      <p className="row row-strong"><Check aria-hidden="true" /><span>{word} записан в {clock(mark.completedAt)} — тур {mark.orderNumber} выполнен</span></p>
      <p className="row muted">{[mark.company, mark.city].filter(Boolean).join(', ')}. Диспетчер уведомлён. Ошиблись? Отметку можно отменить — потом только через диспетчера.</p>
      <button type="button" className="button button-secondary" onClick={() => { void undo() }} disabled={busy}><Undo2 aria-hidden="true" /><span>Отменить · {countdown(left)}</span></button>
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

function Tour({ view, onOpen, onMark, onFailed }: { view: TourView; onOpen: (id: string) => void; onMark: (stopId: string, action: MarkAction) => Promise<MarkResult>; onFailed: (cause: unknown) => void }) {
  const tour = view.tour!
  const [busy, setBusy] = useState(false)
  const done = tour.stops.filter(stop => stop.completedAt).length
  const current = tour.stops.find(stop => stop.id === tour.currentStopId) ?? null
  const rest = tour.stops.filter(stop => stop.id !== current?.id)

  const arrive = async (stop: DriverStop) => {
    setBusy(true)
    try {
      await onMark(stop.id, 'arrived')
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

      {tour.tourRemarks && <section className="card card-remarks"><h2 className="label">Tourbemerkung</h2><p className="remarks">{tour.tourRemarks}</p></section>}

      {rest.length > 0 && <>
        <h2 className="section-title">{current ? 'Дальше по туру' : 'Точки тура'}</h2>
        <ul className="stop-list">
          {rest.map(stop => <li key={stop.id}>
            <button type="button" className="stop-row" onClick={() => onOpen(stop.id)}>
              <span className={`badge${stop.completedAt ? ' badge-done' : ''}`}>{stop.completedAt ? <Check aria-hidden="true" /> : stop.sequence}</span>
              <span className="stop-row-text">
                <span className="stop-row-type">{doneWord(stop)}{stop.samePlaceAsPrevious ? ' · то же место' : ''}</span>
                <span className={`stop-row-company${stop.completedAt ? ' muted' : ''}`}>{stop.company ?? stop.address}</span>
                <span className="stop-row-meta">{stop.completedAt ? `Выполнено ${clockWithDay(stop.completedAt, view.serverTime)}${stop.pending ? ' · ждёт связи' : ''}`
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
        {stop.arrivedAt ? <span className="chip chip-orange">На точке с {clock(stop.arrivedAt)}{stop.pending ? ' · ждёт связи' : ''}</span>
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
