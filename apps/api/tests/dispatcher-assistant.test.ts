import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { PrismaClient } from '../src/generated/sqlite-client/index.js';
import { asAppDatabase, migrateTestDatabase } from './test-database.js';
import { ANSWER_FALLBACK_SUFFIX, compactForModel, DispatcherAssistantService, persistable, resolveAssistantVehicle, summarizeStoredResult, type AssistantModel, type DispatcherDependencies } from '../src/services/dispatcher-assistant.js';

let db: PrismaClient;
let directory: string;
const now = new Date('2026-10-16T10:00:00Z');
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ops-assistant-test-'));
  db = new PrismaClient({ datasources: { db: { url: `file:${join(directory, 'test.db')}` } } });
  await migrateTestDatabase(db);
}, 20000);
afterAll(async () => { await db?.$disconnect(); if (directory) await rm(directory, { recursive: true, force: true }); });

async function fixture(number: string, overrides: Partial<DispatcherDependencies> = {}, model?: AssistantModel) {
  const vehicle = await db.vehicle.create({ data: { vehicleNumber: number } });
  const execute = vi.fn(async (_action, _input, vehicleId, tx, date) => {
    await tx.vehicle.update({ where: { id: vehicleId }, data: { manualStoppedAt: date } });
    return { stopped: true };
  }) as unknown as DispatcherDependencies['execute'];
  const service = new DispatcherAssistantService(asAppDatabase(db), {
    prepare: async (_action, input) => ({ input, preview: input }), execute,
    scenario: async () => ({ result: 'ON_TIME' }), ...overrides
  }, model);
  const conversation = await service.createConversation();
  const send = (action: 'NOTE' | 'BREAKDOWN' | 'REPAIR' | 'STOP' | 'SCENARIO', input: Record<string, unknown> = {}) => service.message(conversation.id, {
    text: 'Тестовый запрос', vehicleId: vehicle.id, draft: { action, input }
  }, number, now);
  return { vehicle, service, conversation, execute, send };
}

it('only proposes a note, persists across service instances, and applies once', async () => {
  const f = await fixture('ASSISTANT-125');
  const result = await f.send('NOTE', { description: 'Проверить крепление груза' });
  expect(await db.vehicleIssue.count({ where: { vehicleId: f.vehicle.id } })).toBe(0);
  expect((await f.service.getMessages(f.conversation.id)).messages).toHaveLength(2);
  const first = await f.service.confirm(result.proposals[0]!.id, now);
  const second = await f.service.confirm(result.proposals[0]!.id, now);
  expect(first.status).toBe('APPLIED');
  expect(second.id).toBe(first.id);
  expect(await db.vehicleIssue.count({ where: { vehicleId: f.vehicle.id } })).toBe(1);
  expect(await db.operationEvent.count({ where: { vehicleId: f.vehicle.id } })).toBe(1);
});

it('rejects stale vehicle state and leaves proposal pending without partial work', async () => {
  const f = await fixture('ASSISTANT-126');
  const result = await f.send('NOTE', { description: 'Не применять устаревшие данные' });
  await db.vehicle.update({ where: { id: f.vehicle.id }, data: { operationVersion: { increment: 1 } } });
  await expect(f.service.confirm(result.proposals[0]!.id, now)).rejects.toThrow('изменились');
  expect(await db.vehicleIssue.count({ where: { vehicleId: f.vehicle.id } })).toBe(0);
  expect((await db.assistantProposal.findUniqueOrThrow({ where: { id: result.proposals[0]!.id } })).status).toBe('PENDING');
});

it('rolls back adapter failure, including writes already made inside the transaction', async () => {
  const f = await fixture('ASSISTANT-127', { execute: async (_action, _input, vehicleId, tx) => {
    await tx.vehicle.update({ where: { id: vehicleId }, data: { licensePlate: 'SHOULD-ROLL-BACK' } });
    throw new Error('test failure');
  } });
  const result = await f.send('BREAKDOWN', { description: 'Неисправность двигателя' });
  await expect(f.service.confirm(result.proposals[0]!.id, now)).rejects.toThrow('test failure');
  expect((await db.vehicle.findUniqueOrThrow({ where: { id: f.vehicle.id } })).licensePlate).toBeNull();
  expect(await db.vehicleIssue.count({ where: { vehicleId: f.vehicle.id } })).toBe(0);
});

