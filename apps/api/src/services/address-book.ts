import type { PrismaClient } from '@prisma/client';
import { normalizePattern } from './address-rules.js';
import { writeAuditLog, type AuditActor } from './audit-log.js';
import { readWebfleetConfig, webfleetRequest, WebfleetError, type WebfleetConfig, type WebfleetErrorCategory, type WebfleetReadAction } from './webfleet.js';

const SOURCE = 'WEBFLEET';
const STATE_ID = 'WEBFLEET:ADDRESSES';
const MINUTE = 60_000;
/** The address book changes rarely; a full read every 6 hours is far below the 6 requests/minute limit. */
const SYNC_INTERVAL_MS = 6 * 60 * MINUTE;
const LEASE_MS = 2 * MINUTE;
/** Only right after a successful position snapshot, so wrong credentials never cost an extra login. */
const CREDENTIALS_PROVEN_MS = 3 * MINUTE;
const ERROR_DELAY_MS: Record<WebfleetErrorCategory, number> = {
  AUTH: 30 * MINUTE, PERMISSION: 30 * MINUTE, CONFIG: 30 * MINUTE,
  RATE_LIMIT: 10 * MINUTE, NETWORK: 10 * MINUTE, INVALID_RESPONSE: 10 * MINUTE, UNKNOWN: 10 * MINUTE
};
/** Only the address fields: contacts, phones, e-mail and notes are never requested (DSGVO). */
const ADDRESS_COLUMNS = 'addruid,addrnr,addrname1,addrname2,addrstreet,addrzip,addrcity,addrstate,addrregion,positionx,positiony,radius';

export type WebfleetAddress = {
  externalId: string; externalNumber: string | null; name: string; name2: string | null; street: string | null; postalCode: string | null;
  city: string | null; country: string | null; region: string | null; latitude: number; longitude: number; radiusMeters: number | null;
};
export type AddressBookState = { at: string | null; nextAt: string | null; error: WebfleetErrorCategory | null; providerCode: number | null; total: number | null; added?: number; updated?: number; hidden?: number };

function text(value: Record<string, unknown>, key: string): string | null {
  const raw = value[key];
  const result = typeof raw === 'string' ? raw.trim() : typeof raw === 'number' ? String(raw) : '';
  return result ? result.slice(0, 200) : null;
}
function micro(value: Record<string, unknown>, key: string): number | null {
  const raw = typeof value[key] === 'number' ? value[key] as number : typeof value[key] === 'string' ? Number(value[key]) : NaN;
  return Number.isFinite(raw) ? raw / 1e6 : null;
}

/** One Webfleet address row → our fields. Coordinates come as WGS84 micro-degrees; an address without a position is useless here. */
export function parseWebfleetAddress(value: unknown): WebfleetAddress | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const externalId = text(row, 'addruid');
  const latitude = micro(row, 'positiony');
  const longitude = micro(row, 'positionx');
  if (!externalId || latitude === null || longitude === null || (latitude === 0 && longitude === 0) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  const name = text(row, 'addrname1') ?? text(row, 'addrname2') ?? [text(row, 'addrstreet'), text(row, 'addrcity')].filter(Boolean).join(', ');
  if (!name) return null;
  const radius = Number(row.radius);
  return { externalId, externalNumber: text(row, 'addrnr'), name, name2: text(row, 'addrname1') ? text(row, 'addrname2') : null, street: text(row, 'addrstreet'),
    postalCode: text(row, 'addrzip'), city: text(row, 'addrcity'), country: text(row, 'addrstate'), region: text(row, 'addrregion'),
    latitude: Math.round(latitude * 1e6) / 1e6, longitude: Math.round(longitude * 1e6) / 1e6, radiusMeters: Number.isFinite(radius) && radius > 0 ? Math.round(radius) : null };
}
export function addressSearchText(address: Pick<WebfleetAddress, 'name' | 'name2' | 'street' | 'postalCode' | 'city'>, groups: string[] = []) {
  return normalizePattern([address.name, address.name2, address.street, address.postalCode, address.city, ...groups].filter(Boolean).join(' '));
}

type Request = (config: WebfleetConfig, action: WebfleetReadAction, params?: Record<string, string>) => Promise<unknown[]>;
type Db = PrismaClient;

/**
 * Copies the Webfleet address book into OPS for address suggestions. Read-only towards Webfleet; a full snapshot each time
 * (Webfleet has no change tracking), compared by the stable addruid: new rows are added, changed rows updated, missing rows hidden.
 */
