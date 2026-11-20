import { Phone, UserRound } from 'lucide-react'
import type { TourView } from './api'
import { clockWithDay, doneWord, telLink, terminOf, windowLabel } from './format'

/** The tour's papers as data: what the Auftrag says the driver needs. The Auftrag file itself stays at the office (prices, customer data). */
export function DocumentsTab({ view }: { view: TourView }) {
  const tour = view.tour
  if (!tour) return <section className="card empty"><h2>Документов нет</h2><p className="muted">Когда диспетчер назначит тур, здесь появятся данные Auftrag.</p></section>
  return <>
    <section className="card">
      <h2 className="label">Auftrag</h2>
      <dl className="facts-plain">
        <div><dt>Номер</dt><dd>{tour.orderNumber}</dd></div>
        {tour.trailerPlate && <div><dt>Прицеп</dt><dd>{tour.trailerPlate}</dd></div>}
        <div><dt>Точек</dt><dd>{tour.stops.length}</dd></div>
      </dl>
    </section>
    {tour.tourRemarks && <section className="card card-remarks"><h2 className="label">Tourbemerkung</h2><p className="remarks">{tour.tourRemarks}</p></section>}
    <h2 className="section-title">По точкам</h2>
    {tour.stops.map(stop => {
      const termin = terminOf(stop)
      return <section key={stop.id} className="card doc-stop" aria-label={`Точка ${stop.sequence}`}>
        <div className="doc-stop-head"><span className={`badge${stop.completedAt ? ' badge-done' : ''}`}>{stop.sequence}</span><span className="stop-row-type">{doneWord(stop)}</span></div>
        <h3 className="doc-stop-company">{stop.company ?? stop.address}</h3>
        <dl className="facts-plain">
          <div><dt>Адрес</dt><dd>{stop.address}</dd></div>
          {termin && <div><dt>Termin</dt><dd>{clockWithDay(termin, view.serverTime)}{windowLabel(stop) ? ` · ${windowLabel(stop)}` : ''}</dd></div>}
          {stop.loadingMeters !== null && <div><dt>Груз</dt><dd>{stop.loadingMeters.toLocaleString('de-DE')} LDM</dd></div>}
          {stop.references.length > 0 && <div><dt>Ref</dt><dd className="mono">{stop.references.join(', ')}</dd></div>}
          {stop.instructions && <div><dt>Указания</dt><dd>{stop.instructions}</dd></div>}
        </dl>
      </section>
    })}
    <p className="muted small-note">Это данные из Auftrag. Сам файл с ценами и данными заказчика остаётся у диспетчера.</p>
  </>
}

export function DispatcherTab({ view }: { view: TourView }) {
  const dispatcher = view.dispatcher ?? null
  if (!dispatcher) return <section className="card empty">
    <h2>Диспетчера сейчас нет</h2>
    <p className="muted">Машину сейчас никто не ведёт. Звоните в диспетчерскую Forex по обычному номеру.</p>
  </section>
  return <section className="card call" aria-label="Ваш диспетчер">
    <span className="call-avatar" aria-hidden="true"><UserRound /></span>
    <p className="label">Ваш диспетчер</p>
    <h2 className="call-name">{dispatcher.name}</h2>
    {dispatcher.phone
      ? <>
        <p className="call-phone">{dispatcher.phone}</p>
        <a className="button button-primary" href={telLink(dispatcher.phone)}><Phone aria-hidden="true" /><span>Позвонить</span></a>
      </>
      : <p className="muted">Номер не указан. Диспетчер добавит его в OPS Disponent: меню → «Телефон для водителей».</p>}
    <p className="muted small-note">Тот, кто ведёт вашу машину сейчас. Если его подменяет коллега — здесь коллега.</p>
  </section>
}
