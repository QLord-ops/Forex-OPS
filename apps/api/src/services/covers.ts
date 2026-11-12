import type { PrismaClient } from '@prisma/client';
import { writeAuditLog, type AuditActor } from './audit-log.js';
import { isMine, statusOwnerOf, type StatusOwner } from './customers.js';

export class CoverError extends Error {
  constructor(message: string, public readonly statusCode = 400) { super(message); }
}

export const COVER_MAX_DAYS = 31;

/** One dispatcher works for another until `endsAt`. `lineIds` null: every line and every truck the absent one took. */
export type Cover = { id: string; absentDispatcherId: string; coverDispatcherId: string; lineIds: string[] | null; startsAt: Date; endsAt: Date };
type CoverRow = { id: string; absentDispatcherId: string; coverDispatcherId: string; lineIdsJson: string | null; startsAt: Date; endsAt: Date };
type Membership = { dispatcherId: string; lineId: string };
type OwnedVehicle = { assignedDispatcherId: string | null; customerLineId: string | null };

function toCover(row: CoverRow): Cover {
  let lineIds: string[] | null = null;
  if (row.lineIdsJson) {
    try {
      const value = JSON.parse(row.lineIdsJson) as unknown;
      // A broken list covers nothing rather than everything.
      lineIds = Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
    } catch { lineIds = []; }
  }
  return { id: row.id, absentDispatcherId: row.absentDispatcherId, coverDispatcherId: row.coverDispatcherId, lineIds, startsAt: row.startsAt, endsAt: row.endsAt };
}

/** Covers in force at `now`. An expired cover needs no clean-up: it simply stops being returned. */
export async function activeCovers(db: PrismaClient, now = new Date()): Promise<Cover[]> {
  const rows = await db.dispatcherCover.findMany({ where: { endedAt: null, startsAt: { lte: now }, endsAt: { gt: now } }, orderBy: { createdAt: 'asc' } });
  return rows.map(toCover);
}

const includes = (cover: Cover, lineId: string | null) => cover.lineIds === null || Boolean(lineId && cover.lineIds.includes(lineId));

/**
 * Ownership as it is right now: the lines and trucks of an absent dispatcher count as their stand-in's. Nothing stored
 * is rewritten, so the end of a cover gives everything back by itself. Covers never chain (see `startCover`).
 */
export class CoverResolver {
  constructor(private readonly covers: ReadonlyArray<Cover>) {}

  coverOf(dispatcherId: string, lineId: string | null): Cover | null {
    return this.covers.find((cover) => cover.absentDispatcherId === dispatcherId && includes(cover, lineId)) ?? null;
  }

  actingFor(dispatcherId: string, lineId: string | null): string {
    return this.coverOf(dispatcherId, lineId)?.coverDispatcherId ?? dispatcherId;
  }

  /** The truck with the dispatcher who looks after it now; `coverFor` names the absent owner. */
  vehicle<T extends OwnedVehicle>(vehicle: T): T & { coverFor: string | null } {
    if (!vehicle.assignedDispatcherId) return { ...vehicle, coverFor: null };
    const cover = this.coverOf(vehicle.assignedDispatcherId, vehicle.customerLineId);
    return cover ? { ...vehicle, assignedDispatcherId: cover.coverDispatcherId, coverFor: cover.absentDispatcherId } : { ...vehicle, coverFor: null };
  }

  /** Who works on a line now; `coverFor` is set where a stand-in replaces a dispatcher of the line. */
  lineDispatchers<T extends { dispatcherId: string; isPrimary: boolean }>(lineId: string | null, list: ReadonlyArray<T>): Array<{ dispatcherId: string; isPrimary: boolean; coverFor: string | null }> {
    const merged = new Map<string, { dispatcherId: string; isPrimary: boolean; coverFor: string | null }>();
    for (const item of list) {
      const acting = this.actingFor(item.dispatcherId, lineId);
      const seen = merged.get(acting);
      const coverFor = acting === item.dispatcherId ? null : item.dispatcherId;
      if (seen) { seen.isPrimary ||= item.isPrimary; seen.coverFor ??= coverFor; }
      else merged.set(acting, { dispatcherId: acting, isPrimary: item.isPrimary, coverFor });
    }
    return [...merged.values()];
  }

