import { ArrowUpRight, Bell, ClipboardList, History, Route, Truck, UserRound, Wrench, X, type LucideIcon } from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { Link } from 'react-router-dom'

import { usePolling } from '../hooks/usePolling'
import { AssignmentBar } from './AssignmentBar'
import { api } from '../lib/api'
import { classNames, formatDateTime, formatDelay, shortAddress, statusLabel, stopTypeLabel } from '../lib/format'
import { berlinClock, courseText, durationBetween, formatDurationMs, formatFuel, formatWholeKm, share, tripsWithParking, workState } from '../lib/telemetry-format'
import type { CardFeedStatus, Coordinate, DashboardVehicle, DrivingTimes, VehicleCardData } from '../types/domain'
import './truck-card.css'

const TACHO_STALE_MS = 15 * 60_000
const TAB_STORAGE_KEY = 'ops-truck-card-tab'

type TabId = 'vehicle' | 'driver' | 'tour' | 'events' | 'service' | 'trips'
const TABS: Array<{ id: TabId; label: string; icon: LucideIcon }> = [
  { id: 'vehicle', label: 'Машина', icon: Truck },
  { id: 'driver', label: 'Водитель', icon: UserRound },
  { id: 'tour', label: 'Тур', icon: ClipboardList },
  { id: 'events', label: 'События', icon: Bell },
  { id: 'service', label: 'Сервис', icon: Wrench },
  { id: 'trips', label: 'Поездки', icon: History }
]

type Props = {
  vehicleId: string
  row: DashboardVehicle | null
  onClose: () => void
  onTrack: (points: Coordinate[] | null) => void
}

