import type { PrismaClient } from '@prisma/client';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { CurrentPosition } from '../src/domain.js';
import { registerRouteScenarioRoutes } from '../src/routes/route-scenario.js';
import { RouteScenarioService, berlinDayEnd } from '../src/services/route-scenario.js';
import { createInitialClockState } from '../src/services/vehicle-clock.js';

const now = new Date('2026-10-16T08:00:00Z');
const coords = { latitude: 52, longitude: 13 };
function fixture(options: { clock?: string | null; position?: boolean; tours?: unknown[]; issues?: unknown[]; drivingSeconds?: number } = {}) {
  const vehicle = { id: 'v1', vehicleNumber: '125', operationVersion: 2, maxSpeedKmh: 85, truckProfile: null,
    manualStoppedAt: null, issues: options.issues ?? [], tours: options.tours ?? [],
    clockState: options.clock === undefined ? JSON.stringify(createInitialClockState({ effectiveAt: now, drivingSeconds: options.drivingSeconds })) : options.clock };
  const findUniqueOrThrow = vi.fn().mockResolvedValue(vehicle);
  const db = { vehicle: { findUniqueOrThrow } } as unknown as PrismaClient;
  const route = vi.fn().mockImplementation(async (origin, destination) => ({ geometry: [origin, destination], distanceMeters: 1000,
    durationSeconds: 3600, provider: 'test', providerStatus: 'live-traffic' }));
  const routing = { calculateRoute: route, geocode: vi.fn().mockResolvedValue({ ...coords, label: 'A', provider: 'test' }), calculateMultiStopRoute: route };
  const getPosition = vi.fn().mockResolvedValue({ position: options.position === false ? null : coords } as CurrentPosition);
  return { service: new RouteScenarioService(db, routing, getPosition), route, vehicle, findUniqueOrThrow, getPosition, routing };
}
const visit = { address: 'A', type: 'VISIT' as const, coords };
const stop = (id: string, sequence: number) => ({ id, sequence, type: 'UNLOAD', address: id, latitude: 53, longitude: 14,
  completedAt: null, arrivedAt: null, serviceMinMinutes: 60, serviceMaxMinutes: 120,
  appointmentAt: null, appointmentWindowStartAt: null, appointmentWindowEndAt: null });