  /** Dispatchers whose lines may now be `me`'s. */
  absentsOf(me: string): string[] {
    return [...new Set(this.covers.filter((cover) => cover.coverDispatcherId === me).map((cover) => cover.absentDispatcherId))];
  }

  lines(me: string, memberships: ReadonlyArray<Membership>): Set<string> {
    return new Set(memberships.filter((item) => this.actingFor(item.dispatcherId, item.lineId) === me).map((item) => item.lineId));
  }

  /** The lines `me` works on right now: their own that nobody covers, plus those they cover. */
  async linesOf(db: PrismaClient, me: string | null | undefined): Promise<Set<string>> {
    if (!me) return new Set();
    const memberships = await db.dispatcherLine.findMany({ where: { dispatcherId: { in: [me, ...this.absentsOf(me)] } }, select: { dispatcherId: true, lineId: true } });
    return this.lines(me, memberships);
  }
}

export async function coverResolver(db: PrismaClient, now = new Date()): Promise<CoverResolver> {
  return new CoverResolver(await activeCovers(db, now));
}

/** Whose Excel a truck's status line goes into while covers are in force. */
export function coveredStatusOwner(resolver: CoverResolver, vehicle: OwnedVehicle, lineDispatchers: ReadonlyArray<{ dispatcherId: string; isPrimary: boolean }>): StatusOwner | null {
  const acting = resolver.vehicle(vehicle);
  const line = resolver.lineDispatchers(vehicle.customerLineId, lineDispatchers);
  const owner = statusOwnerOf(acting, line);
  if (!owner) return null;
  const coverFor = owner.source === 'TAKEN' ? acting.coverFor : line.find((item) => item.dispatcherId === owner.id)?.coverFor ?? null;
  return coverFor ? { ...owner, coverFor } : owner;
}

/**
 * The trucks a dispatcher follows in pop-ups and on the phone: not those a colleague looks after, and not free trucks
 * on lines other dispatchers work on, once the dispatcher has lines of their own. A cover moves the trucks to the
 * stand-in: the absent dispatcher's phone stays quiet until it ends. The shared login sees everything.
 */
export async function vehiclesVisibleTo(db: PrismaClient, dispatcherId: string | null | undefined, now = new Date()): Promise<(vehicleId: string) => boolean> {
  if (!dispatcherId) return () => true;
  const resolver = await coverResolver(db, now);
  const myLines = await resolver.linesOf(db, dispatcherId);
  const hasLines = myLines.size > 0 || await db.dispatcherLine.count({ where: { dispatcherId } }) > 0;
  const vehicles = await db.vehicle.findMany({ select: { id: true, assignedDispatcherId: true, customerLineId: true, customerLine: { select: { _count: { select: { dispatchers: true } } } } } });
  const others = new Set(vehicles.filter((vehicle) => {
    const owner = resolver.vehicle(vehicle).assignedDispatcherId;
    if (owner) return owner !== dispatcherId;
    return hasLines && vehicle.customerLineId !== null && !myLines.has(vehicle.customerLineId) && (vehicle.customerLine?._count.dispatchers ?? 0) > 0;
  }).map((vehicle) => vehicle.id));
  return (vehicleId) => !others.has(vehicleId);
}

export type StartCoverInput = { absentDispatcherId: string; coverDispatcherId: string; lineIds: string[] | null; endsAt: Date };

function requireParty(actor: AuditActor, absentDispatcherId: string, coverDispatcherId: string) {
  if (actor.role === 'admin') return;
  if (!actor.dispatcherId) throw new CoverError('Подмена оформляется под личным аккаунтом. Войдите под своим логином.');
  if (actor.dispatcherId !== absentDispatcherId && actor.dispatcherId !== coverDispatcherId) throw new CoverError('Оформить можно свою подмену: отдать свои линии или взять линии коллеги.', 403);
}

const BERLIN_UNTIL = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const until = (date: Date) => BERLIN_UNTIL.format(date).replace(',', '');

