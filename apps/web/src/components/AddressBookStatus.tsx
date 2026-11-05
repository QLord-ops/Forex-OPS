import { BookMarked, RefreshCw } from 'lucide-react'
import { useState } from 'react'

import { usePolling } from '../hooks/usePolling'
import { addressBookApi } from '../lib/address-book'
import { currentDispatcherRole } from '../lib/auth'
import { formatDateTime } from '../lib/format'

/** How many saved Webfleet addresses OPS knows, when they were read, and the admin refresh. */
export function AddressBookStatus() {
  const status = usePolling(addressBookApi.status, 0)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const isAdmin = currentDispatcherRole() === 'admin'
  const data = status.data
  if (!data || !data.configured) return null

  async function refresh() {
    setBusy(true); setMessage('')
    try {
      const result = await addressBookApi.sync()
      setMessage(`Обновлено: ${result.total ?? 0} адресов${result.added ? ` · новых ${result.added}` : ''}${result.updated ? ` · изменено ${result.updated}` : ''}${result.hidden ? ` · скрыто ${result.hidden}` : ''}`)
      await status.refetch()
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : 'Адреса не обновились.') }
    finally { setBusy(false) }
  }

  return <div className="rounded-xl border border-slate-200 p-3 text-sm" aria-label="Адреса Webfleet">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="flex items-center gap-2 font-semibold text-slate-800"><BookMarked className="h-4 w-4" aria-hidden="true" />Адреса Webfleet: {data.total ?? 0}</p>
      {isAdmin ? <button type="button" className="secondary-button" disabled={busy} onClick={() => void refresh()}><RefreshCw className="h-4 w-4" aria-hidden="true" />{busy ? 'Обновляем…' : 'Обновить из Webfleet'}</button> : null}
    </div>
    <p className="mt-1 text-slate-600">{data.at ? `Прочитаны ${formatDateTime(data.at)} · обновляются сами раз в 6 часов.` : 'Ещё не прочитаны: первая загрузка — в течение нескольких минут после подключения Webfleet.'} Подсказываются при вводе адреса в маршруте, Auftrag и туре.</p>
    {data.message ? <p className="mt-1 text-amber-800" role="status">{data.message}</p> : null}
    {message ? <p className="mt-1 text-slate-700" role="status">{message}</p> : null}
  </div>
}
