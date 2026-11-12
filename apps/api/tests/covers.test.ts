import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '../src/generated/sqlite-client/index.js';
import { CoverResolver, coveredStatusOwner, coverResolver, endCover, startCover, teamOverview, vehiclesVisibleTo } from '../src/services/covers.js';
import { isMine } from '../src/services/customers.js';
import { asAppDatabase, migrateTestDatabase } from './test-database.js';

let directory: string;
let sqlite: PrismaClient;
const ids: Record<string, string> = {};
const now = new Date('2026-11-11T08:00:00Z');
const at = (hours: number) => new Date(now.getTime() + hours * 3_600_000);
const db = () => asAppDatabase(sqlite);
const actor = (login: string) => ({ role: (login === 'chef' ? 'admin' : 'dispatcher') as 'admin' | 'dispatcher', sessionId: `s-${login}`, dispatcherId: ids[login] });
const start = (absent: string, cover: string, lines: string[] | null, by = cover, endsAt = at(10), when = now) =>
  startCover(db(), { absentDispatcherId: ids[absent]!, coverDispatcherId: ids[cover]!, lineIds: lines ? lines.map((code) => ids[code]!) : null, endsAt }, actor(by), when);

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ops-covers-'));
  sqlite = new PrismaClient({ datasources: { db: { url: `file:${join(directory, 'test.db')}` } } });
  await migrateTestDatabase(sqlite);
  for (const [login, name, role, active] of [['anna', 'Anna Schmidt', 'dispatcher', true], ['ben', 'Ben Muster', 'dispatcher', true], ['cem', 'Cem Kaya', 'dispatcher', true], ['chef', 'Chef', 'admin', true], ['gone', 'Gerd Alt', 'dispatcher', false]] as const) {
    ids[login] = (await sqlite.dispatcher.create({ data: { login, displayName: name, role, active, passwordHash: 'x' } })).id;
  }
  const customer = await sqlite.customer.create({ data: { name: 'Geis', slug: 'GEIS' } });
  for (const code of ['NORD', 'SUED', 'TESLA', 'EMPTY']) ids[code] = (await sqlite.customerLine.create({ data: { customerId: customer.id, code, name: code } })).id;
  await sqlite.dispatcherLine.createMany({ data: [
    { dispatcherId: ids.anna!, lineId: ids.NORD!, isPrimary: true },
    { dispatcherId: ids.ben!, lineId: ids.SUED!, isPrimary: true }, { dispatcherId: ids.ben!, lineId: ids.TESLA!, isPrimary: false },
    { dispatcherId: ids.cem!, lineId: ids.TESLA!, isPrimary: true }
  ] });
  const truck = async (vehicleNumber: string, code: string | null, taken: string | null = null) => {
    ids[vehicleNumber] = (await sqlite.vehicle.create({ data: { vehicleNumber, customerLineId: code ? ids[code] : null, assignedDispatcherId: taken ? ids[taken] : null } })).id;
  };
  await truck('101', 'NORD');           // Anna's line
  await truck('201', 'SUED');           // Ben's line
  await truck('202', 'SUED', 'ben');    // taken by Ben
  await truck('203', null, 'ben');      // taken by Ben, no line
  await truck('301', 'TESLA');          // Ben and Cem; Cem's main line
  await truck('401', 'EMPTY');          // nobody's line
}, 20000);
beforeEach(async () => { await sqlite.dispatcherCover.deleteMany(); await sqlite.auditLog.deleteMany(); });
afterAll(async () => { await sqlite?.$disconnect(); if (directory) await rm(directory, { recursive: true, force: true }); });

async function mineOf(login: string, when = now) {
  const resolver = await coverResolver(db(), when);
  const lines = await resolver.linesOf(db(), ids[login]);
  const vehicles = await sqlite.vehicle.findMany({ orderBy: { vehicleNumber: 'asc' } });
  return vehicles.filter((vehicle) => isMine(ids[login]!, resolver.vehicle(vehicle), lines)).map((vehicle) => vehicle.vehicleNumber);
}

