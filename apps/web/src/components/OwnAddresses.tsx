import { useCallback, useEffect, useState } from 'react'

import { addressBookApi, type OwnAddressRow } from '../lib/address-book'
import { currentDispatcherRole } from '../lib/auth'

/**
 * The fleet's own address book: exact addresses of confirmed Auftrag and tours. Everybody can look an address up;
 * the admin hides a wrong one and collects the addresses of tours saved before the book existed.
 */
export function OwnAddresses() {
  const admin = currentDispatcherRole() === 'admin'
  const [query, setQuery] = useState('')
  const [rows, setRows] = useState<OwnAddressRow[]>([])
  const [total, setTotal] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [found, setFound] = useState<number | null>(null)

  const load = useCallback(async (text: string) => {
    setError('')
    try { const result = await addressBookApi.own(text); setRows(Array.isArray(result?.addresses) ? result.addresses : []); setTotal(typeof result?.total === 'number' ? result.total : null) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Адреса не загружены.') }
  }, [])
  useEffect(() => {
    const timer = window.setTimeout(() => { void load(query) }, query ? 250 : 0)
    return () => window.clearTimeout(timer)
  }, [query, load])

  async function run(work: () => Promise<void>) {
    setBusy(true); setError(''); setMessage('')
    try { await work() } catch (cause) { setError(cause instanceof Error ? cause.message : 'Не получилось. Повторите позже.') } finally { setBusy(false) }
  }
  const toggle = (row: OwnAddressRow) => run(async () => { await addressBookApi.setOwnActive(row.id, !row.active); await load(query) })
  const count = () => run(async () => {
    const result = await addressBookApi.backfillOwn(false)
    setFound(result.added)
    if (!result.added) setMessage('В прошлых турах новых адресов нет.')
  })
  const collect = () => run(async () => {
    const result = await addressBookApi.backfillOwn(true)
    setFound(null); setMessage(`Добавлено адресов: ${result.added}.`)
    await load(query)
  })

  return <section className="settings-card" aria-labelledby="settings-own-addresses">
    <h3 id="settings-own-addresses" className="section-title">Адреса из Auftrag{total !== null ? `: ${total}` : ''}</h3>
    <p className="page-subtitle">Точные адреса подтверждённых Auftrag и туров. Подсказываются при вводе адреса с пометкой «из Auftrag» и сразу дают точку на карте при разборе следующего Auftrag.</p>
    <label className="block"><span className="field-label">Поиск по фирме, улице или городу</span>
      <input className="field-input" value={query} maxLength={120} onChange={(event) => setQuery(event.target.value)} /></label>
    {rows.length ? <ul className="own-address-list">{rows.map((row) => <li key={row.id} className={row.active ? '' : 'own-address-hidden'}>
      <div className="min-w-0"><strong>{row.name}</strong><span>{[row.street, [row.postalCode, row.city].filter(Boolean).join(' ')].filter(Boolean).join(', ')}</span>
        <span>{row.active ? `использован ${row.useCount} раз` : 'скрыт из подсказок'}{row.groups ? ` · ${row.groups}` : ''}</span></div>
      {admin ? <button type="button" className="secondary-button" disabled={busy} onClick={() => void toggle(row)}>{row.active ? 'Скрыть' : 'Вернуть'}</button> : null}
    </li>)}</ul> : <p className="page-subtitle" role="status">{query ? 'Ничего не найдено.' : 'Пока пусто: адреса появятся после первого подтверждённого Auftrag.'}</p>}
    {admin ? <div className="own-address-backfill">
      {found ? <p role="status">Найдено новых адресов в прошлых турах: {found}. Это запись в базу — сначала сделайте backup.</p> : null}
      {found ? <div className="flex flex-wrap gap-2"><button type="button" className="primary-button" disabled={busy} onClick={() => void collect()}>Добавить {found}</button>
        <button type="button" className="secondary-button" disabled={busy} onClick={() => setFound(null)}>Не добавлять</button></div>
        : <button type="button" className="secondary-button" disabled={busy} onClick={() => void count()}>{busy ? 'Считаем…' : 'Собрать из прошлых туров'}</button>}
    </div> : null}
    {message ? <p className="page-subtitle" role="status">{message}</p> : null}
    {error ? <p className="quick-order-error" role="alert">{error}</p> : null}
  </section>
}