/** Truck card: the same tabs and calculations a dispatcher knows from the telematics portal, in OPS styling. */
export function TruckCard({ vehicleId, row, onClose, onTrack }: Props) {
  const { data, error, loading, refetch } = usePolling(() => api.vehicleCard(vehicleId), 30_000, true, vehicleId)
  const [tab, setTab] = useState<TabId>(readTab)
  const [track, setTrack] = useState<'off' | 'loading' | 'on'>('off')
  const [trackError, setTrackError] = useState('')
  const headingRef = useRef<HTMLHeadingElement | null>(null)
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({})

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    headingRef.current?.focus()
    return () => { if (opener?.isConnected) opener.focus() }
  }, [])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.defaultPrevented) onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])
  // Another truck: its track is not loaded yet.
  useEffect(() => { setTrack('off'); setTrackError(''); onTrack(null) }, [vehicleId, onTrack])

  function selectTab(next: TabId, focus = false) {
    setTab(next)
    try { window.localStorage.setItem(TAB_STORAGE_KEY, next) } catch { /* per-viewer convenience only */ }
    if (focus) tabRefs.current[next]?.focus()
  }
  function onTabKey(event: ReactKeyboardEvent<HTMLDivElement>) {
    const index = TABS.findIndex((item) => item.id === tab)
    const next = event.key === 'ArrowRight' ? (index + 1) % TABS.length : event.key === 'ArrowLeft' ? (index - 1 + TABS.length) % TABS.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? TABS.length - 1 : null
    if (next === null) return
    event.preventDefault()
    selectTab(TABS[next].id, true)
  }
  async function toggleTrack() {
    if (track === 'on') { setTrack('off'); onTrack(null); return }
    setTrack('loading')
    setTrackError('')
    try {
      const result = await api.vehicleTrack(vehicleId)
      onTrack(result.points)
      setTrack('on')
      if (!result.points.length) setTrackError('За сегодня точек трека нет.')
    } catch (cause) {
      setTrack('off')
      setTrackError(cause instanceof Error ? cause.message : 'Трек не загрузился.')
    }
  }

  const title = data?.webfleet?.plate || data?.webfleet?.objectNo || (row ? `LKW ${row.vehicle.vehicleNumber}` : 'Грузовик')
  const unresolved = data?.events?.unresolved ?? 0

  return (
    <aside className="truck-card" role="dialog" aria-modal="false" aria-labelledby="truck-card-title">
      <header className="truck-card-header">
        <div className="min-w-0">
          <h2 id="truck-card-title" ref={headingRef} tabIndex={-1} className="truck-card-title">{title}</h2>
          <p className="truck-card-subtitle">
            {[data?.webfleet?.objectName, `LKW ${data?.vehicleNumber ?? row?.vehicle.vehicleNumber ?? ''}`, row ? statusLabel(row.statusText) : null].filter(Boolean).join(' · ')}
          </p>
        </div>
        <SourceChip data={data} />
        <button type="button" className="icon-button icon-button-compact" onClick={onClose} aria-label="Закрыть карточку"><X className="h-4 w-4" /></button>
      </header>
      {row ? <AssignmentBar row={row} /> : null}

      <div className="truck-card-tabs" role="tablist" aria-label="Разделы карточки" onKeyDown={onTabKey}>
        {TABS.map(({ id, label, icon: Icon }) => (
          <button key={id} ref={(node) => { tabRefs.current[id] = node }} type="button" role="tab" id={`truck-tab-${id}`} aria-controls="truck-card-panel"
            aria-selected={tab === id} tabIndex={tab === id ? 0 : -1} className="truck-card-tab" onClick={() => selectTab(id)}>
            <span className="truck-card-tab-icon"><Icon className="h-4 w-4" aria-hidden="true" />{id === 'events' && unresolved > 0 ? <span className="truck-card-badge" aria-label={`${unresolved} открытых`}>{unresolved > 99 ? '99+' : unresolved}</span> : null}</span>
            <span>{label}</span>
          </button>
        ))}
      </div>

      <div className="truck-card-body" id="truck-card-panel" role="tabpanel" aria-labelledby={`truck-tab-${tab}`} tabIndex={0}>
        {!data && loading ? <p className="truck-card-note truck-card-pad">Загружаем данные машины…</p> : null}
        {error && !data ? <p className="truck-card-note truck-card-note-error" role="alert">Карточка не загрузилась. <button type="button" className="underline" onClick={() => void refetch()}>Повторить</button></p> : null}
        {data && tab === 'tour' ? <TourTab row={row} /> : null}
        {data && tab !== 'tour' && !data.webfleet ? <Unbound /> : null}
        {data?.webfleet && tab === 'vehicle' ? <VehicleTab data={data} onDriver={() => selectTab('driver')} /> : null}
        {data?.webfleet && tab === 'driver' ? <DriverTab driver={data.driver} /> : null}
        {data?.webfleet && tab === 'events' ? <EventsTab events={data.events} /> : null}
        {data?.webfleet && tab === 'service' ? <ServiceTab maintenance={data.maintenance} /> : null}
        {data?.webfleet && tab === 'trips' ? <TripsTab trips={data.trips} /> : null}
      </div>

      <footer className="truck-card-footer">
        {trackError ? <p className="truck-card-footer-note" role="status">{trackError}</p> : null}
        <button type="button" className="secondary-button" disabled={!data?.webfleet || track === 'loading'} aria-pressed={track === 'on'} onClick={() => void toggleTrack()}>
          <Route className="h-4 w-4" aria-hidden="true" />{track === 'on' ? 'Скрыть трек' : track === 'loading' ? 'Загружаем…' : 'Трек за сегодня'}
        </button>
        <Link className="primary-button" to={`/vehicles/${vehicleId}`}>Открыть LKW <ArrowUpRight className="h-4 w-4" aria-hidden="true" /></Link>
      </footer>
    </aside>
  )
}

function readTab(): TabId {
  try {
    const saved = window.localStorage.getItem(TAB_STORAGE_KEY)
    return TABS.some((item) => item.id === saved) ? saved as TabId : 'vehicle'
  } catch { return 'vehicle' }
}

function SourceChip({ data }: { data: VehicleCardData | null }) {
  const current = data?.current
  if (!data) return null
  if (!current) return <span className="truck-card-chip truck-card-chip-calculated">Без GPS</span>
  const minutes = Math.max(0, Math.round(current.ageSeconds / 60))
  return current.stale
    ? <span className="truck-card-chip truck-card-chip-stale" title={`Последняя позиция ${formatDateTime(current.recordedAt)}`}>GPS устарел · {minutes} мин</span>
    : <span className="truck-card-chip truck-card-chip-live">GPS · {minutes < 1 ? 'сейчас' : `${minutes} мин`}</span>
}