/** The cover starts at once and ends by itself at `endsAt`. */
export async function startCover(db: PrismaClient, input: StartCoverInput, actor: AuditActor, now = new Date()) {
  requireParty(actor, input.absentDispatcherId, input.coverDispatcherId);
  if (input.absentDispatcherId === input.coverDispatcherId) throw new CoverError('Выберите коллегу.');
  const people = new Map((await db.dispatcher.findMany({ where: { id: { in: [input.absentDispatcherId, input.coverDispatcherId] } }, select: { id: true, displayName: true, active: true } })).map((person) => [person.id, person]));
  const absent = people.get(input.absentDispatcherId), cover = people.get(input.coverDispatcherId);
  if (!absent?.active || !cover?.active) throw new CoverError('Этот диспетчер не найден или отключён.');
  if (!(input.endsAt.getTime() > now.getTime())) throw new CoverError('Время окончания подмены уже прошло.');
  if (input.endsAt.getTime() - now.getTime() > COVER_MAX_DAYS * 86_400_000) throw new CoverError(`Подмена — не дольше ${COVER_MAX_DAYS} дня. Продлить можно позже.`);

  const absentLines = new Set((await db.dispatcherLine.findMany({ where: { dispatcherId: absent.id }, select: { lineId: true } })).map((row) => row.lineId));
  const lineIds = input.lineIds ? [...new Set(input.lineIds)] : null;
  if (lineIds) {
    if (!lineIds.length) throw new CoverError('Выберите хотя бы одну линию.');
    // A dispatcher without lines of their own still hands over the trucks they took, line by line.
    const takenLines = new Set((await db.vehicle.findMany({ where: { assignedDispatcherId: absent.id, customerLineId: { not: null } }, select: { customerLineId: true } }))
      .flatMap((vehicle) => vehicle.customerLineId ?? []));
    if (lineIds.some((lineId) => !absentLines.has(lineId) && !takenLines.has(lineId))) throw new CoverError(`На этой линии у ${absent.displayName} нет ни закрепления, ни взятых машин.`);
  } else if (!absentLines.size && !await db.vehicle.count({ where: { assignedDispatcherId: absent.id } })) {
    throw new CoverError(`У ${absent.displayName} нет ни линий, ни взятых машин.`);
  }

  const current = await activeCovers(db, now);
  const overlap = current.find((item) => item.absentDispatcherId === absent.id && (item.lineIds === null || lineIds === null || item.lineIds.some((lineId) => lineIds.includes(lineId))));
  if (overlap) {
    const who = (await db.dispatcher.findUnique({ where: { id: overlap.coverDispatcherId }, select: { displayName: true } }))?.displayName ?? 'другой диспетчер';
    throw new CoverError(`Эти линии уже ведёт ${who} до ${until(overlap.endsAt)}. Сначала верните их.`, 409);
  }
  // No chains: what the stand-in holds for someone must not travel on to a third dispatcher.
  if (current.some((item) => item.absentDispatcherId === cover.id)) throw new CoverError(`${cover.displayName} сейчас сам в подмене и не может взять чужие линии.`, 409);
  if (current.some((item) => item.coverDispatcherId === absent.id)) throw new CoverError(`${absent.displayName} сейчас подменяет коллегу. Сначала верните ту подмену.`, 409);

  const created = await db.dispatcherCover.create({ data: {
    absentDispatcherId: absent.id, coverDispatcherId: cover.id, lineIdsJson: lineIds ? JSON.stringify(lineIds) : null,
    startsAt: now, endsAt: input.endsAt, createdByDispatcherId: actor.dispatcherId ?? null
  } });
  await writeAuditLog(db, actor, { action: 'COVER_STARTED', entityType: 'Dispatcher', entityId: absent.id,
    metadata: { coverId: created.id, absent: absent.id, cover: cover.id, lines: lineIds, endsAt: input.endsAt.toISOString() } });
  return toCover(created);
}

/** Either side or an admin ends a cover early; the lines and trucks are the owner's again at once. */
export async function endCover(db: PrismaClient, id: string, actor: AuditActor, now = new Date()) {
  const row = await db.dispatcherCover.findUnique({ where: { id } });
  if (!row) throw new CoverError('Подмена не найдена.', 404);
  requireParty(actor, row.absentDispatcherId, row.coverDispatcherId);
  if (row.endedAt || row.endsAt.getTime() <= now.getTime()) throw new CoverError('Подмена уже закончилась.', 409);
  const changed = await db.dispatcherCover.updateMany({ where: { id, endedAt: null }, data: { endedAt: now, endedByDispatcherId: actor.dispatcherId ?? null } });
  if (!changed.count) throw new CoverError('Подмена уже закончилась.', 409);
  await writeAuditLog(db, actor, { action: 'COVER_ENDED', entityType: 'Dispatcher', entityId: row.absentDispatcherId,
    metadata: { coverId: id, absent: row.absentDispatcherId, cover: row.coverDispatcherId } });
  return { id };
}

