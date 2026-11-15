import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '../src/generated/sqlite-client/index.js';
import { hashDispatcherPassword } from '../src/services/dispatcher-auth.js';
import { migrateTestDatabase } from './test-database.js';

/**
 * The whole API on a throwaway database with five personal accounts, each on a line of their own, working at the same
 * moment over real HTTP. Nothing outside this machine is asked: Webfleet, TomTom, OpenAI and the address services are
 * switched off and any request that still leaves is counted as a failure.
 */
const ORIGIN = 'https://ops.test';
const TEAM = ['anna', 'ben', 'clara', 'dmitri', 'elena'] as const;
const TRUCKS_PER_LINE = 4;
type Login = (typeof TEAM)[number];
type Session = { login: Login; id: string; headers: Record<string, string> };
type Answer = { status: number; body: any; ms: number };

let directory: string;
let db: PrismaClient;
let app: FastifyInstance;
let base: string;
const realFetch = globalThis.fetch;
const outside: string[] = [];
const openStreams = new Set<AbortController>();
const log: Array<{ who: string; method: string; path: string; status: number; ms: number }> = [];
const ids: { dispatcher: Record<string, string>; line: Record<string, string>; trucks: Record<string, string[]>; spare: string } = { dispatcher: {}, line: {}, trucks: {}, spare: '' };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Five dispatchers side by side; each one does their own things one after another, as a person does. */
async function eachDispatcher<T, R>(team: Session[], items: (person: Session) => T[], work: (person: Session, item: T, index: number) => Promise<R>): Promise<R[]> {
  const perPerson = await Promise.all(team.map(async (person) => {
    const results: R[] = [];
    for (const [index, item] of items(person).entries()) results.push(await work(person, item, index));
    return results;
  }));
  return perPerson.flat();
}
const pathKey = (path: string) => path.split('?')[0].replace(/\/c[a-z0-9]{20,}/g, '/:id').replace(/\/[0-9a-f]{8}-[0-9a-f-]{27}/g, '/:id');

async function call(who: Session | null, method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<Answer> {
  const started = performance.now();
  const multipart = body instanceof FormData;
  const response = await realFetch(`${base}${path}`, {
    method,
    headers: { origin: ORIGIN, ...(who?.headers ?? {}), ...(body !== undefined && !multipart ? { 'content-type': 'application/json' } : {}), ...extra },
    body: body === undefined ? undefined : multipart ? body : JSON.stringify(body)
  });
  const text = await response.text();
  const ms = performance.now() - started;
  log.push({ who: who?.login ?? '-', method, path: pathKey(path), status: response.status, ms });
  let parsed: unknown = text;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* a plain-text answer stays as it is */ }
  return { status: response.status, body: parsed, ms };
}

async function signIn(login: Login): Promise<Session> {
  const started = performance.now();
  const response = await realFetch(`${base}/auth/login`, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ login, password: `${login} long password` }) });
  log.push({ who: login, method: 'POST', path: '/auth/login', status: response.status, ms: performance.now() - started });
  expect(response.status).toBe(200);
  const body = await response.json() as { csrfToken: string; dispatcherId: string };
  return { login, id: body.dispatcherId, headers: { cookie: String(response.headers.get('set-cookie')).split(';')[0], 'x-csrf-token': body.csrfToken } };
}

/** The live event stream of one dispatcher: how many events arrived until it is closed. */
function openStream(who: Session) {
  const controller = new AbortController();
  openStreams.add(controller);
  let events = 0, status = 0;
  const done = (async () => {
    try {
      const response = await realFetch(`${base}/events/stream`, { headers: { origin: ORIGIN, ...who.headers }, signal: controller.signal });
      status = response.status;
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        events += (decoder.decode(chunk.value).match(/^event:/gm) ?? []).length;
      }
    } catch { /* closed by the test */ }
  })();
  return { close: async () => { controller.abort(); await done; return { status, events }; } };
}

const stop = (sequence: number, type: 'LOAD' | 'UNLOAD', company: string, address: string, city: string, latitude: number, longitude: number, appointmentAt: Date) =>
  ({ sequence, type, company, address, city, latitude, longitude, appointmentAt: appointmentAt.toISOString() });

