import type { GeocodeResult } from "../domain.js";
import type { AddressResearchCandidate, AddressResearcher } from "./address-research.js";
import type { RoutingProvider } from "./routing.js";
import { RoutingError } from "./routing.js";
import { expandCity, findSiteRule, type AddressRuleRecord } from "./address-rules.js";
import { findKnownPlace, knownPlaceResolution, type KnownPlace } from "./known-places.js";
import { addressParts, type AddressCheck, type AddressChecker, type PlaceSearch } from "./address-check.js";

export const geocodePrecisions = ["EXACT", "STREET", "POSTCODE_CITY", "CITY"] as const;
export type GeocodePrecision = (typeof geocodePrecisions)[number];

/**
 * A place farther than this from the stop's own town is wrong, whatever a learned rule or the geocoder says:
 * "Lager, Ludwigsfelde" once came back as a Lagerstraße in Hamburg and sent the route 250 km north.
 */
export const MAX_DISTANCE_FROM_CITY_KM = 40;
/** A street found under another postcode than the printed one must lie this close to the printed postcode's area. */
export const SAME_POSTCODE_AREA_KM = 10;

export type AddressResolution = GeocodeResult & {
  sourceAddress: string;
  resolvedAddress: string;
  precision: GeocodePrecision;
  attempts: string[];
  researchUsed?: boolean;
  researchCandidates?: AddressResearchCandidate[];
  check?: AddressCheck | null;
  /** What a second, independent geocoder says about the same address (owner, 15.11.2026). Absent when it was not asked. */
  second?: SecondOpinion;
};

/** Two geocoders within this distance mean the same place. */
export const SECOND_SOURCE_AGREE_METERS = 500;
/** The second opinion may not keep the dispatcher waiting: past this the answer goes without it. */
const SECOND_OPINION_WAIT_MS = 2_500;

function withinMs<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([promise, new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); })]).finally(() => clearTimeout(timer));
}
export type SecondOpinion =
  | { status: "AGREE"; meters: number }
  | { status: "DIFFER"; meters: number; latitude: number; longitude: number; label: string };

export type AddressSources = { checker?: AddressChecker; places?: PlaceSearch };

/**
 * Order of evidence (owner's decision 2026-11-04): a learned rule for the company in that city, then the city
 * (codes like WOB spelled out), the street in it, and the company in the city before the bare city.
 */
export async function resolveAddressWithFallback(
  routing: RoutingProvider,
  input: { address: string; city?: string | null; company?: string | null },
  researcher?: AddressResearcher,
  rules: AddressRuleRecord[] = [],
  places: KnownPlace[] = [],
  sources: AddressSources = {}
): Promise<AddressResolution> {
  // The official postcode and street register is asked alongside; its verdict travels with the answer and never blocks it.
  const checking = sources.checker && input.address.trim()
    ? sources.checker.check({ address: input.address, city: expandCity(input.city ?? null, rules.length ? rules : undefined) }).catch(() => null)
    : Promise.resolve(undefined);
  const found = await resolveCore(routing, input, researcher, rules, places, sources.places);
  const second = await secondOpinion(found, input, rules, sources.places, routing);
  const result = second ? { ...found, second } : found;
  const check = await checking;
  return check === undefined ? result : { ...result, check };
}

/**
 * A street address the free geocoder found is asked of TomTom too. Places the fleet already knows (a learned rule, the
 * address book, a gate where trucks stood) need no second opinion, and a town-level answer has nothing to compare.
 */
async function secondOpinion(found: AddressResolution, input: { address: string; city?: string | null; company?: string | null }, rules: AddressRuleRecord[], search?: PlaceSearch, routing?: RoutingProvider): Promise<SecondOpinion | undefined> {
  if (found.precision !== "EXACT" && found.precision !== "STREET") return undefined;
  const city = expandCity(input.city ?? null, rules.length ? rules : undefined);
  const query = buildAddressCandidates(input.address.trim(), city, input.company)[0]?.query;
  if (!query) return undefined;
  const provider = found.provider ?? "";
  let other: GeocodeResult | null = null;
  if (provider.includes("nominatim")) {
    other = search?.findAddress ? await search.findAddress(query).catch(() => null) : null;
  } else if (provider.startsWith("tomtom") && found.precision === "EXACT" && routing) {
    // The free geocoder checks TomTom's house, but only when it found that very house: its street without a number
    // lies in the middle of the street and would cry «другое место» on every long street. A busy queue is no opinion.
    const answer = await withinMs(routing.geocode(query), SECOND_OPINION_WAIT_MS).catch(() => null);
    const verdict = answer ? matchOf(printedParts(input.address, city), answer) : null;
    other = answer && verdict?.house === "same" && verdict.street !== "other" ? answer : null;
  }
  if (!other) return undefined;
  const meters = Math.round(distanceKm(found, other) * 1000);
  return meters <= SECOND_SOURCE_AGREE_METERS ? { status: "AGREE", meters }
    : { status: "DIFFER", meters, latitude: other.latitude, longitude: other.longitude, label: other.label };
}

