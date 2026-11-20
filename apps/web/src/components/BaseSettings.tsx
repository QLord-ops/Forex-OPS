import { useCallback, useEffect, useState } from 'react'

import { api } from '../lib/api'
import { weekdayClock, weekKey, weekLabel } from '../lib/base-visit'
import { berlinLocalToIso, isoToBerlinLocal } from '../lib/berlin-time'
import type { BasePlace, BaseWeek } from '../types/domain'
import { SettingsSection } from './SettingsSection'

/**
 * The base and the weekly list (owner, 20.11): every other week a truck comes home and stands until Monday morning.
 * Which trucks, the owner says week by week; the admin pastes the numbers here.
 */
export function BaseSettings() {
  const [weeks] = useState(() => [weekKey(), weekKey(Date.now(), 1)])
  const [week, setWeek] = useState(weeks[0])
  const [place, setPlace] = useState<BasePlace | null>(null)
  const [address, setAddress] = useState('')
  const [found, setFound] = useState<BasePlace | null>(null)
  const [list, setList] = useState<BaseWeek | null>(null)
  const [trucks, setTrucks] = useState('')
  const [due, setDue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [report, setReport] = useState('')

  const show = useCallback((data: BaseWeek) => {
    setList(data)
    setTrucks(data.trucks.map((truck) => truck.vehicleNumber).join(', '))
    setDue(isoToBerlinLocal(data.dueAt))
  }, [])
  useEffect(() => {
    let live = true
    api.base(week).then((data) => {
      if (!live) return
      setPlace(data.place); setAddress((current) => current || data.place?.address || ''); show(data.week)
    }).catch(() => { if (live) setError('База не загрузилась.') })
    return () => { live = false }
  }, [week, show])

  async function run(action: () => Promise<void>, fallback: string) {
    setBusy(true); setError(''); setReport('')
    try { await action() }
    catch (cause) { setError(cause instanceof Error ? cause.message : fallback) }
    finally { setBusy(false) }
  }
  const find = () => run(async () => {
    const result = await api.geocode(address.trim())
    setFound({ address: result.address, latitude: result.latitude, longitude: result.longitude, radiusMeters: place?.radiusMeters ?? 500 })
  }, 'Адрес не найден.')
  const savePlace = () => run(async () => {
    if (!found) return
    setPlace(await api.saveBase(found)); setFound(null); setReport('Адрес базы сохранён.')
  }, 'Адрес не сохранён.')
  const saveWeek = () => run(async () => {
    const result = await api.saveBaseWeek(week, { trucks, dueAt: due ? berlinLocalToIso(due) : null })
    show(result)
    setReport([`В списке машин: ${result.trucks.length}.`, result.added?.length ? `Добавлены: ${result.added.join(', ')}.` : '', result.removed?.length ? `Сняты: ${result.removed.join(', ')}.` : ''].filter(Boolean).join(' '))
    if (result.unknown?.length) setError(`Не нашлись машины с номерами: ${result.unknown.join(', ')}. Остальные сохранены.`)
    window.dispatchEvent(new CustomEvent('ops:data-changed'))
  }, 'Список не сохранён.')

  return <SettingsSection id="base" titleId="settings-base" title="База и заезды" scope="admin"
    subtitle="Машины из списка недели едут на базу и стоят там до утра понедельника. На главной у них метка «на базу», заезд записывается сам по свежему GPS Webfleet: машина простояла на базе 20 минут.">
    <div className="grid gap-2">
      <label className="block"><span className="field-label">Адрес базы</span>
        <input className="field-input" value={address} maxLength={200} placeholder="Улица и номер дома, 37154 Northeim" onChange={(event) => { setAddress(event.target.value); setFound(null) }} /></label>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="secondary-button" disabled={busy || address.trim().length < 5} onClick={() => void find()}>Найти на карте</button>
        {found ? <button type="button" className="primary-button" disabled={busy} onClick={() => void savePlace()}>Сохранить этот адрес</button> : null}
      </div>
      {found ? <p className="page-subtitle" role="status">Найдено: {found.address} ({found.latitude.toFixed(4)}, {found.longitude.toFixed(4)}). Проверьте и сохраните.</p> : null}
      {place && !found ? <p className="page-subtitle">Сейчас: {place.address} · зона {place.radiusMeters} м</p> : null}
      {!place && !found ? <p className="quick-order-error" role="status">Адрес базы не задан: заезд по GPS не записывается, и «успевает ли на базу» не считается.</p> : null}
    </div>

    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Неделя">
        {weeks.map((key, index) => <button key={key} type="button" className={key === week ? 'filter-chip filter-chip-active' : 'filter-chip'} aria-pressed={key === week} onClick={() => setWeek(key)}>
          {index === 0 ? 'Эта неделя' : 'Следующая'} · {weekLabel(key)}</button>)}
      </div>
      <label className="block"><span className="field-label">Номера машин через запятую или с новой строки</span>
        <textarea className="field-input" rows={3} value={trucks} maxLength={2000} placeholder="125, 997, 430" onChange={(event) => setTrucks(event.target.value)} /></label>
      <label className="block"><span className="field-label">Быть на базе к (время Берлина)</span>
        <input className="field-input" type="datetime-local" value={due} onChange={(event) => setDue(event.target.value)} /></label>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="primary-button" disabled={busy} onClick={() => void saveWeek()}>{busy ? 'Сохраняем…' : 'Сохранить список'}</button>
        {list ? <span className="page-subtitle">Снова работают с {weekdayClock(list.freeAt)}</span> : null}
      </div>
    </div>
    {error ? <p className="quick-order-error" role="alert">{error}</p> : null}
    {report ? <p className="page-subtitle" role="status">{report}</p> : null}
    {list?.trucks.length ? <table className="rules-table" role="table">
      <thead><tr role="row"><th role="columnheader">Машина</th><th role="columnheader">На базе</th></tr></thead>
      <tbody>{list.trucks.map((truck) => <tr key={truck.id} role="row">
        <td role="cell"><strong>LKW {truck.vehicleNumber}</strong>{truck.licensePlate ? <span>{truck.licensePlate}</span> : null}</td>
        <td role="cell">{truck.arrivedAt ? `с ${weekdayClock(truck.arrivedAt)} · ${truck.arrivedSource === 'WEBFLEET_AUTO' ? 'GPS Webfleet' : 'отметил диспетчер'}` : 'ещё нет'}</td>
      </tr>)}</tbody>
    </table> : null}
  </SettingsSection>
}