it('breakdown stops movement and repair closes the issue without resuming', async () => {
  const f = await fixture('ASSISTANT-128');
  const proposal = (await f.send('BREAKDOWN', { description: 'Пробито колесо' })).proposals[0]!;
  await f.service.confirm(proposal.id, now);
  expect((await db.vehicle.findUniqueOrThrow({ where: { id: f.vehicle.id } })).manualStoppedAt).toEqual(now);
  const repair = (await f.send('REPAIR')).proposals[0]!;
  await f.service.confirm(repair.id, now);
  expect(await db.vehicleIssue.count({ where: { vehicleId: f.vehicle.id, resolvedAt: null } })).toBe(0);
  expect((await db.vehicle.findUniqueOrThrow({ where: { id: f.vehicle.id } })).manualStoppedAt).toEqual(now);
});

it('cancellation and expiry prevent writes', async () => {
  const f = await fixture('ASSISTANT-129');
  const a = (await f.send('NOTE', { description: 'Отмена' })).proposals[0]!;
  await f.service.cancel(a.id);
  await expect(f.service.confirm(a.id, now)).rejects.toThrow('отменено');
  const b = (await f.send('NOTE', { description: 'Истекло' })).proposals[0]!;
  await expect(f.service.confirm(b.id, new Date(now.getTime() + 11 * 60000))).rejects.toThrow('устарело');
  expect(await db.vehicleIssue.count({ where: { vehicleId: f.vehicle.id } })).toBe(0);
});

it('scenario only stores dialogue, with no proposal or operational writes', async () => {
  const f = await fixture('ASSISTANT-130');
  const before = await db.vehicle.findUniqueOrThrow({ where: { id: f.vehicle.id } });
  const result = await f.send('SCENARIO', { stops: [{ address: 'Berlin', type: 'VISIT' }] });
  expect(result.scenario).toEqual({ kind: 'SCENARIO', result: 'ON_TIME' });
  expect(result.results).toEqual([{ kind: 'SCENARIO', result: 'ON_TIME' }]);
  expect(result.proposals).toEqual([]);
  expect(await db.vehicle.findUniqueOrThrow({ where: { id: f.vehicle.id } })).toEqual(before);
  expect(await db.tour.count({ where: { vehicleId: f.vehicle.id } })).toBe(0);
  expect((await f.service.getMessages(f.conversation.id)).messages.some(m => m.role === 'scenario')).toBe(true);
});

it('persists quota and rejects attempts beyond configured limit', async () => {
  const f = await fixture('ASSISTANT-131');
  for (let i = 0; i < 10; i++) await f.service.consumeUsage('specific-session', now);
  await expect(f.service.consumeUsage('specific-session', now)).rejects.toThrow('Лимит');
  await expect(f.service.consumeUsage('specific-session', new Date(now.getTime() + 60000))).resolves.toBeUndefined();
});

it('free route origin overrides selected vehicle and also works without a vehicle', async () => {
  const scenario = vi.fn(async () => ({ geometry: [[13, 52], [10, 53]] }));
  const f = await fixture('ASSISTANT-FREE', { scenario });
  const payload = { originAddress: 'Berlin', stops: [{ address: 'Hamburg' }] };
  const before = await db.vehicle.findUniqueOrThrow({ where: { id: f.vehicle.id } });
  const selected = await f.send('SCENARIO', payload);
  expect(scenario).toHaveBeenLastCalledWith(payload, undefined, now);
  expect(selected.proposals).toEqual([]);
  await f.service.message(f.conversation.id, { text: 'Berlin → Hamburg', draft: { action: 'SCENARIO', input: payload } }, 'free-route', now);
  expect(scenario).toHaveBeenLastCalledWith(payload, undefined, now);
  expect(await db.vehicle.findUniqueOrThrow({ where: { id: f.vehicle.id } })).toEqual(before);
  expect(await db.operationEvent.count({ where: { vehicleId: f.vehicle.id } })).toBe(0);
});

