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

/** Places learned from where trucks stood at them (stay-places.ts). */
export const STAY_PROVIDER = 'gps-stay';

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
    const doors = places.filter((place) => place.postalCode === postcode && streetKey(place.street) === street);
    // Where trucks really stood beats the postal point of the same door.
    return doors.find((place) => place.provider === STAY_PROVIDER) ?? doors[0] ?? null;
  }
  if (street) return null;
  const company = nameKey(stop.company);
  const city = fold((stop.city ?? '').replace(/\b(?:D\s*[-–]?\s*)?\d{5}\b/gi, '')).replace(/[^a-z]/g, '');
  if (company.length < 4 || !city) return null;
  const same = places.filter((place) => nameKey(place.name) === company && fold(place.city).replace(/[^a-z]/g, '') === city && (!postcode || place.postalCode === postcode));
  const stood = same.filter((place) => place.provider === STAY_PROVIDER);
  if (stood.length === 1) return stood[0];
  return same.length === 1 ? same[0] : null;
}

/** A stored point farther than this from the other known places of its postcode region is not of that region. */
const REGION_KM = 150;
const REGION_WITNESSES = 3;

function kmApart(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * rad, dLon = (b.longitude - a.longitude) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

/**
 * Whether a stored point can belong to a printed postcode, judged without the geocoder: the first two digits are one
 * region of Germany, and the address book knows where that region lies. A learned place saved in the namesake town
 * («15370 Petershagen» at Berlin drawn at Minden, owner 20.11.2026) lies hundreds of km from it. Null when the book
 * has too few places of that region to tell: then the geocoder path measures the point against the postcode itself.
 */
export function fitsPostcodeRegion(point: { latitude: number; longitude: number }, postcode: string, places: KnownPlace[]): boolean | null {
  const region = postcode.slice(0, 2);
  const witnesses = places.filter((place) => place.postalCode?.startsWith(region)
    && (Math.abs(place.latitude - point.latitude) > 0.0005 || Math.abs(place.longitude - point.longitude) > 0.0005));
  if (witnesses.length < REGION_WITNESSES) return null;
  const middle = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)]; };
  const centre = { latitude: middle(witnesses.map((place) => place.latitude)), longitude: middle(witnesses.map((place) => place.longitude)) };
  return kmApart(centre, point) <= REGION_KM;
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
  // With a printed postcode the stored point itself must lie in that postcode's region: its label is not proof.
  const inRegion = (point: { latitude: number; longitude: number }) => !stopPostcode || fitsPostcodeRegion(point, stopPostcode, places) === true;
  const siteFits = site && site.latitude !== null && site.longitude !== null
    && (site.postalCode && stopPostcode ? site.postalCode === stopPostcode : Boolean(site.city && city && fold(site.city) === fold(city)))
    && inRegion({ latitude: site.latitude, longitude: site.longitude });
  if (site && siteFits) {
    const text = [site.company, site.street, [site.postalCode, site.city].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    return { latitude: site.latitude!, longitude: site.longitude!, city: site.city ?? undefined, label: text, provider: 'address-rule',
      sourceAddress, resolvedAddress: text, precision: 'EXACT', attempts: [`правило: ${site.pattern}`] } as AddressResolution;
  }
  const place = findKnownPlace({ ...stop, city }, places);
  if (!place) return null;
  // A gate was learned from trucks that stood at the stop itself: only evidence against it drops it.
  const trusted = place.provider === STAY_PROVIDER ? !stopPostcode || fitsPostcodeRegion(place, stopPostcode, places) !== false : inRegion(place);
  return trusted ? knownPlaceResolution(place, sourceAddress) : null;
}

/** The address book in memory for a minute: every stop of every preview asks it. */
export class KnownPlaces {
  private cache: { at: number; places: KnownPlace[] } | null = null;

  constructor(private readonly db: Pick<PrismaClient, 'knownAddress'>, private readonly ttlMs = 60_000) {}

  async all(now = Date.now()): Promise<KnownPlace[]> {
    if (this.cache && now - this.cache.at < this.ttlMs) return this.cache.places;
    const rows = await this.db.knownAddress.findMany({ where: { active: true }, select: { source: true, name: true, street: true, postalCode: true, city: true, latitude: true, longitude: true }, take: 5000 });
    const places = rows.map((row) => ({ name: row.name, street: row.street, postalCode: row.postalCode, city: row.city, latitude: row.latitude, longitude: row.longitude,
      provider: row.source === 'WEBFLEET' ? 'webfleet-address' : row.source === 'GPS_STAY' ? STAY_PROVIDER : 'ops-address' }));
    this.cache = { at: now, places };
    return places;
  }

  reset() { this.cache = null; }
}
