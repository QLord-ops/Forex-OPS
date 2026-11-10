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

export type AddressResolution = GeocodeResult & {
  sourceAddress: string;
  resolvedAddress: string;
  precision: GeocodePrecision;
  attempts: string[];
  researchUsed?: boolean;
  researchCandidates?: AddressResearchCandidate[];
  check?: AddressCheck | null;
};

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
  const result = await resolveCore(routing, input, researcher, rules, places, sources.places);
  const check = await checking;
  return check === undefined ? result : { ...result, check };
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
  /** Kilometres from the town when the result lies too far from it; null when it is plausible or cannot be checked. */
  const farFromCity = async (point: { latitude: number; longitude: number }, resultCity?: string | null): Promise<number | null> => {
    if (!anchor) return null;
    if (resultCity && sameCity(resultCity, anchor.city)) return null;
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
      const km = await farFromCity(hit, hit.city);
      if (km === null) {
        attempts.push(`TomTom: ${input.company.trim()} у ${anchor.query}`);
        return { ...hit, sourceAddress, resolvedAddress: hit.label, precision: "EXACT", attempts };
      }
      attempts.push(`TomTom: ${hit.label}: ${Math.round(km)} км от ${anchor.query}, отброшено`);
    }
  }

  const candidates = buildAddressCandidates(sourceAddress, city, input.company);
  let lastNotFound: unknown;
  let approximateResult: AddressResolution | undefined;

  for (const candidate of candidates) {
    attempts.push(candidate.query);
    try {
      const result = await routing.geocode(candidate.query);
      const km = await farFromCity(result, result.city);
      if (km !== null) {
        attempts.push(`${result.label}: ${Math.round(km)} км от ${anchor!.query}, отброшено`);
        lastNotFound = { statusCode: 404 };
        continue;
      }
      const resolved = {
        ...result,
        sourceAddress,
        resolvedAddress: result.label,
        precision: candidate.precision,
        attempts
      };
      if (candidate.precision === "EXACT" || candidate.precision === "STREET" || !researcher) return resolved;
      approximateResult = resolved;
      break;
    } catch (error) {
      if (isNotFound(error)) {
        lastNotFound = error;
        continue;
      }
      throw error;
    }
  }

  if (researcher && isNotFound(lastNotFound)) {
    const researchCandidates = await researcher.research(input);
    for (const candidate of researchCandidates) {
      if (attempts.some((attempt) => normalizeForCompare(attempt) === normalizeForCompare(candidate.address))) continue;
      attempts.push(candidate.address);
      try {
        const result = await routing.geocode(candidate.address);
        const km = await farFromCity(result, result.city);
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
        throw error;
      }
    }
  }

  if (approximateResult) return approximateResult;
  throw new RoutingError(`Адрес не найден. Проверены: ${attempts.join(" → ")}.`, 404);
}

/** The town a stop belongs to, as a geocoder query: "14974 Ludwigsfelde" when the postcode is printed, else the city. */
export function cityAnchor(address: string, city?: string | null): { query: string; city: string } | null {
  const normalizedAddress = normalizeGermanAddress(address);
  const postalCode = normalizedAddress.match(/\b\d{5}\b/)?.[0] ?? (city ?? "").match(/\b\d{5}\b/)?.[0];
  const effectiveCity = normalizeCity(city) || extractCityFromAddress(normalizedAddress, postalCode);
  if (!effectiveCity || /\d/.test(effectiveCity)) return null;
  return { query: postalCode ? `${postalCode} ${effectiveCity}` : effectiveCity, city: effectiveCity };
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

export function buildAddressCandidates(address: string, city?: string | null, company?: string | null): Array<{ query: string; precision: GeocodePrecision }> {
  const normalizedAddress = normalizeGermanAddress(address);
  const normalizedCity = normalizeCity(city);
  const exact = appendCity(normalizedAddress, normalizedCity);
  const street = removeHouseNumber(normalizedAddress);
  const addressPostalCode = normalizedAddress.match(/\b\d{5}\b/)?.[0];
  const postalCode = addressPostalCode ?? (city ?? "").match(/\b\d{5}\b/)?.[0];
  const cityFromAddress = extractCityFromAddress(normalizedAddress, addressPostalCode);
  const effectiveCity = normalizedCity || cityFromAddress;
  // Only a city was printed ("Bremen" for "Seifert & BLG Bremen"): the company in that city first, the bare city last,
  // and never a city centre presented as an exact address.
  if (company?.trim() && effectiveCity && normalizeForCompare(normalizedAddress) === normalizeForCompare(effectiveCity)) {
    return dedupeCandidates([
      { query: `${company.trim()}, ${effectiveCity}`, precision: "POSTCODE_CITY" },
      { query: effectiveCity, precision: "CITY" }
    ]);
  }

  return dedupeCandidates([
    { query: exact, precision: "EXACT" },
    ...(street && street !== normalizedAddress
      ? [{ query: appendCity(street, effectiveCity), precision: "STREET" as const }]
      : []),
    ...(postalCode && effectiveCity
      ? [{ query: `${postalCode} ${effectiveCity}`, precision: "POSTCODE_CITY" as const }]
      : []),
    // The company in the city finds a plant or warehouse when no street was printed ("BLG, Bremen").
    ...(company?.trim() && effectiveCity && !normalizedAddress.match(/\d/)
      ? [{ query: `${company.trim()}, ${effectiveCity}`, precision: "POSTCODE_CITY" as const }]
      : []),
    ...(effectiveCity ? [{ query: effectiveCity, precision: "CITY" as const }] : [])
  ]);
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