async function resolveCore(
  routing: RoutingProvider,
  input: { address: string; city?: string | null; company?: string | null },
  researcher: AddressResearcher | undefined,
  rules: AddressRuleRecord[],
  places: KnownPlace[],
  companySearch?: PlaceSearch
): Promise<AddressResolution> {
  const sourceAddress = input.address.trim();
  if (!sourceAddress) throw new RoutingError("Адрес не может быть пустым.", 400);
  const city = expandCity(input.city ?? null, rules.length ? rules : undefined);
  const attempts: string[] = [];

  // The stop's own town (postcode and city when printed) anchors every answer: a result elsewhere is dropped.
  const anchor = cityAnchor(sourceAddress, city);
  let anchorPoint: GeocodeResult | null | undefined;
  const anchored = async () => {
    if (anchorPoint === undefined) {
      try { anchorPoint = anchor ? (await routing.geocode(anchor.query)) ?? null : null; } catch { anchorPoint = null; }
    }
    return anchorPoint;
  };
  /**
   * Kilometres from the town when the result lies too far from it; null when it is plausible or cannot be checked.
   * The town's name alone is not proof: there are three Petershagens, so another postcode means measuring the distance.
   */
  const farFromCity = async (point: { latitude: number; longitude: number }, resultCity?: string | null, resultPostalCode?: string | null): Promise<number | null> => {
    if (!anchor) return null;
    if (resultCity && sameCity(resultCity, anchor.city) && !postcodesDiffer(anchor.postalCode, resultPostalCode)) return null;
    const town = await anchored();
    if (!town) return null;
    const km = distanceKm(town, point);
    return km > MAX_DISTANCE_FROM_CITY_KM ? km : null;
  };

  const site = findSiteRule(input.company, city, rules);
  if (site && site.latitude !== null && site.longitude !== null) {
    const label = [site.company, site.street, [site.postalCode, site.city].filter(Boolean).join(" ")].filter(Boolean).join(", ");
    const km = await farFromCity({ latitude: site.latitude, longitude: site.longitude });
    if (km === null) {
      return { latitude: site.latitude, longitude: site.longitude, city: site.city, label, provider: "address-rule",
        sourceAddress, resolvedAddress: label, precision: "EXACT", attempts: [`правило: ${site.pattern}`] };
    }
    attempts.push(`правило «${site.pattern}» отброшено: ${Math.round(km)} км от ${anchor!.query}`);
  }

  // The same door (street, house number, postcode) is in the address book: its coordinates need no geocoder.
  const place = findKnownPlace({ ...input, city }, places);
  if (place) return knownPlaceResolution(place, sourceAddress);

  // No street with a house number, only a company in a town ("BLG, Bremen"): a business directory knows the plant better.
  if (companySearch && input.company?.trim() && anchor && !addressParts(sourceAddress, city).street) {
    const town = await anchored();
    const hit = town ? await companySearch.findCompany(input.company, town).catch(() => null) : null;
    if (hit) {
      const km = await farFromCity(hit, hit.city, hit.postalCode);
      if (km === null) {
        attempts.push(`TomTom: ${input.company.trim()} у ${anchor.query}`);
        return { ...hit, sourceAddress, resolvedAddress: hit.label, precision: "EXACT", attempts };
      }
      attempts.push(`TomTom: ${hit.label}: ${Math.round(km)} км от ${anchor.query}, отброшено`);
    }
  }

  const candidates = buildAddressCandidates(sourceAddress, city, input.company);
  const printed = printedParts(sourceAddress, city);
  let lastNotFound: unknown;
  let approximateResult: AddressResolution | undefined;
  // The right street without the house yet: kept, and given only when no source finds the house itself.
  let streetOnly: AddressResolution | undefined;
  let geocoderDown = false;

  /**
   * A street-level answer counts only when it is the printed street, at the printed postcode, near the stop's town: a
   * geocoder that does not know a street answers with a similar one («Lagerstraße» for «Lager»), and that is no match.
   */
  const accept = async (hit: GeocodeResult, source: string, asked: GeocodePrecision = "EXACT"): Promise<AddressResolution | null> => {
    const verdict = matchOf(printed, hit);
    if (verdict.street === "other") { attempts.push(`${source}: ${hit.label}: другая улица, отброшено`); return null; }
    // Another postcode of the same town is a neighbouring district at most (Petershagen 32469/32457): the same street
    // name in another part of the town lies farther from the printed postcode than that.
    if (verdict.postcode === "other") {
      const area = await anchored();
      if (area && distanceKm(area, hit) > SAME_POSTCODE_AREA_KM) { attempts.push(`${source}: ${hit.label}: индекс ${hit.postalCode}, а не ${printed.postalCode}, отброшено`); return null; }
    }
    const km = await farFromCity(hit, hit.city, hit.postalCode);
    if (km !== null) { attempts.push(`${source}: ${hit.label}: ${Math.round(km)} км от ${anchor!.query}, отброшено`); return null; }
    attempts.push(`${source}: ${hit.label}`);
    // EXACT is the printed house itself; a street without the printed number (or none printed) is STREET. A source that
    // names neither street nor house cannot be judged and keeps the precision of the query.
    const judged = Boolean(hit.street || hit.houseNumber);
    const precision: GeocodePrecision = !judged ? asked : verdict.house === "same" && verdict.street !== "unknown" ? "EXACT" : "STREET";
    return { ...hit, sourceAddress, resolvedAddress: hit.label, precision, attempts };
  };
  const take = (found: AddressResolution | null): AddressResolution | null => {
    if (!found) return null;
    if (found.precision === "EXACT") return found;
    streetOnly ??= found;
    return null;
  };

  // TomTom first, field by field (owner, 16.11.2026): it knows German house numbers best and has no one-a-second queue.
  if (companySearch?.findStructured && printed.street) {
    const hit = await companySearch.findStructured({ street: printed.street, houseNumber: printed.houseNumber, postalCode: printed.postalCode, city: printed.city }).catch(() => null);
    const exact = take(hit ? await accept(hit, "TomTom") : null);
    if (exact) return exact;
  }

  // The free geocoder lacks many streets of small places ("Zachower Str. 4, Ketzin OT Tremmen"): before settling for the
  // town, the street is asked of TomTom once more as free text.
  let tomTomAsked = false;
  const fromTomTom = async (): Promise<AddressResolution | null> => {
    if (tomTomAsked || !companySearch?.findAddress || !addressParts(sourceAddress, city).street) return null;
    tomTomAsked = true;
    const query = candidates.find((item) => item.precision === "EXACT")?.query;
    const hit = query ? await companySearch.findAddress(query).catch(() => null) : null;
    return take(hit ? await accept(hit, "TomTom") : null);
  };

  for (const candidate of candidates) {
    if (!STREET_LEVEL.includes(candidate.precision)) {
      const street = await fromTomTom();
      if (street) return street;
      // The right street beats the town centre.
      if (streetOnly) return streetOnly;
    }
    attempts.push(candidate.query);
    try {
      const result = await routing.geocode(candidate.query);
      if (STREET_LEVEL.includes(candidate.precision)) {
        const found = await accept(result, "карта", candidate.precision);
        if (!found) { lastNotFound = { statusCode: 404 }; continue; }
        const exact = take(found);
        if (exact) return exact;
        continue;
      }
      const km = await farFromCity(result, result.city, result.postalCode);
      if (km !== null) {
        attempts.push(`${result.label}: ${Math.round(km)} км от ${anchor!.query}, отброшено`);
        lastNotFound = { statusCode: 404 };
        continue;
      }
      const resolved = { ...result, sourceAddress, resolvedAddress: result.label, precision: candidate.precision, attempts };
      if (!researcher) return resolved;
      approximateResult = resolved;
      break;
    } catch (error) {
      if (isNotFound(error)) {
        lastNotFound = error;
        continue;
      }
      // Refused or too slow: a busy free geocoder must not cost the stop its address while other sources answer.
      if (isUnavailable(error)) {
        geocoderDown = true;
        attempts.push("бесплатный геокодер перегружен");
        break;
      }
      throw error;
    }
  }

  const street = await fromTomTom();
  if (street) return street;
  if (streetOnly) return streetOnly;

  if (researcher && !geocoderDown && isNotFound(lastNotFound)) {
    const researchCandidates = await researcher.research(input);
    for (const candidate of researchCandidates) {
      if (attempts.some((attempt) => normalizeForCompare(attempt) === normalizeForCompare(candidate.address))) continue;
      attempts.push(candidate.address);
      try {
        const result = await routing.geocode(candidate.address);
        const km = await farFromCity(result, result.city, result.postalCode);
        if (km !== null) { attempts.push(`${result.label}: ${Math.round(km)} км от ${anchor!.query}, отброшено`); continue; }
        return {
          ...result,
          provider: result.provider ? `openai-web+${result.provider}` : "openai-web",
          sourceAddress,
          resolvedAddress: result.label,
          precision: "EXACT",
          attempts,
          researchUsed: true,
          researchCandidates
        };
      } catch (error) {
        if (isNotFound(error)) continue;
        if (isUnavailable(error)) break;
        throw error;
      }
    }
  }

  if (approximateResult) return approximateResult;
  if (geocoderDown) throw new RoutingError("Сервисы адресов сейчас перегружены — повторите через минуту.", 503);
  throw new RoutingError(`Адрес не найден. Проверены: ${attempts.join(" → ")}.`, 404);
}

