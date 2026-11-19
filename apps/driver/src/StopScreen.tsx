import { AlertTriangle, Bell, Check, ChevronLeft, ChevronRight, Clock, MapPin, Navigation, Package, Undo2 } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { useServerNow } from './useServerNow'
import { driverApi, PROBLEMS, type DriverStop, type DriverTour, type ProblemKind, type TourView } from './api'
import { cargoLine, clock, clockWithDay, doneWord, minutesText, navigationLink, terminOf, windowLabel } from './format'

type Props = {
  tour: DriverTour
  stop: DriverStop
  serverTime: string
  onBack: () => void
  onOpen: (stopId: string) => void
  onChanged: (view: TourView) => void
  onFailed: (cause: unknown) => void
}

export function StopScreen({ tour, stop, serverTime, onBack, onOpen, onChanged, onFailed }: Props) {
  const [sheet, setSheet] = useState<'confirm' | 'problem' | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const now = useServerNow(serverTime)
  const index = tour.stops.findIndex(item => item.id === stop.id)
  const next = tour.stops[index + 1] ?? null
  const isCurrent = tour.currentStopId === stop.id
  const word = doneWord(stop)
  const termin = terminOf(stop)
  const cargo = cargoLine(stop)
  const canMark = isCurrent && (Boolean(stop.arrivedAt) || stop.samePlaceAsPrevious)
  const undoLeft = stop.undoUntil ? Date.parse(stop.undoUntil) - now : 0

  const run = async (action: () => Promise<TourView>) => {
    setBusy(true)
    try {
      onChanged(await action())
      setSheet(null)
    } catch (cause) { setSheet(null); onFailed(cause); onBack() } finally { setBusy(false) }
  }

  if (stop.completedAt) {
    return (
      <main className="screen">
        <TopBar onBack={onBack} title={`Точка ${stop.sequence} из ${tour.stops.length}`} />
        <div className="body done">
          <span className="done-mark"><Check aria-hidden="true" /></span>
          <h1>{word} записан</h1>
          <p className="muted">{[stop.company, stop.city].filter(Boolean).join(', ')} · {clockWithDay(stop.completedAt, serverTime)}</p>
          {undoLeft > 0 ? <section className="card">
            <p className="row"><Bell aria-hidden="true" /><strong>Диспетчер уведомлён</strong></p>
            <p className="muted">Ошиблись? Отметку можно отменить ещё {minutesText(undoLeft / 60_000 + 0.49)} — потом только через диспетчера.</p>
            <button type="button" className="button button-secondary" disabled={busy} onClick={() => { void run(() => driverApi.undo(stop.id)) }}><Undo2 aria-hidden="true" /><span>Отменить {word}</span></button>
          </section> : stop.undoUntil === null ? null : <p className="muted">Время отмены вышло. Если это ошибка — позвоните диспетчеру.</p>}
          {next && !next.completedAt && <>
            <h2 className="section-title">Следующая точка</h2>
            <section className="card current">
              <div className="chips"><span className="chip chip-blue">{doneWord(next)}</span>{next.samePlaceAsPrevious && <span className="chip chip-orange">Здесь же</span>}</div>
              <div><h2 className="company">{next.company ?? next.address}</h2><p className="address"><MapPin aria-hidden="true" /><span>{next.address}</span></p></div>
              <button type="button" className="button button-primary" onClick={() => onOpen(next.id)}><span>Открыть точку {next.sequence}</span><ChevronRight aria-hidden="true" /></button>
            </section>
          </>}
          {!next && <p className="banner banner-ok">Тур выполнен. Спасибо!</p>}
        </div>
      </main>
    )
  }

  return (
    <main className="screen">
      <TopBar onBack={onBack} title={`Точка ${stop.sequence} из ${tour.stops.length}`} />
      <div className="body">
        {notice && <p className="banner banner-ok" role="status">{notice}</p>}
        {stop.arrivedAt && <p className="banner banner-orange"><Clock aria-hidden="true" /><span><strong>На точке с {clock(stop.arrivedAt)} · {minutesText((now - Date.parse(stop.arrivedAt)) / 60_000)}</strong></span></p>}
        {!isCurrent && <p className="banner banner-quiet">Эта точка ещё впереди: сначала выполните предыдущие.</p>}
        <div className="chips">
          <span className="chip chip-blue">{word}</span>
          {termin && <span className="chip chip-purple">Termin {clockWithDay(termin, serverTime)}</span>}
          {windowLabel(stop) && <span className="chip chip-purple">{windowLabel(stop)}</span>}
        </div>
        <h1 className="company company-large">{stop.company ?? stop.address}</h1>
        <dl className="card facts">
          <div><dt>Адрес</dt><dd>{stop.address}</dd></div>
          {cargo && <div><dt>Груз</dt><dd>{cargo}</dd></div>}
          {stop.instructions && <div><dt>Указания</dt><dd>{stop.instructions}</dd></div>}
        </dl>
        {tour.tourRemarks && <section className="card"><h2 className="label">Tourbemerkung</h2><p className="remarks">{tour.tourRemarks}</p></section>}
        {next?.samePlaceAsPrevious && <p className="banner banner-quiet"><Package aria-hidden="true" /><span>Следом здесь же: {doneWord(next)} (точка {next.sequence})</span></p>}
      </div>
      <footer className="foot">
        {canMark ? <button type="button" className="button button-primary" onClick={() => setSheet('confirm')}><Check aria-hidden="true" /><span>{word} выполнено</span></button>
          : isCurrent ? <>
            <button type="button" className="button button-primary" disabled={busy} onClick={() => { void run(() => driverApi.arrived(stop.id)) }}><MapPin aria-hidden="true" /><span>{busy ? 'Записываем…' : 'Прибыл'}</span></button>
            <a className="button button-secondary" href={navigationLink(stop)} target="_blank" rel="noreferrer"><Navigation aria-hidden="true" /><span>Навигация</span></a>
          </> : <a className="button button-secondary" href={navigationLink(stop)} target="_blank" rel="noreferrer"><Navigation aria-hidden="true" /><span>Навигация</span></a>}
        {isCurrent && <button type="button" className="button button-secondary" onClick={() => setSheet('problem')}><AlertTriangle aria-hidden="true" /><span>Проблема на точке</span></button>}
      </footer>

      {sheet === 'confirm' && <Sheet title={`Подтвердить ${word}?`} onClose={() => setSheet(null)}>
        <p className="muted">{[stop.company, stop.city].filter(Boolean).join(', ')} · точка {stop.sequence} из {tour.stops.length}</p>
        <p className="card row"><Clock aria-hidden="true" /><span>Время отметки: <strong>{clock(new Date(now).toISOString())} · сейчас</strong></span></p>
        <p className="row muted"><Bell aria-hidden="true" /><span>Отметка записывается сразу. Диспетчер получит уведомление и сможет её отменить.</span></p>
        <button type="button" className="button button-primary" disabled={busy} onClick={() => { void run(() => driverApi.done(stop.id)) }}><Check aria-hidden="true" /><span>{busy ? 'Записываем…' : `Подтвердить ${word}`}</span></button>
        <button type="button" className="button button-quiet" onClick={() => setSheet(null)} disabled={busy}>Отмена</button>
      </Sheet>}

      {sheet === 'problem' && <ProblemSheet stopId={stop.id} onClose={() => setSheet(null)} onSent={() => { setSheet(null); setNotice('Диспетчер получил сообщение и свяжется с вами.') }} />}
    </main>
  )
}

