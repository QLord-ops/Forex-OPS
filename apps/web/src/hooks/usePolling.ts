import { useCallback, useEffect, useRef, useState } from 'react'

export interface PollingRequestSnapshot {
  requestId: number
  key: string | number
}

export function isCurrentPollingRequest(
  snapshot: PollingRequestSnapshot,
  latestRequestId: number,
  activeKey: string | number,
  mounted = true
) {
  return mounted && snapshot.requestId === latestRequestId && Object.is(snapshot.key, activeKey)
}

/**
 * `intervalMs` 0 loads once (forms, history) and refreshes only on refetch or when the tab is shown again.
 * `background` keeps polling in a hidden tab (notifications must arrive while the dispatcher works elsewhere).
 */
export function usePolling<T>(fetcher: () => Promise<T>, intervalMs: number, enabled = true, key: string | number = 'default', background = false) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [loading, setLoading] = useState(true)
  const fetcherRef = useRef(fetcher)
  const requestRef = useRef(0)
  const keyRef = useRef(key)
  const mountedRef = useRef(false)
  const inFlightRef = useRef<Promise<void> | null>(null)
  const queuedRef = useRef(false)
  const refetchRef = useRef<() => Promise<void>>(async () => undefined)
  const shownKeyRef = useRef<string | number | null>(null)

  keyRef.current = key

  useEffect(() => {
    fetcherRef.current = fetcher
  }, [fetcher])

  const refetch = useCallback(async () => {
    if (!enabled) return
    if (inFlightRef.current) {
      queuedRef.current = true
      return inFlightRef.current
    }
    const request = (async () => {
      const requestId = ++requestRef.current
      const snapshot = { requestId, key: keyRef.current }
      setLoading(true)
      try {
        const result = await fetcherRef.current()
        if (!isCurrentPollingRequest(snapshot, requestRef.current, keyRef.current, mountedRef.current)) return
        setData(result)
        setError(null)
      } catch (err) {
        if (!isCurrentPollingRequest(snapshot, requestRef.current, keyRef.current, mountedRef.current)) return
        setError(err as Error)
      } finally {
        if (isCurrentPollingRequest(snapshot, requestRef.current, keyRef.current, mountedRef.current)) setLoading(false)
      }
    })()
    inFlightRef.current = request
    try {
      await request
    } finally {
      if (inFlightRef.current === request) inFlightRef.current = null
      if (queuedRef.current && mountedRef.current) {
        queuedRef.current = false
        queueMicrotask(() => { void refetchRef.current() })
      }
    }
  }, [enabled])
  refetchRef.current = refetch

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      queuedRef.current = false
      requestRef.current += 1
    }
  }, [])

  useEffect(() => {
    if (!enabled) return
    // Only a different subject (another truck) clears the screen; a re-run for the same key keeps the data.
    if (shownKeyRef.current !== null && !Object.is(shownKeyRef.current, key)) {
      requestRef.current += 1
      setData(null)
      setError(null)
      setLoading(true)
    }
    shownKeyRef.current = key
    const visible = () => background || typeof document === 'undefined' || document.visibilityState !== 'hidden'
    // refetch() queues behind a request for the previous key, so the new subject always loads.
    if (visible()) void refetch()
    const timer = intervalMs > 0 ? window.setInterval(() => {
      if (visible() && !inFlightRef.current) void refetch()
    }, intervalMs) : undefined
    const handleVisibility = () => {
      if (visible() && !inFlightRef.current) void refetch()
    }
    document.addEventListener('visibilitychange', handleVisibility)

    return () => {
      if (timer !== undefined) window.clearInterval(timer)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [enabled, intervalMs, refetch, key, background])

  return { data, error, loading, refetch }
}