function tourBody(vehicleId: string, orderNumber: string, shift: number) {
  const now = Date.now();
  return {
    vehicleId, orderNumber,
    stops: [
      stop(1, 'LOAD', `Lager ${orderNumber}`, `Industriestraße ${shift + 1}, 37120 Bovenden`, 'Bovenden', 51.59 + shift * 0.002, 9.93, new Date(now + 2 * 3_600_000)),
      stop(2, 'UNLOAD', `Werk ${orderNumber}`, `Werkstraße ${shift + 1}, 34225 Baunatal`, 'Baunatal', 51.25 + shift * 0.002, 9.41, new Date(now + 6 * 3_600_000))
    ]
  };
}

const preview = (orderNumber: string) => ({
  source: 'OPENAI' as const, detectedLayout: 'PDF' as const, aiAvailable: true as const, usedAi: true as const, warnings: [],
  drafts: [{ orderNumber, vehicleNumber: null, warnings: [], stops: [
    { sequence: 1, type: 'LOAD' as const, company: null, address: 'Industriestraße 1, 37120 Bovenden', city: 'Bovenden', appointmentLocal: null, sourcePage: 1, confidence: 0.9 },
    { sequence: 2, type: 'UNLOAD' as const, company: null, address: 'Werkstraße 1, 34225 Baunatal', city: 'Baunatal', appointmentLocal: null, sourcePage: 1, confidence: 0.9 }
  ] }]
});

async function uploadAuftrag(who: Session): Promise<Answer> {
  const form = new FormData();
  // Every dispatcher's file differs, as real ones do: an identical file would be answered from the store.
  form.append('file', new Blob([`%PDF-1.7\n1 0 obj\n<< /Title (${who.login}) >>\nendobj\n%%EOF`], { type: 'application/pdf' }), `auftrag-${who.login}.pdf`);
  const first = await call(who, 'POST', '/imports/pdf/preview', form);
  if (first.status !== 202) return first;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await sleep(100);
    const state = await call(who, 'GET', `/imports/jobs/${first.body.jobId}`);
    if (state.status !== 202) return state.status === 200 ? { ...state, body: state.body.preview } : state;
  }
  throw new Error('the reading never finished');
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ops-five-system-'));
  // SQLite has one writer: a single connection makes the app's queries wait in line, as they do for the pool in production.
  db = new PrismaClient({ datasources: { db: { url: `file:${join(directory, 'test.db')}?connection_limit=1` } } });
  await migrateTestDatabase(db);

  // No key of a real service may reach the app, whatever a local .env holds.
  for (const name of ['WEBFLEET_ACCOUNT', 'WEBFLEET_API_KEY', 'WEBFLEET_USERNAME', 'WEBFLEET_PASSWORD', 'TOMTOM_API_KEY', 'TOMTOM_ROUTING_API_KEY', 'OPENAI_API_KEY',
    'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT', 'VERCEL']) vi.stubEnv(name, '');
  vi.stubEnv('TOMTOM_FREE_TIER_CONFIRMED', 'false');
  vi.stubEnv('ROUTING_ALLOW_MOCK', 'true');
  for (const name of ['OSRM_BASE_URL', 'NOMINATIM_BASE_URL', 'OPENPLZ_BASE_URL', 'WEBFLEET_BASE_URL', 'TOMTOM_ROUTING_BASE_URL']) vi.stubEnv(name, 'http://127.0.0.1:9/');
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!/^http:\/\/127\.0\.0\.1[:/]/.test(url)) outside.push(new URL(url).host);
    throw new TypeError('no network in this test');
  });

  // The app takes its database from this global when one is there; it must be set before the app is imported.
  (globalThis as { opsPrisma?: unknown }).opsPrisma = db;
  const { buildApp } = await import('../src/app.js');

  const customer = await db.customer.create({ data: { name: 'Testkunde', slug: 'testkunde' } });
  await db.dispatcher.create({ data: { login: 'chef', displayName: 'CHEF', role: 'admin', passwordHash: hashDispatcherPassword('chef long password'), active: true } });
  for (const [index, login] of TEAM.entries()) {
    ids.dispatcher[login] = (await db.dispatcher.create({ data: { login, displayName: login.toUpperCase(), role: 'dispatcher', passwordHash: hashDispatcherPassword(`${login} long password`), active: true } })).id;
    ids.line[login] = (await db.customerLine.create({ data: { customerId: customer.id, code: `L${index + 1}`, name: `Linie ${index + 1}`, sortIndex: index } })).id;
    await db.dispatcherLine.create({ data: { dispatcherId: ids.dispatcher[login], lineId: ids.line[login], isPrimary: true } });
    ids.trucks[login] = [];
    for (let truck = 0; truck < TRUCKS_PER_LINE; truck += 1) {
      ids.trucks[login].push((await db.vehicle.create({ data: { vehicleNumber: `GÖ-${login.toUpperCase()}-${truck + 1}`, customerLineId: ids.line[login] } })).id);
    }
  }
  ids.spare = (await db.vehicle.create({ data: { vehicleNumber: 'GÖ-FREI-1' } })).id;

  app = await buildApp({
    auth: { secret: 's'.repeat(32), origins: [ORIGIN] },
    importWaitMs: 50,
    pdfImport: async (_buffer, filename) => { await sleep(300); return preview(filename.replace(/\.pdf$/, '')) as never; }
  });
  base = await app.listen({ port: 0, host: '127.0.0.1' });
}, 60_000);

