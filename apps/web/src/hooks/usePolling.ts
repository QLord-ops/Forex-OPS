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

export function usePolling<T>(fetcher: () => Promise<T>, intervalMs: number, enabled = true, key: string | number = 'default') {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [loading, setLoading] = useState(true)
  const fetcherRef = useRef(fetcher)
  const requestRef = useRef(0)
  const keyRef = useRef(key)
  const mountedRef = useRef(false)

  keyRef.current = key

  useEffect(() => {
    fetcherRef.current = fetcher
  }, [fetcher])

  const refetch = useCallback(async () => {
    if (!enabled) return
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
  }, [enabled])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      requestRef.current += 1
    }
  }, [])

  useEffect(() => {
    if (!enabled) return
    requestRef.current += 1
    setData(null)
    setError(null)
    setLoading(true)
    void refetch()
    const timer = window.setInterval(() => {
      void refetch()
    }, intervalMs)

    return () => window.clearInterval(timer)
  }, [enabled, intervalMs, refetch, key])

  return { data, error, loading, refetch }
}
