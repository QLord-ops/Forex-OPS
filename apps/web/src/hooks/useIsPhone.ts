import { useEffect, useState } from 'react'

/** The phone layout (bottom tabs, sheets): the same 767 px edge the CSS uses. */
export const PHONE_QUERY = '(max-width: 767px)'

export function isPhone(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(PHONE_QUERY).matches
}

export function useIsPhone(): boolean {
  const [phone, setPhone] = useState(isPhone)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const query = window.matchMedia(PHONE_QUERY)
    const onChange = () => setPhone(query.matches)
    onChange()
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])
  return phone
}
