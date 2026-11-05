import { candidateText, isTerminPlan, isVehicleBrief, positionText, timelineRows, verdictText } from '../lib/termin-plan'
import { previewGeometry } from '../lib/route-preview'
import type { BriefStop, TerminPlan, VehicleBrief } from '../types/assistant'

/** A calculation from the assistant: a Termin plan, a vehicle brief, or any other preview as a plain list. */
export function AssistantResultCard({ value, now = new Date(), onShowMap }: { value: unknown; now?: Date; onShowMap?: (value: unknown) => void }) {
  if (isTerminPlan(value)) return <TerminPlanCard plan={value} now={now} onShowMap={onShowMap} />
  if (isVehicleBrief(value)) return <VehicleBriefCard brief={value} />
  return <>
    <Preview value={value} />
    {onShowMap && previewGeometry(value).length > 1 ? <button type="button" className="secondary-button" onClick={() => onShowMap(value)}>Показать на карте</button> : null}
  </>
}

function TerminPlanCard({ plan, now, onShowMap }: { plan: TerminPlan; now: Date; onShowMap?: (value: unknown) => void }) {
  const rows = timelineRows(plan, now)
  const target = plan.stops[plan.target.index]
  return <div className="termin-plan">
    <p className="termin-plan-target">{plan.target.label}{plan.target.appointmentAt ? ` · текущий Termin ${plan.candidates.find((c) => c.label === 'Текущий Termin')?.atLocal ?? ''}` : plan.target.terminRequired ? ' · Termin нужен' : ''}</p>
    {plan.recommendation.terminAt ? <div className="termin-recommend" role="status">
      <strong>Рекомендуемый Termin: {plan.recommendation.terminAtLocal}</strong>
      <span>{plan.recommendation.reason}</span>
      {plan.recommendation.afterDailyRest && plan.recommendation.restEndsAt ? <span className="termin-rest-note">Перед точкой суточный отдых: реально только после его окончания.</span> : null}
    </div> : <p className="termin-unknown" role="status">Время прибытия не определено: {plan.recommendation.reason}</p>}
    {target && target.earliestArrivalLocal ? <p className="termin-range">Прибытие от {target.earliestArrivalLocal} до {target.latestArrivalLocal} · старт {plan.start.atLocal} ({plan.start.label.toLowerCase()})</p> : null}
    {rows.length ? <ol className="termin-timeline" aria-label="Паузы и движение по порядку">
      {rows.map((row) => <li key={row.key} className={row.pause ? 'termin-pause' : row.type === 'DRIVE' ? 'termin-drive' : 'termin-stop'}>
        <time dateTime={row.time}>{row.time}</time><span>{row.text}{row.pause ? ` · до ${row.until}` : ''}</span>
      </li>)}
    </ol> : null}
    {plan.candidates.length ? <dl className="termin-candidates">
      {plan.candidates.map((candidate) => <div key={candidate.label} className={`termin-candidate-${candidate.verdict.toLowerCase()}`}><dt>{candidate.label}</dt><dd>{candidateText(candidate)}</dd></div>)}
    </dl> : null}
    {plan.stops.length > 1 ? <ul className="termin-stops">
      {plan.stops.map((stop, index) => <li key={`${stop.stopId ?? stop.label}-${index}`}>{stop.label}: {stop.earliestArrivalLocal ? `${stop.earliestArrivalLocal}–${stop.latestArrivalLocal}` : 'время не определено'}{stop.waitingMinutes ? ` · ожидание ${stop.waitingMinutes} мин` : ''}{stop.appointmentAt ? ` · ${verdictText(stop.verdict)}` : ''}</li>)}
    </ul> : null}
    {plan.warnings.length ? <ul className="termin-warnings" role="status">{plan.warnings.map((text) => <li key={text}>{text}</li>)}</ul> : null}
    {plan.notes.length ? <ul className="termin-notes">{plan.notes.map((text) => <li key={text}>{text}</li>)}</ul> : null}
    {onShowMap && previewGeometry(plan).length > 1 ? <button type="button" className="secondary-button" onClick={() => onShowMap(plan)}>Показать на карте</button> : null}
  </div>
}

