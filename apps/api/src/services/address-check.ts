import type { GeocodeResult } from "../domain.js";

export type AddressCheckStatus = "OK" | "UNKNOWN_POSTCODE" | "POSTCODE_NOT_IN_CITY" | "STREET_NOT_IN_POSTCODE";
export type AddressCheck = { status: AddressCheckStatus; message?: string; cities?: string[] };

export interface AddressChecker {
  check(input: { address: string; city?: string | null }): Promise<AddressCheck | null>;
}

export interface PlaceSearch {
  findCompany(company: string, near: { latitude: number; longitude: number }): Promise<(GeocodeResult & { postalCode?: string }) | null>;
}

type Fetch = typeof fetch;
const TIMEOUT_MS = 5_000;

/** Official German postcodes and streets (openplzapi.org, free, no key). Any failure means "not checked", never an alarm. */
export class OpenPlzChecker implements AddressChecker {
  private readonly cache = new Map<string, Promise<unknown>>();
  private readonly baseUrl: string;

  constructor(private readonly fetchImpl: Fetch = fetch, baseUrl = process.env.OPENPLZ_BASE_URL || "https://openplzapi.org/") {
    this.baseUrl = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  }

  async check(input: { address: string; city?: string | null }): Promise<AddressCheck | null> {
    const parts = addressParts(input.address, input.city);
    if (!parts.postalCode) return null;
    try {
      const localities = await this.get<Array<{ name: string }>>("de/Localities", { postalCode: parts.postalCode, pageSize: "50" });
      const cities = [...new Set(localities.map((item) => item.name))];
      if (!cities.length) return { status: "UNKNOWN_POSTCODE", message: `Индекса ${parts.postalCode} нет в справочнике Германии. Проверьте индекс.` };
      if (parts.city && !cities.some((name) => sameTown(name, parts.city!))) {
        return { status: "POSTCODE_NOT_IN_CITY", cities,
          message: `Индекс ${parts.postalCode} — это ${cities.slice(0, 3).join(", ")}, а не ${parts.city}. Проверьте индекс или город.` };
      }
      const stem = parts.street ? streetStem(parts.street) : "";
      if (stem.length >= 3) {
        const streets = await this.get<Array<{ name: string }>>("de/Streets", { name: stem.slice(0, 6), postalCode: parts.postalCode, pageSize: "50" });
        const wanted = streetKey(parts.street!);
        if (!streets.some((item) => { const key = streetKey(item.name); return key.startsWith(wanted) || wanted.startsWith(key); })) {
          return { status: "STREET_NOT_IN_POSTCODE", cities,
            message: `Улицы «${parts.street}» нет при индексе ${parts.postalCode} (${cities[0]}). Проверьте улицу или индекс.` };
        }
      }
      return { status: "OK", cities };
    } catch {
      return null;
    }
  }

  private get<T>(path: string, query: Record<string, string>): Promise<T> {
    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const key = url.toString();
    let request = this.cache.get(key) as Promise<T> | undefined;
    if (!request) {
      request = fetchJson<T>(this.fetchImpl, url);
      request.catch(() => this.cache.delete(key));
      if (this.cache.size > 2_000) this.cache.delete(this.cache.keys().next().value as string);
      this.cache.set(key, request);
    }
    return request;
  }
}

/** Company search near the stop's town (TomTom Search, same server key as routing). Off without the key. */
export class TomTomPlaceSearch implements PlaceSearch {
  private readonly cache = new Map<string, Promise<(GeocodeResult & { postalCode?: string }) | null>>();
  private day = "";
  private used = 0;

  constructor(
    private readonly fetchImpl: Fetch = fetch,
    private readonly config: { apiKey?: string; enabled?: boolean; baseUrl?: string; dailyCap?: number } = {}
  ) {}

  private get apiKey() { return this.config.apiKey ?? process.env.TOMTOM_API_KEY ?? process.env.TOMTOM_ROUTING_API_KEY; }
  private get enabled() { return this.config.enabled ?? process.env.TOMTOM_FREE_TIER_CONFIRMED === "true"; }

  async findCompany(company: string, near: { latitude: number; longitude: number }) {
    const name = company.trim();
    if (!name || !this.enabled || !this.apiKey) return null;
    const key = `${normalize(name)}|${near.latitude.toFixed(2)}|${near.longitude.toFixed(2)}`;
    let request = this.cache.get(key);
    if (!request) {
      if (!this.spend()) return null;
      request = this.search(name, near).catch(() => null);
      if (this.cache.size > 1_000) this.cache.delete(this.cache.keys().next().value as string);
      this.cache.set(key, request);
    }
    return request;
  }