describe('draft route scenario', () => {
  it('forecasts service ranges without modifying operational state or spending exceptions', async () => {
    const { service, vehicle } = fixture();
    const before = structuredClone(vehicle);
    const result = await service.calculate({ vehicleId: 'v1', stops: [{ address: 'A', type: 'LOAD', coords }, { address: 'B', type: 'UNLOAD', coords }] }, now);
    expect(result.stops[0].earliestArrival).toBe('2026-10-16T09:00:00.000Z');
    expect(result.stops[0].latestDeparture).toBe('2026-10-16T11:00:00.000Z');
    expect(result.completion).toEqual({ earliest: '2026-10-16T12:00:00.000Z', latest: '2026-10-16T14:00:00.000Z' });
    expect(result.finishToday).toBe('ON_TIME');
    expect(vehicle).toEqual(before);
  });
  it('reports uncertainty for missing position and unknown hours', async () => {
    const unknownClock = await fixture({ clock: null }).service.calculate({ vehicleId: 'v1', stops: [visit] }, now);
    expect(unknownClock.finishToday).toBe('UNKNOWN');
    const unknownPosition = await fixture({ position: false }).service.calculate({ vehicleId: 'v1', stops: [visit] }, now);
    expect(unknownPosition.stops[0].earliestArrival).toBeNull();
    expect(unknownPosition.finishToday).toBe('UNKNOWN');
  });
  it('includes mandatory daily rest without reserving a tenth hour', async () => {
    const { service } = fixture({ drivingSeconds: 9 * 3600 });
    const result = await service.calculate({ vehicleId: 'v1', stops: [visit] }, now);
    expect(result.requiresDailyRest).toBe(true);
    expect(result.stops[0].earliestArrival).toBe('2026-10-16T20:00:00.000Z');
  });
  it('includes appointment waiting and assesses a late deadline', async () => {
    const { service } = fixture();
    const waiting = await service.calculate({ vehicleId: 'v1', stops: [{ ...visit, appointmentAt: '2026-10-16T15:00:00Z' }] }, now);
    expect(waiting.stops[0].earliestArrival).toBe('2026-10-16T09:00:00.000Z');
    expect(waiting.stops[0].earliestDeparture).toBe('2026-10-16T15:00:00.000Z');
    const late = await service.calculate({ vehicleId: 'v1', stops: [{ ...visit, appointmentAt: '2026-10-16T08:30:00Z' }] }, now);
    expect(late.finishToday).toBe('LATE');
  });
  it('supports explicit after-tour calculations and defaults to the current position', async () => {
    const active = { id: 'a', status: 'ACTIVE', planVersion: 1, stops: [stop('as', 1)], legs: [] };
    const queued = { id: 'q', status: 'QUEUED', planVersion: 3, stops: [stop('qs', 1)], legs: [] };
    const { service } = fixture({ tours: [queued, active] });
    const result = await service.calculate({ vehicleId: 'v1', startMode: 'AFTER_CURRENT_TOUR', stops: [visit] }, now);
    expect(result.startRange).toEqual({ earliest: '2026-10-16T10:00:00.000Z', latest: '2026-10-16T11:00:00.000Z' });
    expect(result.downstreamQueueImpact[0]).toMatchObject({ tourId: 'q', delayMinutes: 60 });
    const afterQueue = await service.calculate({ vehicleId: 'v1', startMode: 'AFTER_QUEUE', stops: [visit] }, now);
    expect(afterQueue.downstreamQueueImpact).toEqual([]);
    expect(afterQueue.startRange.earliest).toBe('2026-10-16T12:00:00.000Z');
    const fromNow = await service.calculate({ vehicleId: 'v1', stops: [visit] }, now);
    expect(fromNow.startRange.earliest).toBe(now.toISOString());
    expect(fromNow.geometry[0]).toEqual([13, 52]);
  });
  it('builds an independent A to B route without reading or changing the selected vehicle', async () => {
    const { service, findUniqueOrThrow, getPosition, routing, route } = fixture();
    const result = await service.calculate({ vehicleId: 'ignored', originAddress: 'Berlin', stops: [{ address: 'Hamburg' }] }, now);
    expect(findUniqueOrThrow).not.toHaveBeenCalled();
    expect(getPosition).not.toHaveBeenCalled();
    expect(routing.geocode.mock.calls).toEqual([['Berlin'], ['Hamburg']]);
    expect(route.mock.calls[0][2]).not.toHaveProperty('truck');
    expect(result.vehicleId).toBeNull();
    expect(result.stops[0].type).toBe('VISIT');
    expect(result.stops[0].serviceMinMinutes).toBe(0);
    expect(result.completion.earliest).toBe('2026-10-16T09:00:00.000Z');
    expect(result.geometry).toEqual([[13, 52], [13, 52]]);
    expect(result.downstreamQueueImpact).toEqual([]);
    expect(result.finishToday).toBe('UNKNOWN');
  });
  it('respects known repair availability but marks the prediction conditional', async () => {
    const result = await fixture({ issues: [{ expectedResolvedAt: new Date('2026-10-16T12:00:00Z') }] }).service.calculate({ vehicleId: 'v1', stops: [visit] }, now);
    expect(result.startRange.earliest).toBe('2026-10-16T12:00:00.000Z');
    expect(result.finishToday).toBe('UNKNOWN');
    const unknownRepair = await fixture({ issues: [{ expectedResolvedAt: null }] }).service.calculate({ vehicleId: 'v1', stops: [visit] }, now);
    expect(unknownRepair.completion.earliest).toBeNull();
    expect(unknownRepair.finishToday).toBe('UNKNOWN');
  });
  it('classifies completion ranges crossing Berlin midnight as risk or late', async () => {
    const evening = new Date('2026-10-16T19:30:00Z');
    const { service } = fixture({ clock: JSON.stringify(createInitialClockState({ effectiveAt: evening })) });
    const risky = await service.calculate({ vehicleId: 'v1', stops: [{ ...visit, type: 'UNLOAD' }] }, evening);
    expect(risky.finishToday).toBe('RISK');
    const late = await service.calculate({ vehicleId: 'v1', startAt: '2026-10-17T05:00:00Z', stops: [visit] }, now);
    expect(late.finishToday).toBe('LATE');
  });
  it('uses Berlin calendar boundaries including DST', () => {
    expect(berlinDayEnd(new Date('2026-03-29T00:00:00Z')).toISOString()).toBe('2026-03-29T21:59:59.999Z');
    expect(berlinDayEnd(new Date('2026-10-25T00:00:00Z')).toISOString()).toBe('2026-10-25T22:59:59.999Z');
  });
  it('validates stop bounds before invoking the calculation', async () => {
    const app = Fastify();
    const calculate = vi.fn();
    await registerRouteScenarioRoutes(app, { service: { calculate } });
    const response = await app.inject({ method: 'POST', url: '/route-scenarios/preview', payload: { vehicleId: 'v1', stops: [{ ...visit, serviceMinMinutes: 120, serviceMaxMinutes: 60 }] } });
    expect(response.statusCode).toBe(400);
    expect(calculate).not.toHaveBeenCalled();
    await app.close();
  });
});
