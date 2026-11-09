import { useState } from 'react'

import { api, type StopCoordinateIssue } from '../lib/api'
import { stopTypeLabel } from '../lib/format'

/**
 * Admin check for stops drawn in the wrong town: every future stop is resolved again and the ones far from their
 * saved point are listed with the proposed place; fixing moves them and redraws the routes of their trucks.
 */
export function StopCoordinatesCheck() {
  const [issues, setIssues] = useState<StopCoordinateIssue[] | null>(null)
  const [busy, setBusy] = useState<'check' | 'fix' | null>(null)
  const [error, setError] = useState('')
  const [report, setReport] = useState('')

  async function check() {
    setBusy('check'); setError(''); setReport('')
    try { setIssues(await api.checkStopCoordinates()) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Проверка не удалась.') }
    finally { setBusy(null) }
  }
  async function fix(stopIds: string[]) {
    setBusy('fix'); setError('')
    try {
      const result = await api.fixStopCoordinates(stopIds)
      const fixedIds = new Set(result.fixed.map((issue) => issue.stopId))
      setIssues((current) => current?.filter((issue) => !fixedIds.has(issue.stopId)) ?? null)
      setReport([result.fixed.length ? `Исправлено точек: ${result.fixed.length}, маршруты пересчитаны.` : '',
        ...result.skipped.map((item) => `LKW ${item.vehicleNumber}: не исправлено — ${item.reason}`)].filter(Boolean).join(' '))
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Исправление не удалось.') }
    finally { setBusy(null) }
  }

  return <section className="settings-card" aria-labelledby="settings-stop-coordinates">
    <h3 id="settings-stop-coordinates" className="section-title">Координаты точек</h3>
    <p className="page-subtitle">Проверяет будущие точки активных и запланированных туров: если адрес сегодня находится дальше 40 км от сохранённой точки, маршрут рисуется не туда. Проверка занимает до пары минут.</p>
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" className="secondary-button" onClick={() => void check()} disabled={busy !== null}>{busy === 'check' ? 'Проверяем…' : 'Проверить точки'}</button>
      {issues?.length ? <button type="button" className="primary-button" onClick={() => void fix(issues.map((issue) => issue.stopId))} disabled={busy !== null}>{busy === 'fix' ? 'Исправляем…' : `Исправить все · ${issues.length}`}</button> : null}
    </div>
    {error ? <p className="quick-order-error" role="alert">{error}</p> : null}
    {report ? <p className="page-subtitle" role="status">{report}</p> : null}
    {issues && !issues.length && !report ? <p className="page-subtitle" role="status">Все точки на своих местах.</p> : null}
    {issues?.length ? <table className="rules-table">
      <thead><tr><th>Машина · тур</th><th>Точка</th><th>Сейчас</th><th>Должно быть</th><th><span className="sr-only">Действия</span></th></tr></thead>
      <tbody>{issues.map((issue) => <tr key={issue.stopId}>
        <td><strong>LKW {issue.vehicleNumber}</strong><span>{issue.orderNumber}{issue.tourStatus === 'QUEUED' ? ' · в очереди' : ''}</span></td>
        <td><strong>{stopTypeLabel(issue.type)} {issue.sequence}</strong><span>{[issue.company, issue.address, issue.city].filter(Boolean).join(', ')}</span></td>
        <td>{issue.current.resolvedAddress ?? `${issue.current.latitude.toFixed(3)}, ${issue.current.longitude.toFixed(3)}`}</td>
        <td><strong>{issue.proposed.resolvedAddress}</strong><span>{issue.distanceKm} км от текущей точки</span></td>
        <td><button type="button" className="secondary-button" onClick={() => void fix([issue.stopId])} disabled={busy !== null}>Исправить</button></td>
      </tr>)}</tbody>
    </table> : null}
  </section>
}