describe('a dispatcher works for a colleague', () => {
  it('every line and every taken truck of the absent dispatcher becomes the stand-in\'s, nothing stored is rewritten', async () => {
    expect(await mineOf('anna')).toEqual(['101']);
    expect(await mineOf('ben')).toEqual(['201', '202', '203', '301']);
    await start('ben', 'anna', null);
    expect(await mineOf('anna')).toEqual(['101', '201', '202', '203', '301']);
    expect(await mineOf('ben')).toEqual([]);
    expect((await sqlite.vehicle.findUniqueOrThrow({ where: { id: ids['202'] } })).assignedDispatcherId).toBe(ids.ben);
    expect(await sqlite.dispatcherLine.count({ where: { dispatcherId: ids.ben } })).toBe(2);
    expect(await sqlite.auditLog.findFirst({ where: { action: 'COVER_STARTED' } })).toMatchObject({ actorDispatcherId: ids.anna, entityId: ids.ben });
  });

  it('one line only: the other lines and trucks stay with their dispatcher', async () => {
    await start('ben', 'anna', ['SUED']);
    expect(await mineOf('anna')).toEqual(['101', '201', '202']);
    expect(await mineOf('ben')).toEqual(['203', '301']);
  });

  it('ends by itself at its time, with no job and no write', async () => {
    await start('ben', 'anna', null, 'anna', at(10));
    expect(await mineOf('anna', at(9.9))).toContain('202');
    expect(await mineOf('anna', at(10))).toEqual(['101']);
    expect(await mineOf('ben', at(10))).toEqual(['201', '202', '203', '301']);
    expect((await sqlite.dispatcherCover.findFirstOrThrow()).endedAt).toBeNull();
  });

  it('either side gives everything back early', async () => {
    const cover = await start('ben', 'anna', null);
    await expect(endCover(db(), cover.id, actor('cem'), at(1))).rejects.toMatchObject({ statusCode: 403 });
    await endCover(db(), cover.id, actor('ben'), at(1));
    expect(await mineOf('ben', at(1))).toEqual(['201', '202', '203', '301']);
    expect(await sqlite.auditLog.findFirst({ where: { action: 'COVER_ENDED' } })).toMatchObject({ actorDispatcherId: ids.ben });
    await expect(endCover(db(), cover.id, actor('anna'), at(2))).rejects.toMatchObject({ statusCode: 409 });
  });

  it('the absent dispatcher hands over themselves; an admin arranges any cover; a third dispatcher cannot', async () => {
    await start('ben', 'anna', ['SUED'], 'ben');
    await sqlite.dispatcherCover.deleteMany();
    await start('anna', 'cem', null, 'chef');
    await sqlite.dispatcherCover.deleteMany();
    await expect(start('ben', 'anna', null, 'cem')).rejects.toMatchObject({ statusCode: 403 });
  });

  it('refuses a second cover of the same line, chains, switched-off colleagues and wrong times', async () => {
    await start('ben', 'anna', ['SUED']);
    await expect(start('ben', 'cem', ['SUED'])).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('Anna Schmidt') });
    await expect(start('ben', 'cem', null)).rejects.toMatchObject({ statusCode: 409 });
    await start('ben', 'cem', ['TESLA']);
    // Anna holds Ben's line: her own lines must not travel on, and she cannot be covered by Ben.
    await expect(start('anna', 'cem', null)).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('подменяет') });
    await expect(start('cem', 'ben', null, 'chef')).rejects.toMatchObject({ statusCode: 409 });
    await sqlite.dispatcherCover.deleteMany();
    await expect(start('gone', 'anna', null)).rejects.toMatchObject({ statusCode: 400 });
    await expect(start('anna', 'anna', null)).rejects.toMatchObject({ statusCode: 400 });
    await expect(start('ben', 'anna', ['NORD'])).rejects.toMatchObject({ statusCode: 400 });
    await expect(start('ben', 'anna', null, 'anna', at(-1))).rejects.toMatchObject({ statusCode: 400 });
    await expect(start('ben', 'anna', null, 'anna', at(32 * 24))).rejects.toMatchObject({ statusCode: 400 });
    expect(await sqlite.dispatcherCover.count()).toBe(0);
  });
});