/** The town a stop belongs to, as a geocoder query: "14974 Ludwigsfelde" when the postcode is printed, else the city. */
export function cityAnchor(address: string, city?: string | null): { query: string; city: string; postalCode?: string } | null {
  const normalizedAddress = normalizeGermanAddress(address);
  const postalCode = normalizedAddress.match(/\b\d{5}\b/)?.[0] ?? (city ?? "").match(/\b\d{5}\b/)?.[0];
  const named = normalizeCity(city) || extractCityFromAddress(normalizedAddress, postalCode);
  // "Ketzin OT Tremmen" is found as its Ortsteil.
  const effectiveCity = ortsteilOf(named)?.district ?? named;
  if (!effectiveCity || /\d/.test(effectiveCity)) return null;
  return { query: postalCode ? `${postalCode} ${effectiveCity}` : effectiveCity, city: effectiveCity, ...(postalCode ? { postalCode } : {}) };
}

/**
 * The printed postcode and the found one are not the same: maybe another district of a big town, maybe another town
 * of the same name ("32469 Petershagen" and "15370 Petershagen"). Only the distance can tell, so the name is not enough.
 */
export function postcodesDiffer(printed?: string | null, found?: string | null): boolean {
  return Boolean(printed && found && printed !== found);
}

function sameCity(left: string, right: string): boolean {
  const a = normalizeForCompare(left), b = normalizeForCompare(right);
  return Boolean(a && b) && (a === b || a.startsWith(`${b} `) || b.startsWith(`${a} `) || a.includes(` ${b}`) || b.includes(` ${a}`));
}