function Unbound() {
  return <Section title="Webfleet"><p className="truck-card-note">Машина не привязана к Webfleet: нет GPS, тахографа и поездок. Привязку делает администратор в разделе <Link className="underline" to="/vehicles">«Грузовики»</Link>.</p></Section>
}

function VehicleTab({ data, onDriver }: { data: VehicleCardData; onDriver: () => void }) {
  const current = data.current
  const driver = data.driver
  const motion = !current ? '' : current.standstill === true ? 'Стоит'
    : current.standstill === false ? `Едет${current.speedKmh !== null ? ` ${Math.round(current.speedKmh)} км/ч` : ''}${current.courseDeg !== null ? `, ${courseText(current.courseDeg)}` : ''}` : 'Движение неизвестно'
  return <>
    <Section title="Позиция">
      {current ? <>
        <p className="truck-card-lead">{motion}</p>
        <p className="truck-card-address"><span className="tabular-nums">{berlinClock(current.recordedAt)}</span>{current.address ? ` · ${current.address}` : ''}</p>
        {current.businessTrip ? <span className="truck-card-tag">Служебная поездка</span> : null}
      </> : <p className="truck-card-note">Webfleet ещё не прислал позицию этой машины.</p>}
    </Section>
    <Section title="Водитель">
      <div className="truck-card-driver">
        <span className="truck-card-lead">{driver?.status === 'SIGNED_ON' ? driver.name || 'Имя не передано' : driver?.status === 'NONE' ? 'Не вошёл' : 'Ждём данные…'}</span>
        {driver?.status === 'SIGNED_ON' ? <WorkState code={driver.workState} /> : null}
      </div>
      {driver?.status === 'SIGNED_ON' ? <button type="button" className="truck-card-link" onClick={onDriver}>Время вождения и отдыха</button> : null}
    </Section>
    {current ? <Section title="Состояние">
      <div className="truck-card-grid">
        <Cell label="Зажигание" value={`${current.ignitionOn === null ? '–' : current.ignitionOn ? 'вкл.' : 'выкл.'}${current.ignitionChangedAt ? ` с ${berlinClock(current.ignitionChangedAt)}` : ''}`} />
        <Cell label="Пробег" value={formatWholeKm(current.odometerKm)} />
        <Cell label="Топливо" value={formatFuel(current.fuelPercent, current.fuelLiters)} warn={(current.fuelPercent ?? 100) < 15} />
        <Cell label="Моточасы" value={current.engineHours !== null ? formatDurationMs(current.engineHours * 3_600_000) : '–'} />
      </div>
    </Section> : null}
    <Section title="Прицеп">
      <div className="truck-card-grid">
        <Cell label="По туру OPS" value={data.currentTrailerPlate ?? '–'} />
        <Cell label="Сцепка Webfleet" value={data.coupling?.status === 'OK' ? (data.coupling.assetUid ? `${data.coupling.assetNo ?? 'прицеп'}${data.coupling.coupledAt ? ` с ${berlinClock(data.coupling.coupledAt)}` : ''}` : 'нет') : data.coupling?.status === 'UNAVAILABLE' ? 'недоступно' : 'ждём…'} />
      </div>
    </Section>
    {data.webfleet?.vin || data.webfleet?.tankLiters ? <Section title="Данные машины">
      <div className="truck-card-grid">
        {data.webfleet.vin ? <Cell label="VIN" value={data.webfleet.vin} mono /> : null}
        {data.webfleet.tankLiters ? <Cell label="Бак" value={`${data.webfleet.tankLiters} л`} /> : null}
      </div>
    </Section> : null}
  </>
}

