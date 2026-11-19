import { RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { entryOf, newerBuild } from '../lib/app-version'

const CHECK_EVERY_MS = 5 * 60_000

/**
 * A tab that stays open all day keeps the program it was loaded with: after a deploy the dispatcher went on working
 * with the old one and saw errors that were already fixed (19.11). The page is never reloaded by itself — an Auftrag
 * may be half checked — the dispatcher decides when.
 */
export function UpdateNotice() {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    if (!import.meta.env.PROD) return
    const running = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/"]')?.getAttribute('src') ?? null
    if (!running) return
    let stopped = false
    const check = async () => {
      if (document.visibilityState !== 'visible') return
      try {
        const response = await fetch('/', { cache: 'no-store', headers: { Accept: 'text/html' } })
        if (!response.ok) return
        if (!stopped && newerBuild(running, entryOf(await response.text()))) setReady(true)
      } catch { /* No connection: the next check will tell. */ }
    }
    const timer = window.setInterval(() => void check(), CHECK_EVERY_MS)
    const onVisible = () => void check()
    document.addEventListener('visibilitychange', onVisible)
    return () => { stopped = true; window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisible) }
  }, [])
  if (!ready) return null
  return <div className="update-notice" role="status">
    <span>Вышла новая версия OPS</span>
    <button type="button" className="update-notice-button" onClick={() => window.location.reload()}><RefreshCw className="h-4 w-4" aria-hidden="true" />Обновить</button>
  </div>
}