/** Who works on what right now: names, lines and truck counts only — no logins. */
export async function teamOverview(db: PrismaClient, me: string | null, now = new Date()) {
  const covers = await activeCovers(db, now);
  const resolver = new CoverResolver(covers);
  const [people, lines, memberships, vehicles] = await Promise.all([
    db.dispatcher.findMany({ where: { active: true }, select: { id: true, displayName: true }, orderBy: { displayName: 'asc' } }),
    db.customerLine.findMany({ where: { active: true }, select: { id: true, name: true, customer: { select: { name: true, color: true } } }, orderBy: [{ customer: { name: 'asc' } }, { sortIndex: 'asc' }, { name: 'asc' }] }),
    db.dispatcherLine.findMany({ where: { dispatcher: { active: true } }, select: { dispatcherId: true, lineId: true, isPrimary: true } }),
    db.vehicle.findMany({ select: { assignedDispatcherId: true, customerLineId: true } })
  ]);
  const names = new Map(people.map((person) => [person.id, person.displayName]));
  const lineById = new Map(lines.map((line) => [line.id, { id: line.id, name: line.name, customer: line.customer.name, color: line.customer.color }]));
  const own = (id: string) => new Set(memberships.filter((item) => item.dispatcherId === id).map((item) => item.lineId));
  const takenOn = (id: string) => vehicles.filter((vehicle) => vehicle.assignedDispatcherId === id && vehicle.customerLineId).map((vehicle) => vehicle.customerLineId!);
  const acting = vehicles.map((vehicle) => resolver.vehicle(vehicle));

  const presentCover = (cover: Cover) => {
    const theirs = own(cover.absentDispatcherId);
    const handed = new Set([...theirs, ...takenOn(cover.absentDispatcherId)]);
    return {
      id: cover.id, startsAt: cover.startsAt.toISOString(), endsAt: cover.endsAt.toISOString(),
      absent: { id: cover.absentDispatcherId, name: names.get(cover.absentDispatcherId) ?? 'Диспетчер отключён' },
      cover: { id: cover.coverDispatcherId, name: names.get(cover.coverDispatcherId) ?? 'Диспетчер отключён' },
      allLines: cover.lineIds === null,
      lines: [...handed].filter((lineId) => includes(cover, lineId)).flatMap((lineId) => lineById.get(lineId) ?? []),
      vehicleCount: vehicles.filter((vehicle) => isMine(cover.absentDispatcherId, vehicle, theirs) && includes(cover, vehicle.customerLineId)).length
    };
  };
  const presented = covers.map(presentCover);

  const dispatchers = people.map((person) => {
    const mine = resolver.lines(person.id, memberships);
    const ownLines = own(person.id);
    const taken = takenOn(person.id);
    return {
      id: person.id, name: person.displayName,
      lines: memberships.filter((item) => item.dispatcherId === person.id).flatMap((item) => {
        const line = lineById.get(item.lineId);
        return line ? [{ ...line, isPrimary: item.isPrimary }] : [];
      }),
      vehicleCount: acting.filter((vehicle) => isMine(person.id, vehicle, mine)).length,
      // Lines with trucks this dispatcher took by hand and does not run: «Только выбранные линии» offers them too.
      takenLines: [...new Set(taken)].filter((lineId) => !ownLines.has(lineId)).flatMap((lineId) => {
        const line = lineById.get(lineId);
        return line ? [{ ...line, vehicleCount: taken.filter((item) => item === lineId).length }] : [];
      }),
      away: presented.filter((cover) => cover.absent.id === person.id),
      covering: presented.filter((cover) => cover.cover.id === person.id)
    };
  });
  const staffed = new Set(memberships.map((item) => item.lineId));
  const unowned = lines.filter((line) => !staffed.has(line.id)).map((line) => ({
    ...lineById.get(line.id)!, vehicleCount: vehicles.filter((vehicle) => !vehicle.assignedDispatcherId && vehicle.customerLineId === line.id).length
  }));
  return { me, dispatchers, unowned, covers: presented };
}