function VehicleBriefCard({ brief }: { brief: VehicleBrief }) {
  const stops = (list: BriefStop[]) => <ul className="brief-stops">
    {list.map((stop) => <li key={stop.stopId} className={stop.completedAt ? 'brief-stop-done' : ''}>
      {stop.label}{stop.completedAt ? ' · завершена' : stop.arrivedAt ? ' · на точке' : ''}
      {stop.appointmentAtLocal ? ` · Termin ${stop.appointmentAtLocal}` : stop.terminRequired ? ' · Termin нужен' : ''}
      {!stop.completedAt && stop.eta?.earliestLocal ? ` · ETA ${stop.eta.earliestLocal}–${stop.eta.latestLocal}${stop.eta.preliminary ? ' (предварительно)' : ''}` : ''}
    </li>)}
  </ul>
  return <div className="vehicle-brief">
    <p><strong>Позиция:</strong> {positionText(brief.position)}{brief.manualStoppedAt ? ' · остановлена диспетчером' : ''}</p>
    <p><strong>Водитель:</strong> {brief.driver.summary}</p>
    {brief.activeTour ? <><p><strong>Тур {brief.activeTour.orderNumber}</strong></p>{stops(brief.activeTour.stops)}</> : <p>Активного тура нет.</p>}
    {brief.queuedTours.map((tour) => <div key={tour.tourId}><p><strong>В очереди: {tour.orderNumber}</strong>{tour.plannedStartAtLocal ? ` · старт ${tour.plannedStartAtLocal}` : ''}</p>{stops(tour.stops)}</div>)}
    {brief.issues.length ? <ul className="termin-warnings" role="status">{brief.issues.map((issue) => <li key={issue.id}>{issue.kind === 'BREAKDOWN' ? 'Поломка' : 'Заметка'}: {issue.description}</li>)}</ul> : null}
  </div>
}

const PREVIEW_LABELS: Record<string, string> = { before: 'Было', after: 'Станет', vehicle: 'Машина', vehicleNumber: 'Номер машины', address: 'Адрес', city: 'Город', stops: 'Точки', appointmentAt: 'Термин', estimatedArrivalAt: 'ETA', arrivalEarliestAt: 'Прибытие от', arrivalLatestAt: 'Прибытие до', departureEarliestAt: 'Выезд от', departureLatestAt: 'Выезд до', warnings: 'Предупреждения', summary: 'Итог', finishToday: 'Завершение сегодня', assumptions: 'Условия расчёта', notes: 'Примечания', reason: 'Причина', message: 'Сообщение', distanceMeters: 'Расстояние, м', durationSeconds: 'Время, сек', startAt: 'Начало', status: 'Статус', type: 'Тип', orderNumber: 'Auftrag', instructions: 'Примечания' }
const PREVIEW_HIDDEN = new Set(['geometry', 'payload', 'version', 'id', 'vehicleId', 'tourId', 'stopId', 'snapshot', 'expectedVersion', 'kind', 'trafficSegments', 'roadSegments', 'legs', 'routingProviders'])
/** Generic preview for proposals: every field as a label and a value. */
export function Preview({ value }: { value: unknown }) {
  if (value === null || value === undefined) return null
  if (typeof value !== 'object') return <span>{String(value)}</span>
  if (Array.isArray(value)) return <div className="dispatcher-preview-list">{value.map((item, index) => <div key={index}><Preview value={item} /></div>)}</div>
  return <dl className="dispatcher-preview">{Object.entries(value as Record<string, unknown>).filter(([key]) => !PREVIEW_HIDDEN.has(key)).map(([key, item]) => <div key={key}><dt>{PREVIEW_LABELS[key] || key}</dt><dd><Preview value={item} /></dd></div>)}</dl>
}