it('exact plate matching does not guess ambiguous numbers', () => {
  const vehicles = [{ id: 'one', vehicleNumber: '125', licensePlate: 'B-CY 7490' }, { id: 'two', vehicleNumber: '7490', licensePlate: null }];
  expect(resolveAssistantVehicle(vehicles, 'b cy7490').id).toBe('one');
  expect(resolveAssistantVehicle(vehicles, 'LKW 125').id).toBe('one');
  expect(() => resolveAssistantVehicle(vehicles, '749')).toThrow('не найдена');
});

it('model can request clarification without creating actions', async () => {
  const f = await fixture('ASSISTANT-132', {}, async () => ({ answer: 'Какая машина?', commands: [] }));
  const result = await f.service.message(f.conversation.id, { text: 'Она приехала' }, 'clarification', now);
  expect(result.message.content).toBe('Какая машина?');
  expect(result.proposals).toEqual([]);
});

const terminPlan = { vehicleNumber: '7490', target: { label: 'Выгрузка · Hannover' }, timeline: [{ type: 'DRIVE' }], geometry: [[13, 52], [10, 53]],
  recommendation: { terminAtLocal: '14:45' }, driver: { source: 'WEBFLEET', activitySince: '2026-10-16T09:00:00Z', hours: { drivenTodaySeconds: 3600 } }, warnings: ['Позиция устарела'] };

it('calculates a Termin before the answer: the model is asked twice and the second text is kept, with no proposal', async () => {
  const model = vi.fn<AssistantModel>()
    .mockResolvedValueOnce({ answer: 'Считаю по данным тахографа…', commands: [{ action: 'TERMIN', vehicle: null, inputJson: '{}', summary: 'Termin в Hannover' }] })
    .mockResolvedValueOnce({ answer: 'Рекомендую Termin 14:45.', commands: [{ action: 'NOTE', vehicle: null, inputJson: '{"description":"ignored"}', summary: 'не должно попасть' }] });
  const termin = vi.fn(async () => terminPlan);
  const brief = vi.fn(async (vehicleId: string) => ({ vehicleNumber: '7490', vehicleId, position: { status: 'MOVING' } }));
  const f = await fixture('ASSISTANT-TERMIN', { termin, brief }, model);
  const result = await f.service.message(f.conversation.id, { text: 'Когда лучше взять Termin?', vehicleId: f.vehicle.id }, 'termin', now);
  expect(termin).toHaveBeenCalledWith({}, f.vehicle.id, now);
  expect(model).toHaveBeenCalledTimes(2);
  expect(model.mock.calls[0]![0]).toMatchObject({ phase: 'PLAN', context: { selected: { vehicleNumber: '7490' } } });
  const second = model.mock.calls[1]![0];
  expect(second.phase).toBe('ANSWER');
  expect(second.results).toHaveLength(1);
  expect(second.results![0]).toMatchObject({ action: 'TERMIN', result: { kind: 'TERMIN', recommendation: { terminAtLocal: '14:45' } } });
  expect((second.results![0]!.result as Record<string, unknown>).geometry).toBeUndefined();
  expect(result.message.content).toBe('Рекомендую Termin 14:45.');
  expect(result.proposals).toEqual([]);
  expect(result.results).toHaveLength(1);
  expect((result.results[0] as Record<string, unknown>).driver).toEqual({ source: 'WEBFLEET' });
  const stored = (await f.service.getMessages(f.conversation.id)).messages.find(m => m.role === 'scenario')!;
  expect(stored.content).not.toContain('drivenTodaySeconds');
  expect(JSON.parse(stored.content)).toMatchObject({ kind: 'TERMIN', recommendation: { terminAtLocal: '14:45' } });
  expect(await db.assistantProposal.count({ where: { conversationId: f.conversation.id } })).toBe(0);
});

it('keeps the numbers when the second model call fails', async () => {
  const model = vi.fn<AssistantModel>()
    .mockResolvedValueOnce({ answer: 'Считаю…', commands: [{ action: 'TERMIN', vehicle: null, inputJson: '{}', summary: 'Termin' }] })
    .mockRejectedValueOnce(new Error('timeout'));
  const f = await fixture('ASSISTANT-TERMIN-2', { termin: async () => terminPlan }, model);
  const result = await f.service.message(f.conversation.id, { text: 'Когда?', vehicleId: f.vehicle.id }, 'termin-2', now);
  expect(result.message.content).toBe(`Считаю…\n\n${ANSWER_FALLBACK_SUFFIX}`);
  expect(result.results).toHaveLength(1);
});

