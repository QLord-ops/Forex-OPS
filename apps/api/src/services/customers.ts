import type { Prisma, PrismaClient } from '@prisma/client';
import { writeAuditLog, type AuditActor } from './audit-log.js';
import { mergeProfile, OEM_TOUR_REMARKS_TEMPLATE, parseProfile, SCHNELLECKE_PROFILE, type CustomerCategory, type CustomerProfile } from './customer-profile.js';
import { calibrate, fieldOutcomes } from './field-confidence.js';
import { pickDraft } from './import-learning.js';
import type { ImportCustomerContext } from './pdf-order-import.js';

const DAY_MS = 24 * 3600_000;

export class CustomerError extends Error {
  constructor(message: string, public readonly statusCode = 400) { super(message); }
}

const lineInclude = {
  _count: { select: { vehicles: true } },
  dispatchers: { include: { dispatcher: { select: { id: true, displayName: true, active: true } } } }
} satisfies Prisma.CustomerLineInclude;

/** "Walter (Tesla)" → "WALTER_TESLA": stable, readable keys; the 07:00 list of Schnellecke keeps SCHNELLECKE. */
export function slugOf(name: string): string {
  return name.normalize('NFKD').replace(/\p{M}/gu, '').replace(/ß/g, 'SS').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'KUNDE';
}

function aliasesOf(json: string): string[] {
  try { const value = JSON.parse(json) as unknown; return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []; } catch { return []; }
}

type LegacyCustomer = { slug: string; name: string; category: CustomerCategory; aliases: string[]; color: string; profile: CustomerProfile; lines: Record<string, string>; fallbackLine: [string, string] };
/** The line strings a truck had before customers existed, and what they become (owner's fleet, 2026-11-05). */
export const LEGACY_CUSTOMERS: LegacyCustomer[] = [
  { slug: 'SCHNELLECKE', name: 'Schnellecke', category: 'OEM_LOGISTICS', aliases: ['Schnellecke', 'Schnellecke Transportlogistik GmbH', 'Schnellecke Logistics'], color: '#1d4ed8',
    profile: SCHNELLECKE_PROFILE, lines: { NORD: 'Nord', SUED: 'Süd', LUFE: 'LuFe' }, fallbackLine: ['ALLGEMEIN', 'Allgemein'] },
  { slug: 'WALTER_TESLA', name: 'Walter (Tesla)', category: 'OEM_LOGISTICS', aliases: ['Walter', 'Tesla'], color: '#b91c1c',
    profile: OEM_TOUR_REMARKS_TEMPLATE, lines: {}, fallbackLine: ['TESLA', 'Tesla'] }
];

/** «Мои»: a truck I took, or one on my lines that no colleague has taken. */
export function isMine(me: string | null, vehicle: { assignedDispatcherId: string | null; customerLineId: string | null }, myLines: ReadonlySet<string>): boolean {
  if (!me) return false;
  if (vehicle.assignedDispatcherId) return vehicle.assignedDispatcherId === me;
  return Boolean(vehicle.customerLineId && myLines.has(vehicle.customerLineId));
}

export type StatusOwner = { id: string; source: 'TAKEN' | 'LINE' };
/**
 * Whose Excel a truck's status line goes into: the dispatcher who took it; a free truck goes to the only dispatcher
 * of its line, or to the only one whose main line it is. Otherwise nobody's — every truck is in at most one Excel.
 */
export function statusOwnerOf(vehicle: { assignedDispatcherId: string | null }, lineDispatchers: ReadonlyArray<{ dispatcherId: string; isPrimary: boolean }>): StatusOwner | null {
  if (vehicle.assignedDispatcherId) return { id: vehicle.assignedDispatcherId, source: 'TAKEN' };
  const all = [...new Set(lineDispatchers.map((item) => item.dispatcherId))];
  if (all.length === 1) return { id: all[0]!, source: 'LINE' };
  const primary = [...new Set(lineDispatchers.filter((item) => item.isPrimary).map((item) => item.dispatcherId))];
  return primary.length === 1 ? { id: primary[0]!, source: 'LINE' } : null;
}