describe('what follows the cover', () => {
  it('pop-ups and push: the stand-in sees the trucks, the absent dispatcher does not, and back after the end', async () => {
    const seen = async (login: string, when = now) => {
      const visible = await vehiclesVisibleTo(db(), ids[login], when);
      return ['101', '201', '202', '203', '301', '401'].filter((number) => visible(ids[number]!));
    };
    expect(await seen('anna')).toEqual(['101', '401']);
    expect(await seen('ben')).toEqual(['201', '202', '203', '301', '401']);
    await start('ben', 'anna', null);
    expect(await seen('anna')).toEqual(['101', '201', '202', '203', '301', '401']);
    expect(await seen('ben')).toEqual(['401']);
    expect(await seen('ben', at(10))).toEqual(['201', '202', '203', '301', '401']);
    expect((await vehiclesVisibleTo(db(), null))(ids['202']!)).toBe(true);
  });

  it('the status Excel: the truck goes to the stand-in and remembers whose it is', () => {
    const resolver = new CoverResolver([{ id: 'c', absentDispatcherId: 'ben', coverDispatcherId: 'anna', lineIds: ['sued'], startsAt: now, endsAt: at(1) }]);
    expect(coveredStatusOwner(resolver, { assignedDispatcherId: 'ben', customerLineId: 'sued' }, [])).toEqual({ id: 'anna', source: 'TAKEN', coverFor: 'ben' });
    expect(coveredStatusOwner(resolver, { assignedDispatcherId: null, customerLineId: 'sued' }, [{ dispatcherId: 'ben', isPrimary: true }])).toEqual({ id: 'anna', source: 'LINE', coverFor: 'ben' });
    // Anna already works on the line with Ben: while she covers him it is hers alone.
    expect(coveredStatusOwner(resolver, { assignedDispatcherId: null, customerLineId: 'sued' }, [{ dispatcherId: 'ben', isPrimary: true }, { dispatcherId: 'anna', isPrimary: false }])).toEqual({ id: 'anna', source: 'LINE', coverFor: 'ben' });
    // A line outside the cover is untouched.
    expect(coveredStatusOwner(resolver, { assignedDispatcherId: 'ben', customerLineId: 'tesla' }, [])).toEqual({ id: 'ben', source: 'TAKEN' });
    expect(coveredStatusOwner(resolver, { assignedDispatcherId: null, customerLineId: 'nord' }, [{ dispatcherId: 'cem', isPrimary: true }])).toEqual({ id: 'cem', source: 'LINE' });
  });

  it('the team page: lines, truck counts, who is away and nobody\'s lines — no logins', async () => {
    await start('ben', 'anna', ['SUED']);
    const team = await teamOverview(db(), ids.anna!, now);
    expect(team.dispatchers.map((person) => [person.name, person.vehicleCount])).toEqual([['Anna Schmidt', 3], ['Ben Muster', 2], ['Cem Kaya', 1], ['Chef', 0]]);
    expect(team.covers).toHaveLength(1);
    expect(team.covers[0]).toMatchObject({ absent: { name: 'Ben Muster' }, cover: { name: 'Anna Schmidt' }, allLines: false, vehicleCount: 2, lines: [{ name: 'SUED' }] });
    expect(team.dispatchers[1]!.away).toHaveLength(1);
    expect(team.dispatchers[0]!.covering).toHaveLength(1);
    expect(team.unowned).toEqual([expect.objectContaining({ name: 'EMPTY', vehicleCount: 1 })]);
    expect(JSON.stringify(team)).not.toContain('"login"');
  });

  it('a dispatcher without lines hands over the trucks they took, line by line', async () => {
    const dora = (await sqlite.dispatcher.create({ data: { login: 'dora', displayName: 'Dora Neu', role: 'dispatcher', passwordHash: 'x' } })).id;
    ids.dora = dora;
    const taken = await Promise.all([['601', 'SUED'], ['602', 'SUED'], ['603', 'TESLA'], ['604', null]].map(([vehicleNumber, code]) =>
      sqlite.vehicle.create({ data: { vehicleNumber: vehicleNumber!, customerLineId: code ? ids[code] : null, assignedDispatcherId: dora } })));
    try {
      const before = await teamOverview(db(), dora, now);
      expect(before.dispatchers.find((person) => person.id === dora)).toMatchObject({ lines: [],
        takenLines: [expect.objectContaining({ name: 'SUED', vehicleCount: 2 }), expect.objectContaining({ name: 'TESLA', vehicleCount: 1 })] });
      // Ben runs SUED himself: his taken truck there is not offered twice.
      expect(before.dispatchers.find((person) => person.id === ids.ben)!.takenLines).toEqual([]);

      await start('dora', 'anna', ['SUED'], 'dora');
      expect(await mineOf('anna')).toEqual(['101', '601', '602']);
      expect(await mineOf('dora')).toEqual(['603', '604']);
      const after = await teamOverview(db(), dora, now);
      expect(after.covers[0]).toMatchObject({ allLines: false, vehicleCount: 2, lines: [{ name: 'SUED' }] });
      await expect(start('dora', 'cem', ['NORD'], 'dora')).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('нет ни закрепления, ни взятых машин') });
    } finally {
      await sqlite.dispatcherCover.deleteMany();
      await sqlite.vehicle.deleteMany({ where: { id: { in: taken.map((vehicle) => vehicle.id) } } });
      await sqlite.dispatcher.delete({ where: { id: dora } });
    }
  });
});
