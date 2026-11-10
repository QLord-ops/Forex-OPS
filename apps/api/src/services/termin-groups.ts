import { distanceKm } from "./address-resolution.js";
import { BUILT_IN_RULES, normalizePattern } from "./address-rules.js";

/** Stops this close belong to one plant: its unloading ramp and its Leergut yard share the gate and the Termin. */
export const SAME_PLACE_METERS = 300;
/** Stops this close are one spot: there is no drive between them. */
export const SAME_SPOT_METERS = 50;

export type PlaceLike = {
  company?: string | null; address: string; latitude?: number | null; longitude?: number | null; geocodePrecision?: string | null;
};
type TerminLike = {
  appointmentAt?: Date | string | null; appointmentWindowStartAt?: Date | string | null; appointmentWindowEndAt?: Date | string | null;
};
type TerminInput = { appointmentAt?: string | null; appointmentWindowStartAt?: string | null; appointmentWindowEndAt?: string | null };

const LEGAL_FORMS = new Set(["gmbh", "mbh", "ag", "se", "kg", "co", "ohg", "kgaa", "ug", "sa", "bv", "ltd"]);
const BRAND_BY_PATTERN = new Map(BUILT_IN_RULES.filter((rule) => rule.kind === "COMPANY" && rule.company)
  .map((rule) => [rule.pattern, normalizePattern(rule.company).split(" ")[0]] as const));
const BRANDS = new Set(BRAND_BY_PATTERN.values());

/** "VW Salzgitter" → volkswagen salzgitter, "Volkswagen AG" → volkswagen: the abbreviation and the full name agree. */
function companyTokens(company: string | null | undefined): string[] {
  const tokens = normalizePattern(company).split(" ").filter((token) => token && !LEGAL_FORMS.has(token));
  if (!tokens.length) return tokens;
  return [BRAND_BY_PATTERN.get(tokens[0]) ?? tokens[0], ...tokens.slice(1)];
}

function sameCompany(a: PlaceLike, b: PlaceLike, precise: boolean): boolean {
  const first = companyTokens(a.company), second = companyTokens(b.company);
  if (!first.length || !second.length) return false;
  const [short, long] = first.length <= second.length ? [first, second] : [second, first];
  if (short.every((token, index) => long[index] === token)) return true;
  // Two names of one manufacturer next to each other ("VW Salzgitter", "Volkswagen AG Werk Salzgitter") are one plant.
  return precise && first[0] === second[0] && BRANDS.has(first[0]);
}

/** Street line and postcode of "Industriestraße Nord 1, 38239 Salzgitter"; null when the address has no postcode. */
function streetKey(address: string): string | null {
  const parts = address.split(",").map((part) => part.trim());
  const index = parts.findIndex((part) => /\b\d{5}\b/.test(part));
  if (index < 0) return null;
  const postcode = /\b(\d{5})\b/.exec(parts[index])![1];
  const street = normalizePattern(index > 0 ? parts[index - 1] : parts[index].slice(0, parts[index].indexOf(postcode)))
    .replace(/strasse\b/g, "str");
  return /\p{L}{3}/u.test(street) ? `${street}|${postcode}` : null;
}

const located = (stop: PlaceLike): stop is PlaceLike & { latitude: number; longitude: number } =>
  typeof stop.latitude === "number" && typeof stop.longitude === "number";
const roughly = (stop: PlaceLike) => stop.geocodePrecision === "CITY" || stop.geocodePrecision === "POSTCODE_CITY";

export function metersBetween(a: PlaceLike, b: PlaceLike): number | null {
  return located(a) && located(b) ? distanceKm(a, b) * 1000 : null;
}

/**
 * Two neighbouring stops of a tour are one place when they lie within 300 m and name the same company, or the
 * same street and postcode. Distance alone never decides: two plants can share a town-centre coordinate.
 */
export function samePlace(a: PlaceLike, b: PlaceLike): boolean {
  const meters = metersBetween(a, b);
  if (meters === null || meters > SAME_PLACE_METERS) return false;
  const street = streetKey(a.address);
  if (street && street === streetKey(b.address)) return true;
  return sameCompany(a, b, !roughly(a) && !roughly(b));
}

/** The first stop of the place the stop at `index` belongs to; the Termin of the whole place lives there. */
export function terminLeadIndex(stops: PlaceLike[], index: number): number {
  let lead = index;
  while (lead > 0 && samePlace(stops[lead - 1], stops[lead])) lead -= 1;
  return lead;
}

export const hasTermin = (stop: TerminLike) => Boolean(stop.appointmentAt || stop.appointmentWindowStartAt);
const instant = (value: Date | string | null | undefined) => (value ? new Date(value).getTime() : null);
const terminKey = (stop: TerminLike) => [stop.appointmentAt, stop.appointmentWindowStartAt, stop.appointmentWindowEndAt].map(instant).join("|");

/** A later stop of a place that has no Termin of its own: it is served under the Termin of the place. */
export function isTerminFollower(stops: Array<PlaceLike & TerminLike>, index: number): boolean {
  return !hasTermin(stops[index]) && terminLeadIndex(stops, index) !== index;
}

/**
 * One Termin per place. A Termin entered on a later stop of the place moves to its first stop when that one has
 * none, and a repeated equal Termin is dropped. Two different Termine stay as the dispatcher wrote them.
 */
export function shareTerminAtSamePlace<T extends PlaceLike & TerminInput>(stops: T[]): T[] {
  const result = stops.map((stop) => ({ ...stop }));
  for (let index = 1; index < result.length; index += 1) {
    const lead = terminLeadIndex(result, index);
    const stop = result[index];
    if (lead === index || !hasTermin(stop)) continue;
    if (!hasTermin(result[lead])) {
      Object.assign(result[lead], { appointmentAt: stop.appointmentAt ?? null,
        appointmentWindowStartAt: stop.appointmentWindowStartAt ?? null, appointmentWindowEndAt: stop.appointmentWindowEndAt ?? null });
    } else if (terminKey(result[lead]) !== terminKey(stop)) continue;
    Object.assign(stop, { appointmentAt: null, appointmentWindowStartAt: null, appointmentWindowEndAt: null });
  }
  return result;
}

/** Marks every stop served under another stop's Termin with that stop's id. */
export function withTerminGroups<T extends PlaceLike & TerminLike & { id: string }>(stops: T[]): Array<T & { terminSharedWithStopId: string | null }> {
  return stops.map((stop, index) => ({ ...stop, terminSharedWithStopId: isTerminFollower(stops, index) ? stops[terminLeadIndex(stops, index)].id : null }));
}

/** The stops that are served under the Termin of the stop at `leadIndex`. */
export function terminFollowerIds<T extends PlaceLike & TerminLike & { id: string }>(stops: T[], leadIndex: number): string[] {
  const ids: string[] = [];
  for (let index = leadIndex + 1; index < stops.length && samePlace(stops[index - 1], stops[index]); index += 1) {
    if (!hasTermin(stops[index])) ids.push(stops[index].id);
  }
  return ids;
}
