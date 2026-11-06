// Same rule as the API (services/zuladung.ts): "evt. Zuladung" in the Auftrag is a possible extra pick-up before unloading.
const ZULADUNG = /(?:\b(?:evtl?|eventuell|ggf|ev)\.?\s*)?\bzuladung\b/iu

export type ZuladungState = 'NONE' | 'OPEN' | 'ADDED'

type ZuladungStop = { sequence?: number; type: string; instructions?: string | null; completedAt?: string | null }

export function mentionsZuladung(text: string | null | undefined): boolean {
  return Boolean(text && ZULADUNG.test(text))
}

export function zuladungState(tour: { tourRemarks?: string | null; stops?: ZuladungStop[] } | null | undefined): ZuladungState {
  if (!tour || !mentionsZuladung(tour.tourRemarks)) return 'NONE'
  const stops = [...(tour.stops ?? [])].sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0))
  if (stops.some((stop) => stop.type === 'LOAD' && mentionsZuladung(stop.instructions))) return 'ADDED'
  const firstUnload = stops.find((stop) => stop.type === 'UNLOAD')
  return !firstUnload || firstUnload.completedAt ? 'NONE' : 'OPEN'
}

/** Id of the stop the Zuladung goes before: the first unloading. */
export function zuladungBeforeStopId(tour: { stops?: Array<ZuladungStop & { id: string }> } | null | undefined): string | null {
  const stops = [...(tour?.stops ?? [])].sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0))
  return stops.find((stop) => stop.type === 'UNLOAD' && !stop.completedAt)?.id ?? null
}

/** A possible Zuladung becomes a loading stop marked «Zuladung», placed before the first unloading still ahead. */
export function withZuladungStop<T extends { type: string; arrivedAt?: string | null }>(stops: T[], stop: T): T[] {
  const index = stops.findIndex((item) => item.type === 'UNLOAD' && !item.arrivedAt)
  const at = index < 0 ? stops.length : index
  return [...stops.slice(0, at), stop, ...stops.slice(at)]
}

export const ZULADUNG_NOTE = 'Zuladung возможна перед выгрузкой — место неизвестно. ETA и срок посчитаны без неё.'
