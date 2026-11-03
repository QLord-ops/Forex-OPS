import { ArrowUpRight, Crosshair, X } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'

import { usePolling } from '../hooks/usePolling'
import { api } from '../lib/api'
import { classNames, formatDateTime, formatDelay, formatTime, shortAddress } from '../lib/format'
import { courseText, formatDurationMs, formatFuel, formatWholeKm, share, workState } from '../lib/telemetry-format'
import type { Coordinate, DashboardVehicle, DrivingTimes, VehicleCardData } from '../types/domain'
import './truck-card.css'

const TACHO_STALE_MS = 15 * 60_000

type Props = {
  vehicleId: string
  row: DashboardVehicle | null
  onClose: () => void
  onShowOnMap: (coordinate: Coordinate) => void
}

/** Webfleet-style truck card over the map: live position, driver and tachograph, vehicle data and the current tour. */
export function TruckCard({ vehicleId, row, onClose, onShowOnMap }: Props) {
  const { data, error, loading, refetch } = usePolling(() => api.vehicleCard(vehicleId), 30_000, true, vehicleId)
  const headingRef = useRef<HTMLHeadingElement | null>(null)

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

  const title = data?.webfleet?.plate || data?.webfleet?.objectNo || (row ? `LKW ${row.vehicle.vehicleNumber}` : 'Грузовик')
  const coordinate = data?.current?.coordinate ?? row?.mapPosition?.coordinate ?? null

  return (
    <aside className="truck-card" role="dialog" aria-modal="false" aria-labelledby="truck-card-title">
      <header className="truck-card-header">
        <div className="min-w-0">
          <h2 id="truck-card-title" ref={headingRef} tabIndex={-1} className="truck-card-title">{title}</h2>
          <p className="truck-card-subtitle">
            LKW {data?.vehicleNumber ?? row?.vehicle.vehicleNumber}
            {data?.currentTrailerPlate ? ` · прицеп ${data.currentTrailerPlate}` : ''}
          </p>
        </div>
        <SourceChip data={data} />
        <button type="button" className="icon-button icon-button-compact" onClick={onClose} aria-label="Закрыть карточку"><X className="h-4 w-4" /></button>
      </header>

      <div className="truck-card-body">
        {!data && loading ? <p className="truck-card-note">Загружаем данные машины…</p> : null}
        {error && !data ? <p className="truck-card-note truck-card-note-error" role="alert">Карточка не загрузилась. <button type="button" className="underline" onClick={() => void refetch()}>Повторить</button></p> : null}
        {data ? <>
          {data.webfleet ? <NowSection data={data} /> : (
            <section className="truck-card-section">
              <p className="truck-card-note">Машина не привязана к Webfleet: нет GPS, топлива и данных водителя. Привязку делает администратор в разделе <Link className="underline" to="/vehicles">«Грузовики»</Link>.</p>
            </section>
          )}
          {data.webfleet ? <DriverSection driver={data.driver} /> : null}
          {data.webfleet && data.current ? <VehicleSection data={data} /> : null}
        </> : null}
        {row ? <TourSection row={row} /> : null}
      </div>

      <footer className="truck-card-footer">
        <button type="button" className="secondary-button" disabled={!coordinate} onClick={() => coordinate && onShowOnMap(coordinate)}><Crosshair className="h-4 w-4" aria-hidden="true" />На карте</button>
        <Link className="primary-button" to={`/vehicles/${vehicleId}`}>Открыть LKW <ArrowUpRight className="h-4 w-4" aria-hidden="true" /></Link>
      </footer>
    </aside>
  )
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

function NowSection({ data }: { data: VehicleCardData }) {
  const current = data.current
  if (!current) return <section className="truck-card-section"><h3>Сейчас</h3><p className="truck-card-note">Webfleet ещё не прислал позицию этой машины.</p></section>
  const motion = current.standstill === true ? 'Стоит'
    : current.standstill === false ? `Едет${current.speedKmh !== null ? ` ${Math.round(current.speedKmh)} км/ч` : ''}${current.courseDeg !== null ? `, ${courseText(current.courseDeg)}` : ''}`
      : 'Движение неизвестно'
  return (
    <section className="truck-card-section" aria-label="Сейчас">
      <h3>Сейчас</h3>
      <p className="truck-card-lead">{motion}</p>
      {current.address ? <p className="truck-card-address">{current.address}</p> : null}
      <dl className="truck-card-facts">
        {current.ignitionOn !== null ? <Fact label="Зажигание" value={`${current.ignitionOn ? 'вкл.' : 'выкл.'}${current.ignitionChangedAt ? ` с ${timeOrDate(current.ignitionChangedAt)}` : ''}`} /> : null}
        <Fact label="Позиция" value={timeOrDate(current.recordedAt)} warn={current.stale} />
      </dl>
    </section>
  )
}

function DriverSection({ driver }: { driver: VehicleCardData['driver'] }) {
  if (!driver) return null
  if (driver.status === 'WAITING') return <section className="truck-card-section"><h3>Водитель</h3><p className="truck-card-note">Ждём данные Webfleet о водителе…</p></section>
  if (driver.status === 'NONE') return <section className="truck-card-section"><h3>Водитель</h3><p className="truck-card-note">Водитель не вошёл: карта водителя не вставлена.</p></section>
  const state = workState(driver.workState)
  return (
    <section className="truck-card-section" aria-label="Водитель">
      <h3>Водитель</h3>
      <div className="truck-card-driver">
        <span className="truck-card-lead">{driver.name || 'Имя не передано'}</span>
        <span className={classNames('truck-card-state', `truck-card-state-${state.tone}`)}><span aria-hidden="true" />{state.label}</span>
      </div>
      {driver.drivingTimes ? <Tachograph times={driver.drivingTimes} />
        : <p className="truck-card-note">{driver.drivingTimesStatus === 'UNAVAILABLE' ? 'Время вождения сейчас недоступно в Webfleet.'
          : driver.drivingTimesStatus === 'NO_DATA' ? 'Тахограф не передал время вождения для этого водителя.' : 'Ждём данные тахографа…'}</p>}
    </section>
  )
}

function Tachograph({ times }: { times: DrivingTimes }) {
  const shiftHours = times.shiftStartedAt && times.latestShiftEndAt
    ? Math.round((Date.parse(times.latestShiftEndAt) - Date.parse(times.shiftStartedAt)) / 3_600_000) : null
  const stale = times.referenceTime ? Date.now() - Date.parse(times.referenceTime) > TACHO_STALE_MS : true
  const usedToday = times.maxDrivingTodayMs && times.remainDrivingTodayMs !== null ? times.maxDrivingTodayMs - times.remainDrivingTodayMs : null
  return (
    <div className="truck-card-tacho">
      <Meter label="Вождение сегодня" value={`Осталось ${formatDurationMs(times.remainDrivingTodayMs)}${times.maxDrivingTodayMs ? ` из ${formatDurationMs(times.maxDrivingTodayMs)}` : ''}`}
        fill={share(usedToday, times.maxDrivingTodayMs)} warn={(times.remainDrivingTodayMs ?? 1) <= 30 * 60_000} />
      <dl className="truck-card-facts">
        {times.shiftStartedAt ? <Fact label="Смена" value={`начало ${timeOrDate(times.shiftStartedAt)}${times.latestShiftEndAt ? ` · закончить до ${timeOrDate(times.latestShiftEndAt)}` : ''}${shiftHours ? ` (${shiftHours} ч)` : ''}`} /> : null}
        <Fact label="Перерыв" value={times.nextBreakInMs === null ? 'сейчас перерыв' : `через ${formatDurationMs(times.nextBreakInMs)}${times.nextBreakMinMs ? `, не меньше ${formatDurationMs(times.nextBreakMinMs)}` : ''}`} warn={(times.nextBreakInMs ?? 1) < 0} />
        <Fact label="Отдых" value={times.nextRestInMs === null ? 'сейчас отдых' : `через ${formatDurationMs(times.nextRestInMs)}${times.nextRestMinMs ? `, не меньше ${formatDurationMs(times.nextRestMinMs)}` : ''}`} warn={(times.nextRestInMs ?? 1) < 0} />
        {times.earliestNextShiftAt ? <Fact label="След. смена" value={`не раньше ${timeOrDate(times.earliestNextShiftAt)}`} /> : null}
        <Fact label="Неделя" value={`осталось ${formatDurationMs(times.remainDrivingWeekMs)}${times.maxDrivingWeekMs ? ` из ${formatDurationMs(times.maxDrivingWeekMs)}` : ''}`} />
        <Fact label="Лимиты недели" value={`удлинённых дней ${times.extendedShiftsLeft ?? '–'} из ${times.maxExtendedShifts ?? '–'} · сокращ. отдыхов ${times.reducedRestsLeft ?? '–'} из ${times.maxReducedRests ?? '–'}`} />
      </dl>
      {times.infringements ? <p className="truck-card-alert" role="status">Тахограф фиксирует нарушение режима</p> : null}
      <p className={classNames('truck-card-meta', stale && 'truck-card-meta-warn')}>
        Тахограф Webfleet{times.referenceTime ? ` на ${timeOrDate(times.referenceTime)}` : ''}{stale ? ' · данные устарели' : ''} · ориентировочно
      </p>
    </div>
  )
}

function VehicleSection({ data }: { data: VehicleCardData }) {
  const current = data.current!
  return (
    <section className="truck-card-section" aria-label="Машина">
      <h3>Машина</h3>
      {current.fuelPercent !== null ? <Meter label="Топливо" value={formatFuel(current.fuelPercent, current.fuelLiters)} fill={current.fuelPercent / 100} warn={current.fuelPercent < 15} inverse /> : null}
      <dl className="truck-card-facts">
        <Fact label="Пробег" value={formatWholeKm(current.odometerKm)} />
        {current.engineHours !== null ? <Fact label="Моточасы" value={`${Math.round(current.engineHours).toLocaleString('ru-RU')} ч`} /> : null}
        {data.webfleet?.tankLiters ? <Fact label="Бак" value={`${data.webfleet.tankLiters} л`} /> : null}
        {data.webfleet?.vin ? <Fact label="VIN" value={data.webfleet.vin} mono /> : null}
      </dl>
    </section>
  )
}

function TourSection({ row }: { row: DashboardVehicle }) {
  return (
    <section className="truck-card-section" aria-label="Тур">
      <h3>Тур</h3>
      {row.tour ? <>
        <p className="truck-card-lead">{row.tour.orderNumber ?? 'Auftrag без номера'}</p>
        <dl className="truck-card-facts">
          <Fact label="Следующая точка" value={row.to ? shortAddress(row.to) : '–'} />
          <Fact label="ETA" value={formatDateTime(row.eta)} />
          <Fact label="Отклонение" value={formatDelay(row.delayMinutes)} warn={(row.delayMinutes ?? 0) > 0} />
        </dl>
      </> : <p className="truck-card-note">Нет активного тура.</p>}
    </section>
  )
}

function Meter({ label, value, fill, warn = false, inverse = false }: { label: string; value: string; fill: number; warn?: boolean; inverse?: boolean }) {
  return (
    <div className="truck-card-meter">
      <div className="truck-card-meter-text"><span>{label}</span><strong className={warn ? 'truck-card-warn' : ''}>{value}</strong></div>
      <span className={classNames('truck-card-bar', inverse && 'truck-card-bar-level', warn && 'truck-card-bar-warn')} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fill * 100)} aria-valuetext={value}>
        <span style={{ width: `${Math.round(fill * 100)}%` }} />
      </span>
    </div>
  )
}

function Fact({ label, value, warn = false, mono = false }: { label: string; value: string; warn?: boolean; mono?: boolean }) {
  return <div className="truck-card-fact"><dt>{label}</dt><dd className={classNames(warn && 'truck-card-warn', mono && 'font-mono')}>{value}</dd></div>
}

function timeOrDate(value: string) {
  const date = new Date(value)
  return date.toDateString() === new Date().toDateString() ? formatTime(value) : formatDateTime(value)
}
