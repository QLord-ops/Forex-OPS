import { useMemo } from 'react'

/**
 * Keeps the previous object while its content is unchanged. Every poll returns new objects with the
 * same data; without this the map would remove and redraw all markers and lines each time.
 */
export function useStableValue<T>(value: T): T {
  const key = JSON.stringify(value) ?? 'undefined'
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => value, [key])
}