export function distanceKm(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * rad, dLon = (b.longitude - a.longitude) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

/** "Ketzin OT Tremmen": the town and its Ortsteil. The free geocoder knows the Ortsteil or the town, rarely the two together. */
export function ortsteilOf(value?: string | null): { full: string; town: string; district: string } | null {
  const match = /([A-Za-zÄÖÜäöüß][A-Za-zÄÖÜäöüß./ -]*?)\s+(?:OT|Ortsteil)\.?\s+([A-Za-zÄÖÜäöüß][A-Za-zÄÖÜäöüß./ -]*)/u.exec(value ?? "");
  return match ? { full: match[0].trim(), town: match[1].trim(), district: match[2].trim() } : null;
}

const STREET_LEVEL: GeocodePrecision[] = ["EXACT", "STREET"];

/** Queries from the most exact to the coarsest. With an Ortsteil the street is asked in the Ortsteil and in the town too. */
export function buildAddressCandidates(address: string, city?: string | null, company?: string | null): Array<{ query: string; precision: GeocodePrecision }> {
  const ot = ortsteilOf(city) ?? ortsteilOf(address);
  if (!ot) return baseCandidates(address, city, company);
  const swap = (value: string | null | undefined, to: string) => (value ?? "").split(ot.full).join(to) || null;
  const lists = [baseCandidates(address, city, company), ...[ot.district, ot.town].map((to) => baseCandidates(swap(address, to) ?? address, swap(city, to), company))];
  return dedupeCandidates([
    ...lists.flatMap((list) => list.filter((item) => STREET_LEVEL.includes(item.precision))),
    ...lists.slice(1).flatMap((list) => list.filter((item) => !STREET_LEVEL.includes(item.precision))),
    ...lists[0].filter((item) => !STREET_LEVEL.includes(item.precision))
  ]);
}

function baseCandidates(address: string, city?: string | null, company?: string | null): Array<{ query: string; precision: GeocodePrecision }> {
  const normalizedAddress = normalizeGermanAddress(address);
  const normalizedCity = normalizeCity(city);
  const exact = appendCity(normalizedAddress, normalizedCity);
  const street = removeHouseNumber(normalizedAddress);
  const addressPostalCode = normalizedAddress.match(/\b\d{5}\b/)?.[0];
  const postalCode = addressPostalCode ?? (city ?? "").match(/\b\d{5}\b/)?.[0];
  const cityFromAddress = extractCityFromAddress(normalizedAddress, addressPostalCode);
  const effectiveCity = normalizedCity || cityFromAddress;
  // The postcode travels with the town in every query: "Petershagen" alone is three towns, "32469 Petershagen" one.
  const town = postalCode && effectiveCity ? `${postalCode} ${effectiveCity}` : effectiveCity;
  const inTown = (value: string) => postalCode && !addressPostalCode && effectiveCity ? withPostcode(value, effectiveCity, town) : appendCity(value, effectiveCity);
  // Only a city was printed ("Bremen" for "Seifert & BLG Bremen"): the company in that city first, the bare city last,
  // and never a city centre presented as an exact address.
  if (company?.trim() && effectiveCity && normalizeForCompare(normalizedAddress) === normalizeForCompare(effectiveCity)) {
    return dedupeCandidates([
      { query: `${company.trim()}, ${town}`, precision: "POSTCODE_CITY" },
      { query: town, precision: postalCode ? "POSTCODE_CITY" : "CITY" }
    ]);
  }

  return dedupeCandidates([
    { query: postalCode && !addressPostalCode && effectiveCity ? inTown(normalizedAddress) : exact, precision: "EXACT" },
    ...(street && street !== normalizedAddress
      ? [{ query: inTown(street), precision: "STREET" as const }]
      : []),
    ...(postalCode && effectiveCity
      ? [{ query: town, precision: "POSTCODE_CITY" as const }]
      : []),
    // The company in the city finds a plant or warehouse when no street was printed ("BLG, Bremen").
    ...(company?.trim() && effectiveCity && !normalizedAddress.match(/\d/)
      ? [{ query: `${company.trim()}, ${town}`, precision: "POSTCODE_CITY" as const }]
      : []),
    // The bare town name only when no postcode was printed: with one, it may land in a namesake hundreds of km away.
    ...(effectiveCity && !postalCode ? [{ query: effectiveCity, precision: "CITY" as const }] : [])
  ]);
}

/** "Lange Str. 5, Petershagen" + 32469 → "Lange Str. 5, 32469 Petershagen". */
function withPostcode(address: string, city: string, town: string): string {
  const segments = address.split(",").map((item) => item.trim());
  const at = segments.map((item) => normalizeForCompare(item)).lastIndexOf(normalizeForCompare(city));
  if (at === 0 && segments.length === 1) return town;
  if (at < 1) return `${address}, ${town}`;
  segments[at] = town;
  return segments.join(", ");
}

function normalizeGermanAddress(value: string): string {
  return value
    .replace(/\bD\s*[-–]?\s*(?=\d{5}\b)/gi, "")
    .replace(/str\.\s*(?=\d)/gi, "straße ")
    .replace(/\s*,\s*/g, ", ")
    .replace(/\.{2,}/g, ".")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[,.\s]+$/, "");
}