function DriverTab({ driver }: { driver: VehicleCardData['driver'] }) {
  if (!driver || driver.status === 'WAITING') return <Section title="Водитель"><p className="truck-card-note">Ждём данные Webfleet о водителе…</p></Section>
  if (driver.status === 'NONE') return <Section title="Водитель"><p className="truck-card-note">Водитель не вошёл: карта водителя не вставлена.</p></Section>
  const times = driver.drivingTimes
  return <>
    <Section title="Водитель">
      <div className="truck-card-driver"><span className="truck-card-lead">{driver.name || 'Имя не передано'}</span></div>
    </Section>
    <Section title="Текущий статус">
      <div className="truck-card-activity">
        <WorkState code={driver.workState} />
        <span className="truck-card-muted">по тахографу{driver.activitySince ? ` · с ${berlinClock(driver.activitySince)} (${durationBetween(driver.activitySince, new Date())})` : ''}</span>
      </div>
      {times ? <>
        <Meter label="Остаток вождения" value={formatDurationMs(times.remainDrivingTodayMs)} max={times.maxDrivingTodayMs ? formatDurationMs(times.maxDrivingTodayMs) : null}
          fill={share(times.remainDrivingTodayMs, times.maxDrivingTodayMs)} warn={(times.remainDrivingTodayMs ?? 1) <= 30 * 60_000} />
        <div className="truck-card-grid">
          <Cell label="Рабочее время всего" value={formatDurationMs((times.totalDrivingTodayMs ?? 0) + (times.totalOtherWorkTodayMs ?? 0) + (times.totalAvailabilityTodayMs ?? 0))} />
          <Cell label="Вождение" value={formatDurationMs(times.totalDrivingTodayMs)} />
          <Cell label="Другая работа" value={formatDurationMs(times.totalOtherWorkTodayMs)} />
          <Cell label="Готовность" value={formatDurationMs(times.totalAvailabilityTodayMs)} />
        </div>
        {times.lastCardActivityAt ? <p className="truck-card-meta">Последняя выгрузка карты водителя: {berlinClock(times.lastCardActivityAt)}</p> : null}
        {times.infringements ? <p className="truck-card-alert" role="status">Тахограф фиксирует нарушение режима</p> : null}
      </> : <p className="truck-card-note">{driver.drivingTimesStatus === 'UNAVAILABLE' ? 'Время вождения сейчас недоступно в Webfleet.'
        : driver.drivingTimesStatus === 'NO_DATA' ? 'Тахограф не передал время вождения для этого водителя.' : 'Ждём данные тахографа…'}</p>}
    </Section>
    {times ? <Tachograph times={times} /> : null}
    {driver.optiDrive !== null ? <Section title="Стиль вождения (OptiDrive)">
      <Meter label="За 7 дней" value={driver.optiDrive.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} max="10" fill={driver.optiDrive / 10} level />
    </Section> : null}
  </>
}

function Tachograph({ times }: { times: DrivingTimes }) {
  const stale = times.referenceTime ? Date.now() - Date.parse(times.referenceTime) > TACHO_STALE_MS : true
  const late = (at: string | null) => Boolean(at && Date.parse(at) < Date.now())
  return <>
    <Section title="Перерывы и отдых">
      <div className="truck-card-grid truck-card-grid-wide">
        <Cell label="Следующий перерыв" value={times.nextBreakAt ? `до ${berlinClock(times.nextBreakAt)}${times.nextBreakMinMs ? ` (не меньше ${formatDurationMs(times.nextBreakMinMs)})` : ''}` : 'сейчас перерыв'} warn={late(times.nextBreakAt)} />
        <Cell label="Ежедневный отдых" value={times.nextRestAt ? `до ${berlinClock(times.nextRestAt)}${times.nextRestMinMs ? ` (не меньше ${formatDurationMs(times.nextRestMinMs)})` : ''}` : 'сейчас отдых'} warn={late(times.nextRestAt)} />
      </div>
    </Section>
    <Section title="Рабочая смена">
      <div className="truck-card-grid">
        <Cell label="Начало смены" value={berlinClock(times.shiftStartedAt)} />
        <Cell label="Закончить не позже" value={berlinClock(times.latestShiftEndAt)} />
        <Cell label="Следующая смена не раньше" value={berlinClock(times.earliestNextShiftAt)} />
      </div>
    </Section>
    <Section title="Текущая неделя">
      <Meter label="Остаток вождения" value={formatDurationMs(times.remainDrivingWeekMs)} max={times.maxDrivingWeekMs ? formatDurationMs(times.maxDrivingWeekMs) : null} fill={share(times.remainDrivingWeekMs, times.maxDrivingWeekMs)} />
      <div className="truck-card-grid">
        <Allowance label="Удлинённое вождение" hint="день до 10 ч" chip="10 ч" max={times.maxExtendedShifts} used={times.extendedShiftsUsed} />
        <Allowance label="Удлинённый рабочий день" hint="отдых меньше 11 ч" chip="<11 ч" max={times.maxReducedRests} used={times.reducedRestsUsed} />
      </div>
    </Section>
    <Section title="Компенсация сокращённого недельного отдыха">
      {times.restBalances.length ? <ul className="truck-card-list">{times.restBalances.map((item) => <li key={item.until}>{formatDurationMs(item.ms)} до {berlinClock(item.until)}</li>)}</ul> : <p className="truck-card-note">Не требуется</p>}
      <p className={classNames('truck-card-meta', stale && 'truck-card-meta-warn')}>Тахограф{times.referenceTime ? ` на ${berlinClock(times.referenceTime)}` : ''}{stale ? ' · данные устарели' : ''} · данные Webfleet ориентировочные</p>
    </Section>
  </>
}

