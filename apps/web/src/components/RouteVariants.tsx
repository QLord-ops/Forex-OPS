import { LoaderCircle } from 'lucide-react'
import { useRef, type KeyboardEvent } from 'react'

import { classNames } from '../lib/format'
import { formatDrive, formatRouteKm, placeName, variantDelta } from '../lib/route-variants'
import type { RouteLeg, RouteOption } from '../types/assistant'

/** Webfleet-style list: every variant stays listed, the chosen one is highlighted. */
export function RouteVariants({ legs, choice, activeLeg, busy, live, onActiveLeg, onChoose }: {
  legs: RouteLeg[]
  choice: number[]
  activeLeg: number
  busy: boolean
  live: boolean
  onActiveLeg: (index: number) => void
  onChoose: (legIndex: number, optionIndex: number) => void
}) {
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const leg = legs[activeLeg]
  if (!leg) return null
  const best = leg.options[0]
  const selected = choice[activeLeg] ?? 0

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const step = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 0
    if (!step || !leg) return
    event.preventDefault()
    const next = (selected + step + leg.options.length) % leg.options.length
    onChoose(activeLeg, next)
    optionRefs.current[next]?.focus()
  }

  return <section className="route-variants" aria-label="Варианты маршрута">
    <div className="route-variants-head">
      <strong>Варианты маршрута</strong>
      {busy ? <span className="route-variants-busy" role="status"><LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />пересчёт ETA…</span> : null}
    </div>
    {legs.length > 1 ? <div className="route-leg-tabs" role="tablist" aria-label="Участки маршрута">
      {legs.map((item, index) => <button key={index} type="button" role="tab" aria-selected={index === activeLeg} className={classNames('route-leg-tab', index === activeLeg && 'active')} onClick={() => onActiveLeg(index)}>
        <span className="tabular-nums">{index + 1} → {index + 2}</span><span className="truncate">{placeName(item.to)}</span>
      </button>)}
    </div> : null}
    <div className="route-variant-list" role="radiogroup" aria-label={`Варианты участка ${activeLeg + 1} → ${activeLeg + 2}`} onKeyDown={onKeyDown}>
      {leg.options.map((option, index) => <button key={option.id} ref={(node) => { optionRefs.current[index] = node }} type="button" role="radio" aria-checked={index === selected} tabIndex={index === selected ? 0 : -1}
        className={classNames('route-variant', index === selected && 'route-variant-selected')} onClick={() => onChoose(activeLeg, index)}>
        <span className="route-variant-row">
          <span className="route-variant-title"><RoadsVia option={option} /></span>
          <span className="route-variant-time">{formatDrive(option.durationSeconds)}</span>
        </span>
        <span className="route-variant-meta">{formatRouteKm(option.distanceMeters)} · {index === 0 || !best ? 'лучший по времени' : variantDelta(option, best)}</span>
        {option.trafficDelaySeconds >= 60 || option.hasRoadClosure ? <span className="route-variant-flags">
          {option.trafficDelaySeconds >= 60 ? <span className="route-variant-traffic">пробки +{formatDrive(option.trafficDelaySeconds)}</span> : null}
          {option.hasRoadClosure ? <span className="route-variant-closure">перекрытие на пути</span> : null}
        </span> : null}
      </button>)}
    </div>
    {leg.options.length < 2 ? <p className="route-variants-note">{live ? 'Других вариантов для этого участка нет' : 'Варианты доступны только с TomTom'}</p> : null}
  </section>
}

/** «через [A14] и [A2]» with road numbers drawn as German road shields. */
function RoadsVia({ option }: { option: RouteOption }) {
  const [first, second] = option.mainRoads
  if (!first) return <>по местным дорогам</>
  const shield = (road: string) => <span className={classNames('road-shield', road.startsWith('B') && 'road-shield-b')}>{road}</span>
  return <>через {shield(first)}{second ? <> и {shield(second)}</> : null}</>
}
