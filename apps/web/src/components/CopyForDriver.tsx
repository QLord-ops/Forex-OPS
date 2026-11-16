import { Copy } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { api } from '../lib/api'
import { driverMessage } from '../lib/driver-message'
import { classNames } from '../lib/format'

/**
 * «Для водителя»: the tour as the driver reads it, put on the clipboard for WhatsApp. The tour is read fresh at the click,
 * so the text has every stop as it is now, whichever screen the button sits on.
 */
export function CopyForDriver({ tourId, className }: { tourId: string; className?: string }) {
  const [state, setState] = useState<{ kind: 'idle' | 'busy' | 'copied' } | { kind: 'manual'; text: string } | { kind: 'error' }>({ kind: 'idle' })
  const area = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => { if (state.kind === 'manual') area.current?.select() }, [state])
  useEffect(() => {
    if (state.kind !== 'copied') return
    const timer = window.setTimeout(() => setState({ kind: 'idle' }), 4000)
    return () => window.clearTimeout(timer)
  }, [state])

  const copy = async () => {
    setState({ kind: 'busy' })
    const text = api.tour(tourId).then((tour) => driverMessage(tour))
    try {
      // A ClipboardItem holding a promise keeps the click's permission while the tour loads (Safari needs that).
      if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
        await navigator.clipboard.write([new ClipboardItem({ 'text/plain': text.then((value) => new Blob([value], { type: 'text/plain' })) })])
      } else {
        await navigator.clipboard.writeText(await text)
      }
      setState({ kind: 'copied' })
    } catch {
      try {
        setState({ kind: 'manual', text: await text })
      } catch {
        setState({ kind: 'error' })
      }
    }
  }

  return <span className={classNames('copy-for-driver', className)}>
    <button type="button" className="copy-for-driver-button" onClick={() => void copy()} disabled={state.kind === 'busy'} title="Скопировать адреса, время и ссылки на карту для WhatsApp">
      <Copy className="h-3.5 w-3.5" aria-hidden="true" />{state.kind === 'busy' ? 'Копирую…' : 'Для водителя'}
    </button>
    <span className="copy-for-driver-status" role="status">{state.kind === 'copied' ? 'Скопировано' : state.kind === 'error' ? 'Тур не загрузился, попробуйте ещё раз' : ''}</span>
    {state.kind === 'manual' ? <span className="copy-for-driver-manual">
      <span>Буфер обмена недоступен. Текст выделен — нажмите Ctrl+C.</span>
      <textarea ref={area} readOnly value={state.text} rows={8} aria-label="Текст для водителя" onFocus={(event) => event.currentTarget.select()} />
      <button type="button" className="secondary-button compact-button" onClick={() => setState({ kind: 'idle' })}>Закрыть</button>
    </span> : null}
  </span>
}