function Allowance({ label, hint, chip, max, used }: { label: string; hint: string; chip: string; max: number | null; used: number | null }) {
  if (!max) return <Cell label={label} value="–" />
  const free = Math.max(0, max - (used ?? 0))
  return <div className="truck-card-cell">
    <span className="truck-card-cell-label">{label} <span className="truck-card-hint">({hint})</span></span>
    <span className="truck-card-allowance-count"><strong>{free}</strong> из {max} <span>осталось на неделе</span></span>
    <span className="truck-card-chips" aria-label={`${label}: доступно ${free} из ${max}`}>
      {Array.from({ length: max }, (_, index) => <span key={index} className={classNames('truck-card-allowance', index >= free && 'truck-card-allowance-used')}>{chip}</span>)}
    </span>
  </div>
}

function TourTab({ row }: { row: DashboardVehicle | null }) {
  if (!row?.tour) return <Section title="Тур"><p className="truck-card-note">Нет активного тура.</p></Section>
  const stops = (row.tour.stops ?? []).slice().sort((a, b) => a.sequence - b.sequence)
  return <>
    <Section title="Auftrag">
      <p className="truck-card-lead">{row.tour.orderNumber ?? 'Без номера'}</p>
      <div className="truck-card-grid">
        <Cell label="Следующая точка" value={row.to ? shortAddress(row.to) : '–'} />
        <Cell label="ETA" value={formatDateTime(row.eta)} />
        <Cell label="Срок" value={formatDateTime(row.appointmentAt)} />
        <Cell label="Отклонение" value={formatDelay(row.delayMinutes)} warn={(row.delayMinutes ?? 0) > 0} />
      </div>
    </Section>
    {stops.length ? <Section title="Точки">
      <ol className="truck-card-stops">
        {stops.map((stop) => <li key={stop.id} className={classNames(stop.completedAt && 'truck-card-stop-done')}>
          <span className="truck-card-stop-seq">{stop.sequence}</span>
          <span className="min-w-0"><strong>{stopTypeLabel(stop.type)} · {shortAddress(stop)}</strong><span className="truck-card-muted">{stop.completedAt ? `готово ${formatDateTime(stop.completedAt)}` : stop.appointmentAt ? `срок ${formatDateTime(stop.appointmentAt)}` : 'без срока'}</span></span>
        </li>)}
      </ol>
    </Section> : null}
  </>
}

const EVENT_LEVELS = { ALARM: 'Тревога', WARNING: 'Предупреждение', INFO: 'Информация' } as const

function EventsTab({ events }: { events: VehicleCardData['events'] }) {
  if (!events) return null
  return <Section title={`События за неделю · ${events.items.length}`}>
    <FeedNote status={events.status} empty={!events.items.length} emptyText="Событий за неделю нет." />
    <ul className="truck-card-feed">
      {events.items.map((event) => <li key={event.id} className={classNames('truck-card-event', `truck-card-event-${event.level.toLowerCase()}`)}>
        <span className="truck-card-event-level"><span aria-hidden="true" />{EVENT_LEVELS[event.level]}{event.resolved ? ' · закрыто' : ''}</span>
        <span className="truck-card-event-time tabular-nums">{berlinClock(event.at)}</span>
        <p>{event.text}</p>
        {event.address ? <p className="truck-card-muted">{event.address}</p> : null}
      </li>)}
    </ul>
  </Section>
}