export class AddressBookSync {
  private running = false;
  constructor(private readonly db: Db, private readonly config: WebfleetConfig | null = readWebfleetConfig(),
    private readonly request: Request = (config, action, params) => webfleetRequest(config, action, params)) {}

  async state(): Promise<AddressBookState & { configured: boolean }> {
    const row = await this.db.integrationSyncState.findUnique({ where: { id: STATE_ID } });
    const parsed = row?.cursor ? safeState(row.cursor) : null;
    return { configured: Boolean(this.config), at: parsed?.at ?? null, nextAt: parsed?.nextAt ?? null, error: parsed?.error ?? null, providerCode: parsed?.providerCode ?? null,
      total: await this.db.knownAddress.count({ where: { source: SOURCE, active: true } }), added: parsed?.added, updated: parsed?.updated, hidden: parsed?.hidden };
  }

  /** On the regular tick: only when due, after a fresh successful position snapshot, and by one instance at a time. */
  async refreshIfDue(now: Date, objectsAt: number) {
    if (!this.config || this.running || !objectsAt || now.getTime() - objectsAt > CREDENTIALS_PROVEN_MS) return null;
    const row = await this.db.integrationSyncState.findUnique({ where: { id: STATE_ID } });
    const state = row?.cursor ? safeState(row.cursor) : null;
    if (state?.nextAt && Date.parse(state.nextAt) > now.getTime()) return null;
    return this.run(now, undefined);
  }

  /** Admin button «Обновить из Webfleet»: runs now unless a pause after an error is still on. */
  async runNow(now: Date, actor: AuditActor) {
    if (!this.config) throw Object.assign(new Error('Webfleet не настроен на сервере.'), { statusCode: 503 });
    const row = await this.db.integrationSyncState.findUnique({ where: { id: STATE_ID } });
    const state = row?.cursor ? safeState(row.cursor) : null;
    if (state?.error && state.nextAt && Date.parse(state.nextAt) > now.getTime()) {
      throw Object.assign(new Error(`Webfleet на паузе после ошибки до ${new Date(state.nextAt).toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' })}.`), { statusCode: 409 });
    }
    return this.run(now, actor);
  }

  private async run(now: Date, actor: AuditActor | undefined) {
    if (this.running) return null;
    const leaseUntil = new Date(now.getTime() + LEASE_MS);
    await this.db.integrationSyncState.upsert({ where: { id: STATE_ID }, create: { id: STATE_ID, provider: SOURCE, cursor: null }, update: {} });
    const leased = await this.db.integrationSyncState.updateMany({ where: { id: STATE_ID, OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] }, data: { lockedUntil: leaseUntil } });
    if (!leased.count) return null;
    this.running = true;
    let next: AddressBookState;
    try {
      const rows = await this.request(this.config!, 'showAddressReportExtern', { columnfilter: ADDRESS_COLUMNS });
      let groups = new Map<string, string[]>();
      try {
        const links = await this.request(this.config!, 'showAddressGroupAddressReportExtern');
        groups = groupMap(links);
      } catch { /* Groups only help the search; the addresses are still useful without them. */ }
      const result = await this.apply(rows.map(parseWebfleetAddress).filter((item): item is WebfleetAddress => item !== null), groups, now);
      next = { at: now.toISOString(), nextAt: new Date(now.getTime() + SYNC_INTERVAL_MS).toISOString(), error: null, providerCode: null, ...result };
      await writeAuditLog(this.db, actor ?? { role: 'system', sessionId: 'address-book' }, { action: 'ADDRESS_BOOK_SYNCED', entityType: 'KnownAddress', entityId: 'webfleet', metadata: result });
    } catch (error) {
      const failure = error instanceof WebfleetError ? error : new WebfleetError('UNKNOWN');
      const previous = safeState((await this.db.integrationSyncState.findUnique({ where: { id: STATE_ID } }))?.cursor ?? null);
      next = { at: previous?.at ?? null, nextAt: new Date(now.getTime() + ERROR_DELAY_MS[failure.category]).toISOString(), error: failure.category, providerCode: failure.providerCode, total: previous?.total ?? null };
    } finally {
      this.running = false;
    }
    await this.db.integrationSyncState.update({ where: { id: STATE_ID }, data: { cursor: JSON.stringify(next), lockedUntil: null, ...(next.error ? {} : { lastSnapshotAt: now }) } });
    return next;
  }

  private async apply(addresses: WebfleetAddress[], groups: Map<string, string[]>, now: Date) {
    const existing = new Map((await this.db.knownAddress.findMany({ where: { source: SOURCE } })).map((row) => [row.externalId, row]));
    let added = 0, updated = 0;
    const seen = new Set<string>();
    const incoming = new Set(addresses.map((address) => address.externalId));
    // A deleted Webfleet address is hidden, not deleted: stops already planned with it keep their history.
    const missing = [...existing.values()].filter((row) => row.active && !incoming.has(row.externalId)).map((row) => row.id);
    await this.db.$transaction(async (tx) => {
      for (const address of addresses) {
        if (seen.has(address.externalId)) continue;
        seen.add(address.externalId);
        const groupNames = groups.get(address.externalId) ?? [];
        const data = { ...address, groups: groupNames.length ? groupNames.join(' | ') : null, searchText: addressSearchText(address, groupNames), active: true, lastSeenAt: now };
        const current = existing.get(address.externalId);
        if (!current) { await tx.knownAddress.create({ data: { ...data, source: SOURCE } }); added += 1; continue; }
        const changed = (Object.keys(data) as Array<keyof typeof data>).some((key) => key !== 'lastSeenAt' && current[key] !== data[key]);
        await tx.knownAddress.update({ where: { id: current.id }, data: changed ? data : { lastSeenAt: now } });
        if (changed) updated += 1;
      }
      if (missing.length) await tx.knownAddress.updateMany({ where: { id: { in: missing } }, data: { active: false } });
    }, { timeout: 60_000 });
    return { total: seen.size, added, updated, hidden: missing.length };
  }
}