  private spend(): boolean {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.day) { this.day = today; this.used = 0; }
    const cap = this.config.dailyCap ?? Number(process.env.TOMTOM_SEARCH_DAILY_CAP || 1_000);
    if (this.used >= cap) return false;
    this.used += 1;
    return true;
  }

  private async search(company: string, near: { latitude: number; longitude: number }) {
    const base = this.config.baseUrl ?? process.env.TOMTOM_ROUTING_BASE_URL ?? "https://api.tomtom.com/";
    const url = new URL(`search/2/search/${encodeURIComponent(company)}.json`, base.endsWith("/") ? base : `${base}/`);
    for (const [k, v] of Object.entries({ key: this.apiKey!, countrySet: "DE", language: "de-DE", limit: "5",
      lat: String(near.latitude), lon: String(near.longitude), radius: "25000", idxSet: "POI" })) url.searchParams.set(k, v);
    const data = await fetchJson<{ results?: TomTomResult[] }>(this.fetchImpl, url);
    const wanted = companyTokens(company);
    const hit = (data.results ?? []).find((item) => {
      const tokens = companyTokens(item.poi?.name ?? "");
      return Boolean(item.position) && wanted.some((token) => tokens.includes(token));
    });
    if (!hit?.position) return null;
    const address = hit.address ?? {};
    const label = [hit.poi?.name, address.freeformAddress].filter(Boolean).join(", ");
    return { label, latitude: hit.position.lat, longitude: hit.position.lon, provider: "tomtom-search",
      city: address.municipality, postalCode: address.postalCode };
  }
}

type TomTomResult = { poi?: { name?: string }; position?: { lat: number; lon: number };
  address?: { freeformAddress?: string; municipality?: string; postalCode?: string } };

async function fetchJson<T>(fetchImpl: Fetch, url: URL): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { signal: controller.signal, headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/** Street, postcode and city from a printed address: "Industriestr. 5, D-38239 Salzgitter". */
export function addressParts(address: string, city?: string | null): { street?: string; postalCode?: string; city?: string } {
  const text = address.replace(/\bD\s*[-–]?\s*(?=\d{5}\b)/gi, "").replace(/\s+/g, " ").trim();
  const postalCode = text.match(/\b\d{5}\b/)?.[0] ?? (city ?? "").match(/\b\d{5}\b/)?.[0];
  const cityName = (city ?? "").replace(/\bD\s*[-–]?\s*/gi, "").replace(/\b\d{5}\b/, "").replace(/[,.\s]+$/, "").trim()
    || (postalCode && text.includes(postalCode) ? text.slice(text.indexOf(postalCode) + 5).replace(/^[,\s]+/, "").split(",")[0]!.trim() : "");
  const head = (postalCode && text.includes(postalCode) ? text.slice(0, text.indexOf(postalCode)) : text).split(",").map((s) => s.trim()).filter(Boolean);
  // The street is the part with a house number; a line without one ("Werk 2", a company) is not checked.
  const street = head.find((part) => /\p{L}{3,}.*\s\d+\s*[a-zA-Z]?(\s*[-/]\s*\d+[a-zA-Z]?)?$/u.test(part))
    ?.replace(/\s+\d+\s*[a-zA-Z]?(\s*[-/]\s*\d+[a-zA-Z]?)?$/u, "").trim();
  return { street: street || undefined, postalCode, city: cityName && !/\d/.test(cityName) ? cityName : undefined };
}

function streetStem(street: string): string {
  return street.replace(/(straße|strasse|str\.?)(?=\s|$)/giu, "").replace(/[^\p{L}\s-]/gu, "").replace(/\s+/g, " ").trim();
}

function streetKey(street: string): string {
  return normalize(street.replace(/(straße|strasse|str\.?)(?=\s|$|-)/giu, "str"));
}

function sameTown(a: string, b: string): boolean {
  const x = normalize(a), y = normalize(b);
  return x === y || x.startsWith(`${y} `) || y.startsWith(`${x} `) || x.includes(y) || y.includes(x);
}

const LEGAL = new Set(["gmbh", "co", "kg", "ag", "se", "mbh", "und", "ohg", "logistik", "logistics", "werk", "the", "der", "die", "das"]);
function companyTokens(value: string): string[] {
  return normalize(value).split(" ").filter((token) => token.length >= 3 && !LEGAL.has(token));
}

function normalize(value: string): string {
  return value.toLocaleLowerCase("de-DE").replace(/ß/g, "ss").replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}
