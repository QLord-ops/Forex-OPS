import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { addressSearchText } from './address-book.js';
import { writeAuditLog, type AuditActor } from './audit-log.js';
import { streetKey } from './known-places.js';

export const OWN_SOURCE = 'OPS';
// The fleet's own yard: it is a stop of many tours and must never be remembered under a customer's name.
const OWN_YARD = { postalCode: '37120', street: streetKey('Büttenstraße 4'), name: 'forex' };
// Places the dispatcher or the address book already vouched for, whatever precision the stop carries.
const TRUSTED_PROVIDERS = new Set(['webfleet-address', 'ops-address', 'address-rule']);

export type RememberedStop = {
  company: string | null; address: string | null; city: string | null; latitude: number | null; longitude: number | null;
  geocodePrecision: string | null; geocodeProvider: string | null;
};
export type OwnAddress = { key: string; name: string; street: string; postalCode: string; city: string | null; latitude: number; longitude: number };
export type RememberResult = { added: number; counted: number; skipped: number };

const fold = (value: string) => value.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * A stop worth remembering: a named company at a street with house number and postcode, with a point on the map
 * that is the door itself. A town centre, a street without number or a guess of the web search is not an address
 * to suggest later.
 */
export function ownAddressOf(stop: RememberedStop): OwnAddress | null {
  const name = (stop.company ?? '').trim();
  const address = (stop.address ?? '').trim();
  if (name.length < 2 || !address || stop.latitude === null || stop.longitude === null) return null;
  if (stop.latitude === 0 && stop.longitude === 0) return null;
  const provider = (stop.geocodeProvider ?? '').toLowerCase();
  if (provider.startsWith('openai-web')) return null;
  if (stop.geocodePrecision !== 'EXACT' && !TRUSTED_PROVIDERS.has(provider)) return null;
  const street = address.split(',')[0].trim();
  const postalCode = address.match(/\b\d{5}\b/)?.[0];
  const key = streetKey(street);
  if (!key || !postalCode) return null;
  if (postalCode === OWN_YARD.postalCode && key === OWN_YARD.street && !fold(name).includes(OWN_YARD.name)) return null;
  const city = (stop.city ?? '').trim() || address.slice(address.indexOf(postalCode) + 5).split(',')[0].trim() || null;
  return { key: `${postalCode}|${key}`, name: name.slice(0, 200), street: street.slice(0, 200), postalCode, city: city ? city.slice(0, 200) : null,
    latitude: Math.round(stop.latitude * 1e6) / 1e6, longitude: Math.round(stop.longitude * 1e6) / 1e6 };
}

const externalIdOf = (address: OwnAddress) => `ops:${createHash('sha256').update(`${fold(address.name)}|${address.key}`).digest('hex').slice(0, 24)}`;

/**
 * The fleet's own address book: every exact address a dispatcher confirmed in a tour is remembered and suggested
 * the next time (owner's decision 09.11.2026). A door the book already has — from Webfleet or from an earlier tour
 * — is only counted, so the most used addresses come first.
 */
export class OwnAddressBook {
  constructor(private readonly db: PrismaClient, private readonly onChange: () => void = () => undefined) {}

  /** Remembers the stops of a saved tour. Never throws into the caller's way: a tour is saved with or without it. */
  async rememberTour(tourId: string, actor?: AuditActor, now = new Date()): Promise<RememberResult> {
    const tour = await this.db.tour.findUnique({ where: { id: tourId }, select: { customer: { select: { name: true } },
      stops: { select: { company: true, address: true, city: true, latitude: true, longitude: true, geocodePrecision: true, geocodeProvider: true } } } });
    if (!tour) return { added: 0, counted: 0, skipped: 0 };
    return this.remember(tour.stops, { group: tour.customer?.name ?? null, actor, now, audit: true });
  }