function normalizeCity(value?: string | null): string {
  return (value ?? "")
    .replace(/\bD\s*[-–]?\s*(?=\d{5}\b)/gi, "")
    .replace(/^\d{5}\s+/, "")
    .replace(/[,.\s]+$/, "")
    .trim();
}

function appendCity(address: string, city: string): string {
  if (!city || normalizeForCompare(address).includes(normalizeForCompare(city))) return address;
  return `${address}, ${city}`;
}

function removeHouseNumber(value: string): string {
  const postalIndex = value.search(/\b\d{5}\b/);
  const prefix = (postalIndex >= 0 ? value.slice(0, postalIndex) : value.split(",")[0]).replace(/[,\s]+$/, "");
  const suffix = postalIndex >= 0 ? value.slice(postalIndex) : value.split(",").slice(1).join(", ");
  const withoutNumber = prefix
    .replace(/\s+\d+[a-zA-Z]?(?:\s*[-–/]\s*\d+[a-zA-Z]?)?\s*$/u, "")
    .replace(/[,.\s]+$/, "")
    .trim();
  return [withoutNumber, suffix.trim()].filter(Boolean).join(", ");
}

function extractCityFromAddress(address: string, postalCode?: string): string {
  if (postalCode) {
    const afterPostalCode = address.slice(address.indexOf(postalCode) + postalCode.length);
    return afterPostalCode.replace(/^[,\s]+/, "").split(",")[0]?.trim() ?? "";
  }
  const segments = address.split(",").map((item) => item.trim()).filter(Boolean);
  return segments.length > 1 ? segments.at(-1) ?? "" : "";
}