afterAll(async () => {
  // A stream left open by a failed step would keep the server from closing.
  for (const stream of openStreams) stream.abort();
  await app?.close();
  await db?.$disconnect();
  delete (globalThis as { opsPrisma?: unknown }).opsPrisma;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
}, 30_000);

describe('the whole system with five dispatchers at work', () => {
  it('runs a morning of five dispatchers on five lines without a single failure', async () => {
    const team = await Promise.all(TEAM.map((login) => signIn(login)));
    expect(team.map((person) => person.id)).toEqual(TEAM.map((login) => ids.dispatcher[login]));
    const streams = team.map((person) => openStream(person));

    // What an open page does all day, for every dispatcher, until the morning is over.
    let working = true;
    const polling = team.map(async (person) => {
      while (working) {
        await Promise.all([call(person, 'GET', '/dashboard'), call(person, 'GET', '/notifications'), call(person, 'GET', '/tours')]);
        await sleep(250);
      }
    });

    // Everybody takes the trucks of their own line in the same moment.
    const taken = await eachDispatcher(team, (person) => ids.trucks[person.login], (person, vehicleId) =>
      call(person, 'POST', `/vehicles/${vehicleId}/assignment`, { action: 'take', expectedDispatcherId: null }));
    expect(taken.map((answer) => answer.status)).toEqual(taken.map(() => 200));

    // Five Auftrag uploaded in the same second: two are read at once, three wait, none is refused.
    const readings = await Promise.all(team.map((person) => uploadAuftrag(person)));
    expect(readings.map((answer) => answer.status)).toEqual([200, 200, 200, 200, 200]);
    expect(readings.map((answer) => answer.body.drafts[0].orderNumber)).toEqual(TEAM.map((login) => `auftrag-${login}`));

    // Twenty tours, one for each truck: five dispatchers create theirs at the same time.
    const created = await eachDispatcher(team, (person) => ids.trucks[person.login], (person, vehicleId, index) =>
      call(person, 'POST', '/tours', tourBody(vehicleId, `A-${person.login}-${index + 1}`, index)).then((answer) => ({ person, vehicleId, answer })));
    expect(created.map((item) => item.answer.status)).toEqual(created.map(() => 201));
    expect(await db.tour.count()).toBe(TEAM.length * TRUCKS_PER_LINE);


    // The next tour of every first truck is queued and edited while colleagues do the same on their lines.
    const queued = await Promise.all(team.map((person) => call(person, 'POST', '/tours', tourBody(ids.trucks[person.login][0], `B-${person.login}`, 5))));
    expect(queued.map((answer) => answer.status)).toEqual([201, 201, 201, 201, 201]);
    const edited = await Promise.all(team.map((person, index) => call(person, 'PATCH', `/tours/${queued[index].body.id}`,
      { ...tourBody(ids.trucks[person.login][0], `B-${person.login}-neu`, 6), version: queued[index].body.planVersion })));
    expect(edited.map((answer) => answer.status)).toEqual([200, 200, 200, 200, 200]);

    // BELADEN at the first stop of every tour, then ENTLADEN at the second, on five lines at once.
    const toursOf = (person: Session) => created.filter((item) => item.person === person);
    const loaded = await eachDispatcher(team, toursOf, (person, { answer }) => call(person, 'POST', `/stops/${answer.body.stops[0].id}/loaded`, { note: `beladen ${person.login}` }));
    expect(loaded.map((answer) => answer.status)).toEqual(loaded.map(() => 200));
    const unloaded = await eachDispatcher(team, toursOf, (person, { answer }) => call(person, 'POST', `/stops/${answer.body.stops[1].id}/unloaded`, {}));
    expect(unloaded.map((answer) => answer.status)).toEqual(unloaded.map(() => 200));

    working = false;
    await Promise.all(polling);

    // «Мои» of every dispatcher are exactly the trucks of their line.
    const boards = await Promise.all(team.map((person) => call(person, 'GET', '/dashboard')));
    for (const [index, person] of team.entries()) {
      const mine = (boards[index].body.vehicles as Array<{ mine: boolean; vehicle: { id: string } }>).filter((row) => row.mine).map((row) => row.vehicle.id).sort();
      expect(mine, `«Мои» ${person.login}`).toEqual([...ids.trucks[person.login]].sort());
      expect(boards[index].body.vehicles).toHaveLength(TEAM.length * TRUCKS_PER_LINE + 1);
    }

    // A notice about a truck reaches the dispatcher of its line and nobody else.
    for (const login of TEAM) {
      await db.notification.create({ data: { dedupKey: `system-test:${login}`, vehicleId: ids.trucks[login][2], type: 'DWELL_WARNING', message: `LKW ${login} стоит дольше плана`, payloadJson: '{}' } });
    }
    const notices = await Promise.all(team.map((person) => call(person, 'GET', '/notifications')));
    for (const [index, person] of team.entries()) {
      const seen = (notices[index].body.notifications as Array<{ vehicleId: string; message: string }>).filter((notice) => notice.message.includes('стоит дольше плана'));
      expect(seen.map((notice) => notice.vehicleId), `уведомления ${person.login}`).toEqual([ids.trucks[person.login][2]]);
    }

    // Every action is in the journal under the dispatcher who did it.
    for (const person of team) {
      const own = await db.auditLog.findMany({ where: { vehicleId: { in: ids.trucks[person.login] } }, select: { actorDispatcherId: true, actorRole: true } });
      expect(own.length, `журнал ${person.login}`).toBeGreaterThanOrEqual(TRUCKS_PER_LINE * 3);
      expect(new Set(own.filter((row) => row.actorRole !== 'system').map((row) => row.actorDispatcherId))).toEqual(new Set([person.id]));
    }
    expect(await db.event.count({ where: { type: 'LOADED' } })).toBe(TEAM.length * TRUCKS_PER_LINE);
    expect(await db.event.count({ where: { type: 'UNLOADED' } })).toBe(TEAM.length * TRUCKS_PER_LINE);

    const live = await Promise.all(streams.map((stream) => stream.close()));
    expect(live.map((stream) => stream.status)).toEqual([200, 200, 200, 200, 200]);
  }, 60_000);

  it('settles clicks of two dispatchers on the same thing: one wins, the other gets a clear answer, nothing is doubled', async () => {
    const team = await Promise.all(TEAM.map((login) => signIn(login)));
    const [anna, ben] = team;

    // All five want the one free truck.
    const race = await Promise.all(team.map((person) => call(person, 'POST', `/vehicles/${ids.spare}/assignment`, { action: 'take', expectedDispatcherId: null })));
    expect(race.map((answer) => answer.status).sort()).toEqual([200, 409, 409, 409, 409]);

    // Anna and Ben press BELADEN on the same stop in the same moment.
    const tour = await call(anna, 'POST', '/tours', tourBody(ids.trucks.anna[1], 'C-doppelt', 7));
    expect(tour.status).toBe(201);
    const stopId = tour.body.stops[0].id as string;
    const twice = await Promise.all([call(anna, 'POST', `/stops/${stopId}/loaded`, {}), call(ben, 'POST', `/stops/${stopId}/loaded`, {})]);
    expect(twice.filter((answer) => answer.status === 200)).toHaveLength(1);
    expect(twice.find((answer) => answer.status !== 200)!.status).toBeLessThan(500);
    expect(await db.event.count({ where: { stopId, type: 'LOADED' } })).toBe(1);

    // Both edit the same queued tour from the same version.
    const future = await call(anna, 'POST', '/tours', tourBody(ids.trucks.anna[1], 'D-zwei', 8));
    expect(future.status).toBe(201);
    const edits = await Promise.all([anna, ben].map((person, index) => call(person, 'PATCH', `/tours/${future.body.id}`,
      { ...tourBody(ids.trucks.anna[1], `D-zwei-${index}`, 9), version: future.body.planVersion })));
    expect(edits.map((answer) => answer.status).sort()).toEqual([200, 409]);
  }, 60_000);

  it('a cover and a sign-out of one dispatcher leave the other four at work', async () => {
    const team = await Promise.all(TEAM.map((login) => signIn(login)));
    const [anna, ben, clara, dmitri, elena] = team;

    // Elena goes home and Dmitri takes her line, while the other three keep working.
    const [cover, ...others] = await Promise.all([
      call(elena, 'POST', '/covers', { absentDispatcherId: elena.id, coverDispatcherId: dmitri.id, lineIds: null, endsAt: new Date(Date.now() + 4 * 3_600_000).toISOString() }),
      ...[anna, ben, clara].map((person) => call(person, 'GET', '/dashboard'))
    ]);
    expect(cover.status).toBe(201);
    expect(others.map((answer) => answer.status)).toEqual([200, 200, 200]);

    const board = await call(dmitri, 'GET', '/dashboard');
    const mine = (board.body.vehicles as Array<{ mine: boolean; vehicle: { id: string } }>).filter((row) => row.mine).map((row) => row.vehicle.id);
    expect(mine).toEqual(expect.arrayContaining([...ids.trucks.dmitri, ...ids.trucks.elena]));
    const annaBoard = await call(anna, 'GET', '/dashboard');
    const annaMine = (annaBoard.body.vehicles as Array<{ mine: boolean; vehicle: { id: string } }>).filter((row) => row.mine).map((row) => row.vehicle.id);
    // Besides her own line Anna may hold the free truck, if she was the one who won it above.
    expect(annaMine.filter((id) => id !== ids.spare).sort()).toEqual([...ids.trucks.anna].sort());

    expect((await call(elena, 'POST', '/auth/logout', {})).status).toBe(200);
    expect((await call(elena, 'GET', '/dashboard')).status).toBe(401);
    const rest = await Promise.all([anna, ben, clara, dmitri].map((person) => call(person, 'GET', '/team')));
    expect(rest.map((answer) => answer.status)).toEqual([200, 200, 200, 200]);
  }, 60_000);

  it('never answered with a server error, never refused for load, and never asked a service outside', () => {
    const expected401 = (row: (typeof log)[number]) => row.status === 401 && row.who === 'elena';
    const failures = log.filter((row) => row.status >= 500);
    const refused = log.filter((row) => row.status === 429);
    const odd = log.filter((row) => row.status >= 400 && row.status !== 409 && !expected401(row));
    const board = log.filter((row) => row.path === '/dashboard' && row.status === 200).map((row) => row.ms).sort((a, b) => a - b);
    const byStatus = Object.fromEntries([...new Set(log.map((row) => row.status))].sort().map((status) => [status, log.filter((row) => row.status === status).length]));
    const report = {
      requests: log.length, byStatus, outsideCalls: [...new Set(outside)],
      dashboard: { count: board.length, medianMs: Math.round(board[Math.floor(board.length / 2)]), worstMs: Math.round(board.at(-1)!) },
      slowest: [...log].sort((a, b) => b.ms - a.ms).slice(0, 3).map((row) => `${row.method} ${row.path} ${Math.round(row.ms)} ms`)
    };
    console.info('Пять диспетчеров одновременно:', JSON.stringify(report));
    expect(failures).toEqual([]);
    expect(refused).toEqual([]);
    expect(odd).toEqual([]);
    expect(outside).toEqual([]);
    expect(board.at(-1)!).toBeLessThan(3000);
  });
});
