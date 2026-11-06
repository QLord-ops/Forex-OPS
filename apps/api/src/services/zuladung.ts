// "evt. Zuladung", "Zuladung möglich": a possible extra pick-up before unloading, place not known yet (owner's rule).
export const ZULADUNG_PATTERN = /(?:\b(?:evtl?|eventuell|ggf|ev)\.?\s*)?\bzuladung\b(?:\s+(?:m(?:ö|oe)glich|offen))?/giu;

export function mentionsZuladung(text: string | null | undefined): boolean {
  return Boolean(text && new RegExp(ZULADUNG_PATTERN.source, 'iu').test(text));
}

export type ZuladungState = 'NONE' | 'OPEN' | 'ADDED';

type ZuladungStop = { sequence?: number; type: string; instructions?: string | null; completedAt?: Date | string | null };

/**
 * OPEN while the order names a Zuladung, the first unloading is not done and no Zuladung pick-up was added;
 * ADDED once the dispatcher put a loading stop marked «Zuladung» into the tour. ETA and Termin never count an OPEN Zuladung.
 */
export function zuladungState(tour: { tourRemarks?: string | null; stops: ZuladungStop[] }): ZuladungState {
  if (!mentionsZuladung(tour.tourRemarks)) return 'NONE';
  const stops = [...tour.stops].sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0));
  if (stops.some((stop) => stop.type === 'LOAD' && mentionsZuladung(stop.instructions))) return 'ADDED';
  const firstUnload = stops.find((stop) => stop.type === 'UNLOAD');
  if (!firstUnload || firstUnload.completedAt) return 'NONE';
  return 'OPEN';
}

export const ZULADUNG_WARNING = 'Возможна Zuladung перед выгрузкой — место неизвестно, расчёт без неё.';
export const ZULADUNG_TEXT_DE = 'Zuladung möglich';

/** Adds the Zuladung note to a remark when the tour still has an open Zuladung. */
export function withZuladungNote(text: string | null, tour: Parameters<typeof zuladungState>[0] | null | undefined, note = ZULADUNG_TEXT_DE): string | null {
  if (!tour || zuladungState(tour) !== 'OPEN') return text;
  return text ? `${text}; ${note}` : note;
}
