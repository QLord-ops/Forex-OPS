import type { GeocodeResult } from "../domain.js";
import type { AddressResearchCandidate, AddressResearcher } from "./address-research.js";
import type { RoutingProvider } from "./routing.js";
import { RoutingError } from "./routing.js";

export const geocodePrecisions = ["EXACT", "STREET", "POSTCODE_CITY", "CITY"] as const;
export type GeocodePrecision = (typeof geocodePrecisions)[number];

export type AddressResolution = GeocodeResult & {
  sourceAddress: string;
  resolvedAddress: string;
  precision: GeocodePrecision;
  attempts: string[];
  researchUsed?: boolean;
  researchCandidates?: AddressResearchCandidate[];
};

export async function resolveAddressWithFallback(
  routing: RoutingProvider,
  input: { address: string; city?: string | null },
  researcher?: AddressResearcher
): Promise<AddressResolution> {
  const sourceAddress = input.address.trim();
  if (!sourceAddress) throw new RoutingError("Адрес не может быть пустым.", 400);

  const candidates = buildAddressCandidates(sourceAddress, input.city);
  const attempts: string[] = [];
  let lastNotFound: unknown;
  let approximateResult: AddressResolution | undefined;

  for (const candidate of candidates) {
    attempts.push(candidate.query);
    try {
      const result = await routing.geocode(candidate.query);
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

export function buildAddressCandidates(address: string, city?: string | null): Array<{ query: string; precision: GeocodePrecision }> {
  const normalizedAddress = normalizeGermanAddress(address);
  const normalizedCity = normalizeCity(city);
  const exact = appendCity(normalizedAddress, normalizedCity);
  const street = removeHouseNumber(normalizedAddress);
  const postalCode = normalizedAddress.match(/\b\d{5}\b/)?.[0];
  const cityFromAddress = extractCityFromAddress(normalizedAddress, postalCode);
  const effectiveCity = normalizedCity || cityFromAddress;

  return dedupeCandidates([
    { query: exact, precision: "EXACT" },
    ...(street && street !== normalizedAddress
      ? [{ query: appendCity(street, effectiveCity), precision: "STREET" as const }]
      : []),
    ...(postalCode && effectiveCity
      ? [{ query: `${postalCode} ${effectiveCity}`, precision: "POSTCODE_CITY" as const }]
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
