import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { PrismaClient } from '../src/generated/sqlite-client/index.js';
import { asAppDatabase, migrateTestDatabase } from './test-database.js';
import { DispatcherAssistantService, resolveAssistantVehicle, type AssistantModel, type DispatcherDependencies } from '../src/services/dispatcher-assistant.js';

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
  expect(result.scenario).toEqual({ result: 'ON_TIME' });
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
