import { Copy, ExternalLink, MapPin } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { api } from '../lib/api'
import { formatCoordinate, formatDistance, googleMapsUrl, metersBetween } from '../lib/stop-zone'
import type { Coordinate } from '../types/domain'

export type MapMenuPlace = { x: number; y: number; latitude: number; longitude: number }

const WIDTH = 264
const HEIGHT = 250

/** What a right click on the map opens: the coordinates of that spot, ready to copy, and what a dispatcher does with them. */
export function MapContextMenu({ place, bounds, truck, nextStop, onClose }: {
  place: MapMenuPlace
  bounds: { width: number; height: number }
  truck?: Coordinate | null
  nextStop?: Coordinate | null
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [status, setStatus] = useState('')
  const [address, setAddress] = useState<{ state: 'idle' | 'loading' | 'missing' } | { state: 'found'; text: string }>({ state: 'idle' })
  const coordinates = formatCoordinate(place.latitude, place.longitude)
  const here: Coordinate = [place.longitude, place.latitude]

  useEffect(() => {
    setStatus('')
    setAddress({ state: 'idle' })
    ref.current?.querySelector<HTMLElement>('button')?.focus()
  }, [place])

  useEffect(() => {
    const onPointer = (event: MouseEvent) => { if (ref.current && !ref.current.contains(event.target as Node)) onClose() }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onPointer); document.removeEventListener('keydown', onKey) }
  }, [onClose])

  const copy = async (text: string, done: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setStatus(done)
    } catch {
      setStatus('Не удалось скопировать. Выделите текст и скопируйте вручную.')
    }
  }
  const findAddress = async () => {
    setAddress({ state: 'loading' })
    try {
      const found = await api.reverseGeocode(place.latitude, place.longitude)
      setAddress(found.address ? { state: 'found', text: found.address } : { state: 'missing' })
    } catch {
      setAddress({ state: 'missing' })
    }
  }

  const left = Math.max(8, Math.min(place.x, bounds.width - WIDTH - 8))
  const top = Math.max(8, Math.min(place.y, bounds.height - HEIGHT - 8))
  return (
    <div ref={ref} className="map-context-menu" role="dialog" aria-label="Это место на карте" style={{ left, top, width: WIDTH }}>
      <button type="button" className="map-context-coordinates" onClick={() => void copy(coordinates, 'Координаты скопированы')} title="Скопировать координаты">
        <span>{coordinates}</span><Copy className="h-4 w-4" aria-hidden="true" />
      </button>
      {address.state === 'found'
        ? <button type="button" className="map-context-item" onClick={() => void copy(address.text, 'Адрес скопирован')} title="Скопировать адрес"><MapPin className="h-4 w-4" aria-hidden="true" /><span>{address.text}</span></button>
        : <button type="button" className="map-context-item" onClick={() => void findAddress()} disabled={address.state === 'loading'}>
          <MapPin className="h-4 w-4" aria-hidden="true" /><span>{address.state === 'loading' ? 'Ищу адрес…' : address.state === 'missing' ? 'Адрес не найден. Повторить' : 'Адрес этого места'}</span>
        </button>}
      {truck || nextStop ? <dl className="map-context-distances">
        {truck ? <div><dt>До машины по прямой</dt><dd>{formatDistance(metersBetween(here, truck))}</dd></div> : null}
        {nextStop ? <div><dt>До следующей точки</dt><dd>{formatDistance(metersBetween(here, nextStop))}</dd></div> : null}
      </dl> : null}
      <a className="map-context-item" href={googleMapsUrl(place.latitude, place.longitude)} target="_blank" rel="noopener noreferrer"><ExternalLink className="h-4 w-4" aria-hidden="true" /><span>Открыть в Google Maps</span></a>
      <button type="button" className="map-context-item" onClick={() => void copy(googleMapsUrl(place.latitude, place.longitude), 'Ссылка скопирована')}><Copy className="h-4 w-4" aria-hidden="true" /><span>Скопировать ссылку для водителя</span></button>
      <p className="map-context-status" role="status">{status}</p>
    </div>
  )
}