function dedupeCandidates<T extends { query: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = normalizeForCompare(item.query);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeForCompare(value: string): string {
  return value.toLocaleLowerCase("de-DE").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function isNotFound(error: unknown): error is { statusCode: number } {
  return typeof error === "object" && error !== null && "statusCode" in error
    && (error as { statusCode?: unknown }).statusCode === 404;
}

function isUnavailable(error: unknown): boolean {
  const status = typeof error === "object" && error !== null ? (error as { statusCode?: unknown }).statusCode : undefined;
  return status === 429 || status === 502 || status === 503 || status === 504;
}

export type PrintedParts = { street?: string; houseNumber?: string; postalCode?: string; city?: string };

/** Street, house number, postcode and town as the Auftrag prints them: what a found place has to match. */
export function printedParts(address: string, city?: string | null): PrintedParts {
  return addressParts(address, city);
}

export type MatchVerdict = {
  street: "same" | "other" | "unknown";
  house: "same" | "other" | "missing" | "unknown";
  postcode: "same" | "other" | "unknown";
};

/** What a found place says against the printed address. «unknown» = one of the two has no such part to compare. */
export function matchOf(printed: PrintedParts, found: { street?: string | null; houseNumber?: string | null; postalCode?: string | null }): MatchVerdict {
  const street = !printed.street || !found.street ? "unknown" : sameStreet(printed.street, found.street) ? "same" : "other";
  const house = !printed.houseNumber ? "unknown" : !found.houseNumber ? "missing" : sameHouse(printed.houseNumber, found.houseNumber) ? "same" : "other";
  const postcode = !printed.postalCode || !found.postalCode ? "unknown" : printed.postalCode === found.postalCode ? "same" : "other";
  return { street, house, postcode };
}

/** «Zachower Str.» = «Zachower Straße»; a letter or two of a typo is forgiven in a long name, not in a short one. */
export function sameStreet(left: string, right: string): boolean {
  const key = (value: string) => value.toLocaleLowerCase("de-DE").replace(/ß/g, "ss").replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue")
    .replace(/(^|[\s-])dr\.?(?=[\s-])/g, "$1doktor").replace(/(^|[\s-])st\.?(?=[\s-])/g, "$1sankt")
    .replace(/(strasse|str\.?)(?=[^\p{L}]|$)/gu, "str").replace(/[^\p{L}\p{N}]+/gu, "");
  const a = key(left), b = key(right);
  if (!a || !b) return false;
  if (a === b) return true;
  const shorter = Math.min(a.length, b.length);
  // «Lehmanger» is «Am Lehmanger».
  if (shorter >= 8 && (a.endsWith(b) || b.endsWith(a))) return true;
  return editDistance(a, b) <= (shorter >= 12 ? 2 : shorter >= 7 ? 1 : 0);
}

/** «22-28» holds 22; «2b» is the house 2. */
function sameHouse(printed: string, found: string): boolean {
  const numbers = (value: string) => (value.match(/\d+/g) ?? []).map(Number);
  const wanted = numbers(printed), got = numbers(found)[0];
  if (got === undefined || !wanted.length) return false;
  return wanted.length > 1 && /[-–]/.test(printed) ? got >= wanted[0] && got <= wanted[1] : wanted.includes(got);
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) current.push(Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)));
    previous = current;
  }
  return previous[b.length];
}