function groupMap(rows: unknown[]) {
  const map = new Map<string, string[]>();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const record = row as Record<string, unknown>;
    const uid = text(record, 'addruid');
    const name = text(record, 'addressgroupname');
    if (uid && name) map.set(uid, [...(map.get(uid) ?? []), name]);
  }
  return map;
}
function safeState(raw: string | null): AddressBookState | null {
  try { return raw ? JSON.parse(raw) as AddressBookState : null; } catch { return null; }
}

export type AddressSuggestion = {
  id: string; source: 'WEBFLEET' | 'OPS' | 'RULE'; label: string; line2: string; company: string | null; street: string | null; postalCode: string | null; city: string | null;
  latitude: number; longitude: number; radiusMeters: number | null;
};

/**
 * Address suggestions while the dispatcher types: saved Webfleet addresses first, then sites OPS learned from imports.
 * Every word of the query must appear; a name that starts with the query ranks first, then the most used.
 */
export async function searchAddresses(db: Pick<PrismaClient, 'knownAddress' | 'addressRule'>, query: string, limit = 8): Promise<AddressSuggestion[]> {
  const words = normalizePattern(query).split(' ').filter((word) => word.length >= 2).slice(0, 5);
  if (!words.length) return [];
  const [known, rules] = await Promise.all([
    db.knownAddress.findMany({ where: { active: true, AND: words.map((word) => ({ searchText: { contains: word } })) }, take: 200 }),
    db.addressRule.findMany({ where: { kind: 'SITE', latitude: { not: null }, longitude: { not: null }, AND: words.map((word) => ({ pattern: { contains: word } })) }, take: 50 })
  ]);
  const first = words.join(' ');
  const rank = (name: string) => normalizePattern(name).startsWith(first) ? 0 : normalizePattern(name).split(' ').some((part) => part.startsWith(words[0])) ? 1 : 2;
  const fromWebfleet: AddressSuggestion[] = known
    .sort((a, b) => rank(a.name) - rank(b.name) || b.useCount - a.useCount || a.name.localeCompare(b.name, 'de'))
    .map((row) => ({ id: row.id, source: row.source === 'WEBFLEET' ? 'WEBFLEET' as const : 'OPS' as const, label: [row.name, row.name2].filter(Boolean).join(' · '), line2: [row.street, [row.postalCode, row.city].filter(Boolean).join(' ')].filter(Boolean).join(', '),
      company: row.name, street: row.street, postalCode: row.postalCode, city: row.city, latitude: row.latitude, longitude: row.longitude, radiusMeters: row.radiusMeters }));
  const fromRules: AddressSuggestion[] = rules
    .filter((rule) => rule.latitude !== null && rule.longitude !== null)
    .map((rule) => ({ id: `rule:${rule.id}`, source: 'RULE', label: rule.company ?? rule.pattern, line2: [rule.street, [rule.postalCode, rule.city].filter(Boolean).join(' ')].filter(Boolean).join(', '),
      company: rule.company, street: rule.street, postalCode: rule.postalCode, city: rule.city, latitude: rule.latitude!, longitude: rule.longitude!, radiusMeters: null }));
  return [...fromWebfleet, ...fromRules].slice(0, Math.max(1, Math.min(limit, 20)));
}
