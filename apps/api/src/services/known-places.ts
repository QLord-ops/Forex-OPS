import type { PrismaClient } from '@prisma/client';
import type { AddressResolution } from './address-resolution.js';
import { expandCity, findSiteRule, type AddressRuleRecord } from './address-rules.js';

/** A place of the address book with coordinates the fleet already trusts (Webfleet addresses today). */
export type KnownPlace = { name: string; street: string | null; postalCode: string | null; city: string | null; latitude: number; longitude: number; provider: string };

type StopPlace = { address?: string | null; city?: string | null; company?: string | null };

function fold(value: string | null | undefined): string {
  return (value ?? '').toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '');
}

/** "Rudolf-Diesel-Straße 2a" and "Rudolf Diesel Str. 2 A" are the same door. */
export function streetKey(street: string | null | undefined): string {
  const raw = fold(street).trim();
  // Letters first, the house number last: "14974 Ludwigsfelde" is a town, not a street.
  if (!/^\D*[a-z]{3}\D*\d{1,4}(\s*[-/]\s*\d{1,4})?\s*[a-z]?$/.test(raw)) return '';
  return raw.replace(/strasse\b/g, 'str').replace(/str\./g, 'str').replace(/[^a-z0-9]/g, '');
}

const nameKey = (name: string | null | undefined) => fold(name).replace(/\b(gmbh|ag|se|kg|co|mbh|ohg|ug|werk)\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
const postcodeOf = (address: string | null | undefined) => (address ?? '').match(/\b\d{5}\b/)?.[0] ?? null;

/**
 * The place a stop names, when the address book knows exactly that door: the same street with house number and the
 * same postcode. A stop without a street is matched by company and town only when the book has one such company
 * there. Anything less certain is left to the geocoder.
 */
export function findKnownPlace(stop: StopPlace, places: KnownPlace[]): KnownPlace | null {
  const address = (stop.address ?? '').trim();
  if (!address) return null;
  const postcode = postcodeOf(address) ?? postcodeOf(stop.city);
  const street = streetKey(address.split(',')[0]);
  if (street && postcode) {
    return places.find((place) => place.postalCode === postcode && streetKey(place.street) === street) ?? null;
  }
  if (street) return null;
  const company = nameKey(stop.company);
  const city = fold((stop.city ?? '').replace(/\b(?:D\s*[-–]?\s*)?\d{5}\b/gi, '')).replace(/[^a-z]/g, '');
  if (company.length < 4 || !city) return null;
  const same = places.filter((place) => nameKey(place.name) === company && fold(place.city).replace(/[^a-z]/g, '') === city && (!postcode || place.postalCode === postcode));
  return same.length === 1 ? same[0] : null;
}

function label(place: KnownPlace): string {
  return [place.name, place.street, [place.postalCode, place.city].filter(Boolean).join(' ')].filter(Boolean).join(', ');
}

export function knownPlaceResolution(place: KnownPlace, sourceAddress: string): AddressResolution {
  return { latitude: place.latitude, longitude: place.longitude, city: place.city ?? undefined, label: label(place), provider: place.provider,
    sourceAddress, resolvedAddress: label(place), precision: 'EXACT', attempts: [`адресная книга: ${place.name}`] } as AddressResolution;
}

/**
 * Coordinates a stop of a preview can carry at once, without asking the geocoder: a learned place rule of the same
 * town or a door of the address book. The page then has nothing to look up for this stop.
 */
export function resolveWithoutGeocoder(stop: StopPlace, rules: AddressRuleRecord[], places: KnownPlace[]): AddressResolution | null {
  const sourceAddress = (stop.address ?? '').trim();
  if (!sourceAddress) return null;
  const city = expandCity(stop.city ?? null, rules.length ? rules : undefined);
  const site = findSiteRule(stop.company, city, rules);
  // A rule may be used without the distance check only when it names the stop's own town or postcode; the same town
  // name with another printed postcode may be a namesake ("Petershagen"), so the geocoder path measures it instead.
  const stopPostcode = postcodeOf(sourceAddress) ?? postcodeOf(stop.city);
  const siteFits = site && site.latitude !== null && site.longitude !== null
    && (site.postalCode && stopPostcode ? site.postalCode === stopPostcode : Boolean(site.city && city && fold(site.city) === fold(city)));
  if (site && siteFits) {
    const text = [site.company, site.street, [site.postalCode, site.city].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    return { latitude: site.latitude!, longitude: site.longitude!, city: site.city ?? undefined, label: text, provider: 'address-rule',
      sourceAddress, resolvedAddress: text, precision: 'EXACT', attempts: [`правило: ${site.pattern}`] } as AddressResolution;
  }
  const place = findKnownPlace({ ...stop, city }, places);
  return place ? knownPlaceResolution(place, sourceAddress) : null;
}

/** The address book in memory for a minute: every stop of every preview asks it. */
export class KnownPlaces {
  private cache: { at: number; places: KnownPlace[] } | null = null;

  constructor(private readonly db: Pick<PrismaClient, 'knownAddress'>, private readonly ttlMs = 60_000) {}

  async all(now = Date.now()): Promise<KnownPlace[]> {
    if (this.cache && now - this.cache.at < this.ttlMs) return this.cache.places;
    const rows = await this.db.knownAddress.findMany({ where: { active: true }, select: { source: true, name: true, street: true, postalCode: true, city: true, latitude: true, longitude: true }, take: 5000 });
    const places = rows.map((row) => ({ name: row.name, street: row.street, postalCode: row.postalCode, city: row.city, latitude: row.latitude, longitude: row.longitude,
      provider: row.source === 'WEBFLEET' ? 'webfleet-address' : 'ops-address' }));
    this.cache = { at: now, places };
    return places;
  }

  reset() { this.cache = null; }
}