export type CustomerInput ={ name: string; slug?: string; category?: CustomerCategory; aliases?: string[]; color?: string | null; profile?: unknown };
export type LineInput = { code: string; name: string; departmentCompany?: string | null; departmentAddress?: string | null; departmentCity?: string | null; sortIndex?: number; active?: boolean };

/** Customers, their lines and who works on them; the profile holds how the customer's Auftrag and status list work. */
export class CustomerService {
  constructor(private readonly db: PrismaClient) {}

  async list() {
    const customers = await this.db.customer.findMany({
      orderBy: [{ active: 'desc' }, { name: 'asc' }],
      include: { lines: { orderBy: [{ sortIndex: 'asc' }, { name: 'asc' }], include: lineInclude } }
    });
    return customers.map((customer) => this.present(customer));
  }

  /**
   * What the Auftrag import needs: a short card of every active customer and, when the dispatcher picked one, its
   * import profile and the Abteilung warehouses of its lines. An archived or unknown customer cannot be picked.
   */
  async importContext(selectedId: string | null): Promise<ImportCustomerContext> {
    const customers = await this.db.customer.findMany({
      where: { active: true }, orderBy: { name: 'asc' },
      include: { lines: { where: { active: true }, orderBy: { sortIndex: 'asc' }, select: { departmentCompany: true, departmentCity: true } } }
    });
    const cards = customers.map((customer) => ({ id: customer.id, key: customer.slug, name: customer.name, aliases: aliasesOf(customer.aliasesJson), carrierNames: parseProfile(customer.profileJson).import.carrierNames }));
    if (!selectedId) return { cards, selected: null };
    const customer = customers.find((item) => item.id === selectedId);
    if (!customer) throw new CustomerError('Заказчик не найден или в архиве.', 404);
    const departments = [...new Set(customer.lines.map((line) => [line.departmentCompany, line.departmentCity].filter(Boolean).join(' ')).filter(Boolean))];
    return { cards, selected: { id: customer.id, key: customer.slug, name: customer.name, profile: parseProfile(customer.profileJson).import, departments } };
  }

  async get(id: string, now = new Date()) {
    const customer = await this.db.customer.findUnique({ where: { id }, include: { lines: { orderBy: [{ sortIndex: 'asc' }, { name: 'asc' }], include: lineInclude } } });
    if (!customer) throw new CustomerError('Заказчик не найден.', 404);
    return { ...this.present(customer), overview: await this.overview(customer.id, now) };
  }

  private present(customer: Prisma.CustomerGetPayload<{ include: { lines: { include: typeof lineInclude } } }>) {
    const { aliasesJson, profileJson, lines, ...rest } = customer;
    return {
      ...rest, aliases: aliasesOf(aliasesJson), profile: parseProfile(profileJson),
      lines: lines.map(({ _count, dispatchers, ...line }) => ({
        ...line, vehicleCount: _count.vehicles,
        dispatchers: dispatchers.filter((item) => item.dispatcher.active).map((item) => ({ id: item.dispatcher.id, name: item.dispatcher.displayName, primary: item.isPrimary }))
      }))
    };
  }