function ServiceTab({ maintenance }: { maintenance: VehicleCardData['maintenance'] }) {
  if (!maintenance) return null
  return <Section title="Обслуживание">
    <FeedNote status={maintenance.status} empty={!maintenance.items.length} emptyText="В Webfleet нет графиков обслуживания для этой машины." />
    <ul className="truck-card-feed">
      {maintenance.items.map((item, index) => <li key={`${item.name}-${index}`}>
        <strong>{item.name}</strong>
        <p className="truck-card-muted">{[item.dueAt ? `до ${formatDateTime(item.dueAt)}` : null, item.dueOdometerKm ? `при ${formatWholeKm(item.dueOdometerKm)}` : null].filter(Boolean).join(' · ') || 'срок не задан'}</p>
        {item.description ? <p className="truck-card-muted">{item.description}</p> : null}
      </li>)}
    </ul>
  </Section>
}

function TripsTab({ trips }: { trips: VehicleCardData['trips'] }) {
  if (!trips) return null
  return <Section title="Поездки за вчера и сегодня">
    <FeedNote status={trips.status} empty={!trips.items.length} emptyText="Поездок за вчера и сегодня нет." />
    <ol className="truck-card-trips">
      {tripsWithParking(trips.items).map(({ trip, parkedMs }) => <li key={trip.id}>
        <article className="truck-card-trip">
          <TripPoint at={trip.endAt} address={trip.endAddress} end />
          <TripPoint at={trip.startAt} address={trip.startAddress} />
          <p className="truck-card-muted">{trip.distanceKm !== null ? `${trip.distanceKm.toLocaleString('ru-RU')} км` : ''}{trip.businessTrip ? ' · служебная' : ''}</p>
        </article>
        {parkedMs ? <p className="truck-card-parking"><span aria-hidden="true">P</span>Стоянка {formatDurationMs(parkedMs)}</p> : null}
      </li>)}
    </ol>
  </Section>
}

function TripPoint({ at, address, end = false }: { at: string | null; address: string | null; end?: boolean }) {
  return <div className="truck-card-trip-point">
    <span className="truck-card-trip-time tabular-nums">{at ? berlinClock(at) : 'в пути'}</span>
    <span className={classNames('truck-card-trip-dot', end && 'truck-card-trip-dot-end')} aria-hidden="true" />
    <span className="min-w-0">{address ?? (at ? 'адрес не передан' : 'поездка продолжается')}</span>
  </div>
}

function FeedNote({ status, empty, emptyText }: { status: CardFeedStatus; empty: boolean; emptyText: string }) {
  if (status === 'WAITING') return <p className="truck-card-note">Ждём данные Webfleet…</p>
  if (status === 'UNAVAILABLE' && empty) return <p className="truck-card-note">Webfleet сейчас не отдаёт эти данные. Повторим автоматически.</p>
  return empty ? <p className="truck-card-note">{emptyText}</p> : null
}

function WorkState({ code }: { code: number | null }) {
  const state = workState(code)
  return <span className={classNames('truck-card-state', `truck-card-state-${state.tone}`)}><span aria-hidden="true" />{state.label}</span>
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section className="truck-card-section" aria-label={title}><h3>{title}</h3>{children}</section>
}

function Meter({ label, value, max, fill, warn = false, level = false }: { label: string; value: string; max: string | null; fill: number; warn?: boolean; level?: boolean }) {
  const text = max ? `${value} из ${max}` : value
  return (
    <div className="truck-card-meter">
      <div className="truck-card-meter-text"><span>{label}</span><strong className={warn ? 'truck-card-warn' : ''}>{text}</strong></div>
      <span className={classNames('truck-card-bar', level && 'truck-card-bar-level', warn && 'truck-card-bar-warn')} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fill * 100)} aria-valuetext={text}>
        <span style={{ width: `${Math.round(fill * 100)}%` }} />
      </span>
    </div>
  )
}

function Cell({ label, value, warn = false, mono = false }: { label: string; value: string; warn?: boolean; mono?: boolean }) {
  return <div className="truck-card-cell"><span className="truck-card-cell-label">{label}</span><span className={classNames('truck-card-cell-value', warn && 'truck-card-warn', mono && 'font-mono')}>{value}</span></div>
}
