import { lazy, Suspense } from 'react'

import type { MapPanelProps } from './MapPanel'

const MapPanel = lazy(async () => {
  const module = await import('./MapPanel')
  return { default: module.MapPanel }
})

export function LazyMapPanel(props: MapPanelProps) {
  return (
    <Suspense fallback={<div className="map-panel-loading" role="status" aria-label="Карта загружается" />}>
      <MapPanel {...props} />
    </Suspense>
  )
}