  private async remember(stops: RememberedStop[], options: { group: string | null; actor?: AuditActor; now: Date; audit: boolean; dryRun?: boolean }): Promise<RememberResult> {
    const result = { added: 0, counted: 0, skipped: 0 };
    const seen = new Set<string>();
    for (const stop of stops) {
      const address = ownAddressOf(stop);
      if (!address || seen.has(address.key)) { if (!address) result.skipped += 1; continue; }
      seen.add(address.key);
      const sameDoor = (await this.db.knownAddress.findMany({ where: { postalCode: address.postalCode }, select: { id: true, street: true } }))
        .find((row) => streetKey(row.street) === address.key.split('|')[1]);
      if (sameDoor) {
        result.counted += 1;
        if (!options.dryRun) await this.db.knownAddress.update({ where: { id: sameDoor.id }, data: { useCount: { increment: 1 }, lastSeenAt: options.now } });
        continue;
      }
      result.added += 1;
      if (options.dryRun) continue;
      const groups = options.group ? [options.group] : [];
      await this.db.$transaction(async (tx) => {
        const saved = await tx.knownAddress.create({ data: { source: OWN_SOURCE, externalId: externalIdOf(address), name: address.name, street: address.street, postalCode: address.postalCode,
          city: address.city, latitude: address.latitude, longitude: address.longitude, groups: groups.join(' | ') || null,
          searchText: addressSearchText({ name: address.name, name2: null, street: address.street, postalCode: address.postalCode, city: address.city }, groups), useCount: 1, lastSeenAt: options.now } });
        if (options.audit) await writeAuditLog(tx, options.actor, { action: 'KNOWN_ADDRESS_LEARNED', entityType: 'KnownAddress', entityId: saved.id, metadata: { postalCode: address.postalCode, city: address.city }, createdAt: options.now });
      });
    }
    if (result.added && !options.dryRun) this.onChange();
    return result;
  }

  /**
   * Addresses of tours saved before this book existed. Without `apply` it only counts what it would add; with it
   * the addresses are written and one audit entry records how many.
   */
  async backfill(apply: boolean, actor?: AuditActor, now = new Date()): Promise<RememberResult & { applied: boolean }> {
    const stops = await this.db.stop.findMany({ where: { company: { not: null } }, orderBy: { id: 'asc' }, take: 20_000,
      select: { company: true, address: true, city: true, latitude: true, longitude: true, geocodePrecision: true, geocodeProvider: true } });
    const result = await this.remember(stops, { group: null, actor, now, audit: false, dryRun: !apply });
    if (apply) await writeAuditLog(this.db, actor, { action: 'KNOWN_ADDRESSES_BACKFILLED', entityType: 'KnownAddress', entityId: 'own', metadata: { ...result, stops: stops.length }, createdAt: now });
    return { ...result, applied: apply };
  }

  async list(query: string, take = 50) {
    const words = fold(query).split(' ').filter((word) => word.length >= 2).slice(0, 5);
    const [rows, total] = await Promise.all([
      this.db.knownAddress.findMany({ where: { source: OWN_SOURCE, AND: words.map((word) => ({ searchText: { contains: word } })) }, orderBy: [{ useCount: 'desc' }, { name: 'asc' }], take: Math.max(1, Math.min(take, 200)),
        select: { id: true, name: true, street: true, postalCode: true, city: true, groups: true, active: true, useCount: true, lastSeenAt: true } }),
      this.db.knownAddress.count({ where: { source: OWN_SOURCE, active: true } })
    ]);
    return { total, addresses: rows.map((row) => ({ ...row, lastSeenAt: row.lastSeenAt.toISOString() })) };
  }

  /** Hides a wrong address from the suggestions or brings it back. Only the fleet's own rows: Webfleet rows belong to Webfleet. */
  async setActive(id: string, active: boolean, actor?: AuditActor, now = new Date()) {
    const row = await this.db.knownAddress.findUnique({ where: { id }, select: { id: true, source: true, active: true } });
    if (!row || row.source !== OWN_SOURCE) return null;
    const saved = await this.db.$transaction(async (tx) => {
      const updated = await tx.knownAddress.update({ where: { id }, data: { active }, select: { id: true, active: true } });
      await writeAuditLog(tx, actor, { action: active ? 'KNOWN_ADDRESS_RESTORED' : 'KNOWN_ADDRESS_HIDDEN', entityType: 'KnownAddress', entityId: id, createdAt: now });
      return updated;
    });
    this.onChange();
    return saved;
  }
}