it('runs one model call for a draft and rejects TERMIN without a vehicle or a dependency', async () => {
  const model = vi.fn<AssistantModel>().mockResolvedValue({ answer: 'x', commands: [{ action: 'TERMIN', vehicle: null, inputJson: '{}', summary: 'Termin' }] });
  const f = await fixture('ASSISTANT-TERMIN-3', {}, model);
  await expect(f.service.message(f.conversation.id, { text: 'Когда?' }, 'termin-3', now)).rejects.toThrow('Укажите машину');
  await expect(f.service.message(f.conversation.id, { text: 'Когда?', vehicleId: f.vehicle.id }, 'termin-3', now)).rejects.toThrow('временно недоступен');
  const scenario = vi.fn(async () => ({ result: 'ON_TIME' }));
  const g = await fixture('ASSISTANT-TERMIN-4', { scenario }, model);
  await g.send('SCENARIO', { stops: [{ address: 'Berlin' }] });
  expect(model).not.toHaveBeenCalledWith(expect.objectContaining({ phase: 'ANSWER' }));
});

it('INFO returns the vehicle brief and the history keeps old results short', async () => {
  const model = vi.fn<AssistantModel>()
    .mockResolvedValueOnce({ answer: 'Смотрю.', commands: [{ action: 'INFO', vehicle: null, inputJson: '{}', summary: 'Сводка' }] })
    .mockResolvedValueOnce({ answer: 'Машина в пути.', commands: [] })
    .mockResolvedValue({ answer: 'Понял.', commands: [] });
  const f = await fixture('ASSISTANT-INFO', { brief: async () => ({ vehicleNumber: '7490', driver: { summary: 'Ездил 2 ч', hours: { drivenToday: '2 ч' } } }) }, model);
  const first = await f.service.message(f.conversation.id, { text: 'Что с машиной?', vehicleId: f.vehicle.id }, 'info', now);
  expect(first.results[0]).toMatchObject({ kind: 'VEHICLE_BRIEF', driver: { summary: 'Ездил 2 ч' } });
  expect((first.results[0] as { driver: Record<string, unknown> }).driver.hours).toBeUndefined();
  await f.service.message(f.conversation.id, { text: 'Спасибо', vehicleId: f.vehicle.id }, 'info', now);
  const history = model.mock.calls[2]![0].history;
  expect(history.find(m => m.role === 'scenario')!.content).toBe('[VEHICLE_BRIEF] · LKW 7490');
});

it('strips map lines for the model and summarizes stored results', () => {
  const compact = compactForModel({ kind: 'TERMIN', geometry: [[1, 2]], stops: [{ coords: { latitude: 1, longitude: 2 }, label: 'A' }], timeline: Array.from({ length: 50 }, (_, i) => ({ type: 'DRIVE', i })) }) as Record<string, unknown>;
  expect(compact.geometry).toBeUndefined();
  expect(compact.stops).toEqual([{ label: 'A' }]);
  expect(compact.timeline).toHaveLength(40);
  expect(persistable({ kind: 'TERMIN', driver: { source: 'WEBFLEET', hours: {}, activitySince: 'x' } })).toEqual({ kind: 'TERMIN', driver: { source: 'WEBFLEET' } });
  expect(persistable({ kind: 'SCENARIO', geometry: [] })).toEqual({ kind: 'SCENARIO', geometry: [] });
  expect(summarizeStoredResult(JSON.stringify({ kind: 'TERMIN', vehicleNumber: '1', target: { label: 'Выгрузка · Emden' }, recommendation: { terminAtLocal: '14:45' }, warnings: ['a', 'b', 'c', 'd'] })))
    .toBe('[TERMIN] · LKW 1 · Выгрузка · Emden · рекомендуемый Termin 14:45 · предупреждения: a; b; c');
  expect(summarizeStoredResult('not json')).toBe('not json');
});