function TopBar({ onBack, title }: { onBack: () => void; title: string }) {
  return (
    <header className="bar bar-top">
      <button type="button" className="back" onClick={onBack}><ChevronLeft aria-hidden="true" /><span>Тур</span></button>
      <span className="muted">{title}</span>
    </header>
  )
}

function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="scrim" onClick={event => { if (event.target === event.currentTarget) onClose() }}>
      <section className="sheet" role="dialog" aria-modal="true" aria-label={title}>
        <span className="grabber" aria-hidden="true" />
        <h2>{title}</h2>
        {children}
      </section>
    </div>
  )
}

function ProblemSheet({ stopId, onClose, onSent }: { stopId: string; onClose: () => void; onSent: () => void }) {
  const [kind, setKind] = useState<ProblemKind | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const send = async () => {
    if (!kind) return setError('Выберите, что случилось.')
    setBusy(true)
    setError('')
    try {
      await driverApi.problem(stopId, kind, note)
      onSent()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось отправить.')
      setBusy(false)
    }
  }
  return (
    <Sheet title="Проблема на точке" onClose={onClose}>
      <fieldset className="choices">
        <legend className="muted">Что случилось? Диспетчер получит сообщение сразу.</legend>
        {PROBLEMS.map(([value, label]) => <label key={value} className={`choice${kind === value ? ' choice-on' : ''}`}>
          <input type="radio" name="problem" value={value} checked={kind === value} onChange={() => { setKind(value); setError('') }} /><span>{label}</span>
        </label>)}
      </fieldset>
      <label className="field-label light" htmlFor="problem-note">Комментарий (необязательно)</label>
      <textarea id="problem-note" className="note" rows={2} maxLength={300} value={note} onChange={event => setNote(event.target.value)} />
      {error && <p className="banner banner-error" role="alert">{error}</p>}
      <button type="button" className="button button-primary" onClick={() => { void send() }} disabled={busy}><span>{busy ? 'Отправляем…' : 'Отправить диспетчеру'}</span></button>
      <button type="button" className="button button-quiet" onClick={onClose} disabled={busy}>Отмена</button>
    </Sheet>
  )
}
