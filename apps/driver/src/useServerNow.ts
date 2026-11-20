import { useEffect, useState } from 'react'

/** The phone's clock may be wrong: every countdown runs on the server's time plus what has passed since the answer. */
export function useServerNow(serverTime: string) {
  const [now, setNow] = useState(() => Date.parse(serverTime))
  useEffect(() => {
    const base = Date.parse(serverTime), started = performance.now()
    setNow(base)
    const timer = window.setInterval(() => setNow(base + performance.now() - started), 1000)
    return () => window.clearInterval(timer)
  }, [serverTime])
  return now
}