  /** What the program has gathered about the customer by itself: trucks, tours, Auftrag, corrections and learned rules. */
  private async overview(customerId: string, now: Date) {
    const since = new Date(now.getTime() - 30 * DAY_MS);
    // Tours made before customers existed belong to the customer through the truck's line.
    const ofCustomer: Prisma.TourWhereInput = { OR: [{ customerId }, { customerId: null, vehicle: { customerLine: { customerId } } }] };
    const [vehicles, activeTours, tours30d, documents, correctedDocuments, corrections, rules, recentDocuments] = await Promise.all([
      this.db.vehicle.count({ where: { customerLine: { customerId } } }),
      this.db.tour.count({ where: { AND: [ofCustomer, { status: { in: ['ACTIVE', 'QUEUED'] } }] } }),
      this.db.tour.count({ where: { AND: [ofCustomer, { createdAt: { gte: since } }] } }),
      this.db.orderDocument.count({ where: { customerId, status: 'ATTACHED' } }),
      this.db.orderDocument.count({ where: { customerId, status: 'ATTACHED', corrections: { some: {} } } }),
      this.db.importCorrection.groupBy({ by: ['field', 'kind'], where: { customerId }, _count: { _all: true } }),
      this.db.importRule.count({ where: { scope: customerId, active: true } }),
      this.db.orderDocument.findMany({ where: { customerId }, orderBy: { createdAt: 'desc' }, take: 5,
        select: { id: true, filename: true, mimeType: true, status: true, tourId: true, createdAt: true } })
    ]);
    const corrected = corrections
      .map((row) => ({ field: row.field ?? row.kind, count: row._count._all }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 6);
    return {
      vehicles, activeTours, tours30d, documents,
      documentsWithoutCorrections: documents - correctedDocuments,
      mostCorrected: corrected, learnedRules: rules, recentDocuments,
      accuracy: await this.accuracy(customerId)
    };
  }

  /**
   * How well the field levels matched reality over the last 30 saved Auftrag: of the fields shown as fine / check /
   * doubt, how many the dispatchers changed before saving. Null until a scored Auftrag was saved.
   */
  private async accuracy(customerId: string) {
    const documents = await this.db.orderDocument.findMany({
      where: { customerId, status: 'ATTACHED', confirmedJson: { not: null } }, orderBy: { attachedAt: 'desc' }, take: 30,
      select: { previewJson: true, confirmedJson: true }
    });
    const outcomes = documents.flatMap((document) => {
      try {
        const confirmed = JSON.parse(document.confirmedJson ?? 'null') as { orderNumber?: string; stops?: Parameters<typeof fieldOutcomes>[1] } | null;
        const draft = pickDraft(JSON.parse(document.previewJson) as unknown, confirmed?.orderNumber ?? '');
        return draft && confirmed?.stops ? fieldOutcomes(draft.stops as Parameters<typeof fieldOutcomes>[0], confirmed.stops) : [];
      } catch { return []; }
    });
    return outcomes.length ? calibrate(outcomes) : null;
  }

  async create(input: CustomerInput, actor?: AuditActor) {
    const slug = slugOf(input.slug ?? input.name);
    if (await this.db.customer.findUnique({ where: { slug }, select: { id: true } })) throw new CustomerError(`Заказчик с ключом ${slug} уже есть.`, 409);
    const profile = input.profile === undefined ? OEM_TOUR_REMARKS_TEMPLATE : mergeProfile(parseProfile(null), input.profile);
    const customer = await this.db.customer.create({ data: {
      name: input.name.trim(), slug, category: input.category ?? 'OTHER', aliasesJson: JSON.stringify(input.aliases ?? [input.name.trim()]),
      color: input.color ?? null, profileJson: JSON.stringify(profile)
    } });
    await writeAuditLog(this.db, actor, { action: 'CUSTOMER_CREATED', entityType: 'Customer', entityId: customer.id, metadata: { slug, name: customer.name } });
    return customer;
  }

  async update(id: string, patch: { name?: string; category?: CustomerCategory; aliases?: string[]; color?: string | null; active?: boolean; profile?: unknown }, actor?: AuditActor) {
    const current = await this.db.customer.findUnique({ where: { id } });
    if (!current) throw new CustomerError('Заказчик не найден.', 404);
    const data: Prisma.CustomerUpdateInput = {};
    if (patch.name !== undefined) data.name = patch.name.trim();
    if (patch.category !== undefined) data.category = patch.category;
    if (patch.aliases !== undefined) data.aliasesJson = JSON.stringify([...new Set(patch.aliases.map((alias) => alias.trim()).filter(Boolean))]);
    if (patch.color !== undefined) data.color = patch.color;
    if (patch.active !== undefined) data.active = patch.active;
    if (patch.profile !== undefined) data.profileJson = JSON.stringify(mergeProfile(parseProfile(current.profileJson), patch.profile));
    const customer = await this.db.customer.update({ where: { id }, data });
    await writeAuditLog(this.db, actor, { action: patch.active === false ? 'CUSTOMER_ARCHIVED' : 'CUSTOMER_UPDATED', entityType: 'Customer', entityId: id,
      metadata: { fields: Object.keys(patch), ...(patch.profile !== undefined ? { profileSections: Object.keys(patch.profile as object) } : {}) } });
    return customer;
  }

  /** Admins edit every profile; a dispatcher edits the profile of a customer whose line they work on. */
  async canEditProfile(actor: AuditActor | undefined, customerId: string) {
    if (!actor) return false;
    if (actor.role === 'admin') return true;
    if (!actor.dispatcherId) return false;
    return (await this.db.dispatcherLine.count({ where: { dispatcherId: actor.dispatcherId, line: { customerId } } })) > 0;
  }

  async addLine(customerId: string, input: LineInput, actor?: AuditActor) {
    if (!await this.db.customer.findUnique({ where: { id: customerId }, select: { id: true } })) throw new CustomerError('Заказчик не найден.', 404);
    const code = slugOf(input.code);
    if (await this.db.customerLine.findUnique({ where: { customerId_code: { customerId, code } }, select: { id: true } })) throw new CustomerError(`Линия ${code} у этого заказчика уже есть.`, 409);
    const line = await this.db.customerLine.create({ data: { customerId, code, name: input.name.trim(), departmentCompany: input.departmentCompany ?? null,
      departmentAddress: input.departmentAddress ?? null, departmentCity: input.departmentCity ?? null, sortIndex: input.sortIndex ?? 0 } });
    await writeAuditLog(this.db, actor, { action: 'CUSTOMER_LINE_CREATED', entityType: 'CustomerLine', entityId: line.id, metadata: { customerId, code } });
    return line;
  }

  async updateLine(id: string, patch: Partial<LineInput>, actor?: AuditActor) {
    const current = await this.db.customerLine.findUnique({ where: { id }, include: { customer: true } });
    if (!current) throw new CustomerError('Линия не найдена.', 404);
    const { code: _code, ...rest } = patch;
    const line = await this.db.customerLine.update({ where: { id }, data: { ...rest, ...(rest.name !== undefined ? { name: rest.name.trim() } : {}) } });
    // Trucks follow the line's status block: keep their status-list strings in step.
    if (patch.active === false) await this.db.vehicle.updateMany({ where: { customerLineId: id }, data: { customerLineId: null, line: null, statusGroup: null } });
    await writeAuditLog(this.db, actor, { action: 'CUSTOMER_LINE_UPDATED', entityType: 'CustomerLine', entityId: id, metadata: { customerId: current.customerId, fields: Object.keys(rest) } });
    return line;
  }

  /**
   * Puts a truck on a customer line, or takes it off. The older line / status-block strings follow, so the
   * 07:00 list and everything still reading them stay right without a second edit.
   */
  async setVehicleLine(vehicleId: string, lineId: string | null, actor?: AuditActor) {
    const vehicle = await this.db.vehicle.findUnique({ where: { id: vehicleId }, select: { id: true, vehicleNumber: true, customerLineId: true } });
    if (!vehicle) throw new CustomerError('Грузовик не найден.', 404);
    const line = lineId ? await this.db.customerLine.findUnique({ where: { id: lineId }, include: { customer: true } }) : null;
    if (lineId && (!line || !line.active || !line.customer.active)) throw new CustomerError('Линия не найдена или в архиве.', 404);
    const updated = await this.db.vehicle.update({ where: { id: vehicleId }, data: line
      ? { customerLineId: line.id, line: line.customer.slug, statusGroup: line.code }
      : { customerLineId: null, line: null, statusGroup: null },
    select: { id: true, vehicleNumber: true, customerLineId: true, line: true, statusGroup: true } });
    await writeAuditLog(this.db, actor, { action: 'VEHICLE_LINE_SET', entityType: 'Vehicle', entityId: vehicleId, vehicleId,
      metadata: { from: vehicle.customerLineId, to: line?.id ?? null, customer: line?.customer.slug ?? null, line: line?.code ?? null } });
    return updated;
  }

  /** The lines a dispatcher works on; at most one primary line, which sets the default customer of an import. */
  async setDispatcherLines(dispatcherId: string, lineIds: string[], primaryLineId: string | null, actor?: AuditActor) {
    if (!await this.db.dispatcher.findUnique({ where: { id: dispatcherId }, select: { id: true } })) throw new CustomerError('Диспетчер не найден.', 404);
    const unique = [...new Set(lineIds)];
    const found = await this.db.customerLine.count({ where: { id: { in: unique } } });
    if (found !== unique.length) throw new CustomerError('Одна из линий не найдена.', 404);
    if (primaryLineId && !unique.includes(primaryLineId)) throw new CustomerError('Основная линия должна быть среди выбранных.');
    await this.db.$transaction([
      this.db.dispatcherLine.deleteMany({ where: { dispatcherId } }),
      ...unique.map((lineId) => this.db.dispatcherLine.create({ data: { dispatcherId, lineId, isPrimary: lineId === (primaryLineId ?? unique[0]) } }))
    ]);
    await writeAuditLog(this.db, actor, { action: 'DISPATCHER_LINES_SET', entityType: 'Dispatcher', entityId: dispatcherId, metadata: { lines: unique, primary: primaryLineId ?? unique[0] ?? null } });
    return this.db.dispatcherLine.findMany({ where: { dispatcherId }, include: { line: { include: { customer: { select: { id: true, name: true, color: true } } } } } });
  }

  async linesOf(dispatcherId: string | null | undefined) {
    if (!dispatcherId) return [];
    return (await this.db.dispatcherLine.findMany({ where: { dispatcherId }, select: { lineId: true } })).map((row) => row.lineId);
  }

  /** What "create customers from the lines" would do: nothing is written. */
  async migrationPreview() {
    const vehicles = await this.db.vehicle.findMany({ where: { line: { not: null }, customerLineId: null }, select: { id: true, vehicleNumber: true, line: true, statusGroup: true }, orderBy: { vehicleNumber: 'asc' } });
    const existing = new Set((await this.db.customer.findMany({ select: { slug: true } })).map((customer) => customer.slug));
    return LEGACY_CUSTOMERS.map((legacy) => {
      const trucks = vehicles.filter((vehicle) => vehicle.line === legacy.slug);
      const codeOf = (truck: { statusGroup: string | null }) => (legacy.lines[truck.statusGroup ?? ''] ? truck.statusGroup! : legacy.fallbackLine[0]);
      // Lines in the order of the status list (Nord, Süd, LuFe), the catch-all line last.
      const order: Array<[string, string]> = [...Object.entries(legacy.lines), legacy.fallbackLine];
      const lines = order
        .map(([code, name]) => ({ code, name, vehicles: trucks.filter((truck) => codeOf(truck) === code).map((truck) => truck.vehicleNumber) }))
        .filter((line) => line.vehicles.length);
      return { slug: legacy.slug, name: legacy.name, exists: existing.has(legacy.slug), statusList: legacy.profile.statusList.enabled, lines };
    }).filter((item) => item.lines.length);
  }

  /** Creates the customers and lines from the trucks' line strings and links the trucks. Safe to run twice. */
  async migrateFromLines(actor?: AuditActor) {
    const preview = await this.migrationPreview();
    const result: Array<{ slug: string; created: boolean; lines: number; vehicles: number }> = [];
    for (const item of preview) {
      const legacy = LEGACY_CUSTOMERS.find((entry) => entry.slug === item.slug)!;
      const existing = await this.db.customer.findUnique({ where: { slug: legacy.slug } });
      const customer = existing ?? await this.db.customer.create({ data: { name: legacy.name, slug: legacy.slug, category: legacy.category,
        aliasesJson: JSON.stringify(legacy.aliases), color: legacy.color, profileJson: JSON.stringify(legacy.profile) } });
      let linked = 0;
      for (const [index, entry] of item.lines.entries()) {
        const line = await this.db.customerLine.upsert({ where: { customerId_code: { customerId: customer.id, code: entry.code } },
          create: { customerId: customer.id, code: entry.code, name: entry.name, sortIndex: index }, update: {} });
        const changed = await this.db.vehicle.updateMany({ where: { vehicleNumber: { in: entry.vehicles }, customerLineId: null },
          data: { customerLineId: line.id, line: customer.slug, statusGroup: line.code } });
        linked += changed.count;
      }
      result.push({ slug: legacy.slug, created: !existing, lines: item.lines.length, vehicles: linked });
    }
    await writeAuditLog(this.db, actor, { action: 'CUSTOMERS_MIGRATED_FROM_LINES', entityType: 'Customer', entityId: 'migration', metadata: { result } });
    return result;
  }
}
