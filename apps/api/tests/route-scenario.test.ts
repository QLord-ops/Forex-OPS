import type { PrismaClient } from '@prisma/client';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { CurrentPosition } from '../src/domain.js';
import { registerRouteScenarioRoutes } from '../src/routes/route-scenario.js';
import { RouteScenarioService, berlinDayEnd } from '../src/services/route-scenario.js';
import { createInitialClockState } from '../src/services/vehicle-clock.js';
import { RoutingError } from '../src/services/routing.js';
import type { DriverBudget, DriverEtaInput } from '../src/services/termin-planner.js';

const now = new Date('2026-10-16T08:00:00Z');
const coords = { latitude: 52, longitude: 13 };
function fixture(options: { clock?: string | null; position?: boolean; tours?: unknown[]; issues?: unknown[]; drivingSeconds?: number; driver?: DriverEtaInput | null } = {}) {
  const vehicle = { id: 'v1', vehicleNumber: '125', operationVersion: 2, maxSpeedKmh: 85, truckProfile: null,
    manualStoppedAt: null, issues: options.issues ?? [], tours: options.tours ?? [],
    clockState: options.clock === undefined ? JSON.stringify(createInitialClockState({ effectiveAt: now, drivingSeconds: options.drivingSeconds })) : options.clock };
  const findUniqueOrThrow = vi.fn().mockResolvedValue(vehicle);
  const db = { vehicle: { findUniqueOrThrow } } as unknown as PrismaClient;
  const route = vi.fn().mockImplementation(async (origin, destination) => ({ geometry: [origin, destination], distanceMeters: 1000,
    durationSeconds: 3600, provider: 'test', providerStatus: 'live-traffic' }));
  const routing = { calculateRoute: route, geocode: vi.fn().mockResolvedValue({ ...coords, label: 'A', provider: 'test' }), calculateMultiStopRoute: route };
  const getPosition = vi.fn().mockResolvedValue({ position: options.position === false ? null : coords } as CurrentPosition);
  const getDriver = vi.fn().mockResolvedValue(options.driver ?? null);
  return { service: new RouteScenarioService(db, routing, getPosition, getDriver), route, vehicle, findUniqueOrThrow, getPosition, routing };
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

describe('driver hours from the tachograph', () => {
  const budget = (overrides: Partial<DriverBudget> = {}): DriverBudget => ({ referenceTime: now.toISOString(), workState: 5, activitySince: now.toISOString(),
    continuousDriveLeftSeconds: 4.5 * 3600, breakSeconds: 45 * 60, dailyDriveLeftSeconds: 9 * 3600, drivenTodaySeconds: 0, maxDailyDriveSeconds: 9 * 3600,
    shiftEndAt: null, restLatestAt: null, restSeconds: 11 * 3600, weeklyDriveLeftSeconds: null, extendedShiftsLeft: null, reducedRestsLeft: null,
    earliestNextShiftAt: null, breakRemainingSeconds: 0, ...overrides });

  it('plans on the Webfleet tachograph even when the calculated clock is empty', async () => {
    const { service } = fixture({ clock: null, driver: { budget: budget({ continuousDriveLeftSeconds: 30 * 60 }), startsAt: null } });
    const result = await service.calculate({ vehicleId: 'v1', stops: [visit] }, now);
    expect(result.warnings).not.toContain('Не заполнены исходные часы машины. Прогноз предварительный.');
    expect(result.preliminary).toBe(false);
    // 30 min to the break the tachograph asks for, 45 min break, the other 30 min.
    expect(result.stops[0].earliestArrival).toBe('2026-10-16T09:45:00.000Z');
    expect(result.stops[0].segments.earliest.map(segment => segment.type)).toEqual(['DRIVE', 'BREAK', 'DRIVE']);
  });

  it('counts an hour of unloading as the break and rests when the day is driven out', async () => {
    const { service } = fixture({ clock: null, driver: { budget: budget({ continuousDriveLeftSeconds: 3600, dailyDriveLeftSeconds: 2 * 3600 }), startsAt: null } });
    const result = await service.calculate({ vehicleId: 'v1', stops: [{ address: 'A', type: 'UNLOAD', coords }, { address: 'B', type: 'UNLOAD', coords }, { address: 'C', type: 'VISIT', coords }] }, now);
    expect(result.stops[0].earliestArrival).toBe('2026-10-16T09:00:00.000Z');
    // Unloading 09:00–10:00 is the break: the next hour is driven straight through.
    expect(result.stops[1].earliestArrival).toBe('2026-10-16T11:00:00.000Z');
    expect(result.stops[2].segments.earliest.map(segment => segment.type)).toEqual(['DAILY_REST', 'DRIVE']);
    expect(result.requiresDailyRest).toBe(true);
  });

  it('starts the plan when the driver may start again after the rest', async () => {
    const startsAt = new Date('2026-10-16T12:00:00Z');
    const { service } = fixture({ clock: null, driver: { budget: budget(), startsAt } });
    const result = await service.calculate({ vehicleId: 'v1', stops: [visit] }, now);
    expect(result.stops[0].earliestArrival).toBe('2026-10-16T13:00:00.000Z');
  });
});

describe('route builder scenarios', () => {
  it('routes up to ten free points in order and joins legs without duplicate points', async () => {
    const { service, routing, route } = fixture();
    const places = Array.from({ length: 9 }, (_, index) => ({ address: `P${index + 1}`, coords: { latitude: 50 + index, longitude: 10 } }));
    const result = await service.calculate({ originAddress: 'Start', stops: places }, now);
    expect(routing.geocode.mock.calls).toEqual([['Start']]);
    expect(route).toHaveBeenCalledTimes(9);
    expect(route.mock.calls[1][0]).toEqual(places[0].coords);
    expect(route.mock.calls[1][2]).toMatchObject({ includeInstructions: false });
    expect(result.stops.map(item => item.address)).toEqual(places.map(item => item.address));
    expect(result.geometry).toHaveLength(10);
  });

  it('names the address that was not found and spends no routing request', async () => {
    const { service, routing, route } = fixture();
    routing.geocode.mockImplementation(async (address: string) => {
      if (address === 'Nirgendwo 1') throw new RoutingError('Адрес не найден.', 404);
      return { ...coords, label: address, provider: 'test' };
    });
    await expect(service.calculate({ originAddress: 'Berlin', stops: [{ address: 'Hamburg' }, { address: 'Nirgendwo 1' }] }, now))
      .rejects.toMatchObject({ statusCode: 404, message: expect.stringContaining('«Nirgendwo 1»') });
    expect(route).not.toHaveBeenCalled();
  });

  it('skips the queued-tour projection for the quick preview', async () => {
    const queued = { id: 'q1', status: 'QUEUED', planVersion: 1, plannedStartAt: null, stops: [stop('s1', 1), stop('s2', 2)], legs: [] };
    const { service, route } = fixture({ tours: [queued] });
    const quick = await service.calculate({ vehicleId: 'v1', includeQueueImpact: false, stops: [visit] }, now);
    expect(route).toHaveBeenCalledTimes(1);
    expect(quick.downstreamQueueImpact).toEqual([]);
    route.mockClear();
    const full = await service.calculate({ vehicleId: 'v1', stops: [visit] }, now);
    expect(route.mock.calls.length).toBeGreaterThan(1);
    expect(full.downstreamQueueImpact).toHaveLength(2);
  });

  it('never returns raw clock codes to the dispatcher', async () => {
    const result = await fixture({ clock: null }).service.calculate({ vehicleId: 'v1', stops: [visit] }, now);
    expect(result.warnings.some(text => /^[A-Z0-9_]+$/.test(text))).toBe(false);
    expect(result.warnings).toContain('Не заполнены исходные часы машины. Прогноз предварительный.');
  });

  it('shows the provider warning when live traffic is unavailable', async () => {
    const { service, route } = fixture();
    route.mockImplementation(async (origin, destination) => ({ geometry: [origin, destination], distanceMeters: 1000, durationSeconds: 3600,
      provider: 'osrm', providerStatus: 'quota-exhausted', warning: 'Квота TomTom исчерпана. Без актуальных пробок и проверки ограничений для грузовиков.' }));
    const result = await service.calculate({ originAddress: 'Berlin', stops: [visit] }, now);
    expect(result.warnings).toContain('Квота TomTom исчерпана. Без актуальных пробок и проверки ограничений для грузовиков.');
  });
});

describe('traffic on the planned route', () => {
  it('shifts each leg\'s congested stretches onto the joined line', async () => {
    const { service, route } = fixture();
    const a = { latitude: 51, longitude: 10 }, b = { latitude: 50, longitude: 9 };
    route.mockImplementation(async (origin, destination) => ({ geometry: [origin, { latitude: (origin.latitude + destination.latitude) / 2, longitude: origin.longitude }, destination],
      distanceMeters: 1000, durationSeconds: 3600, provider: 'tomtom', providerStatus: 'live-traffic',
      trafficSections: destination.latitude === a.latitude ? [{ start: 0, end: 2, level: 'JAM', delaySeconds: 300, speedKmh: 20 }] : [{ start: 1, end: 2, level: 'SLOW', delaySeconds: 60, speedKmh: 40 }] }));
    const result = await service.calculate({ originAddress: 'Start', stops: [{ address: 'A', coords: a }, { address: 'B', coords: b }] }, now);
    expect(result.geometry).toHaveLength(5);
    expect(result.trafficSegments).toEqual([{ from: 0, to: 2, level: 'JAM', delaySeconds: 300, speedKmh: 20 }, { from: 3, to: 4, level: 'SLOW', delaySeconds: 60, speedKmh: 40 }]);
  });
});

describe('route variants per leg', () => {
  const variant = (origin: { latitude: number; longitude: number }, destination: typeof origin, distanceMeters: number, durationSeconds: number, mainRoads: string[]) =>
    ({ geometry: [origin, destination], distanceMeters, durationSeconds, provider: 'tomtom', providerStatus: 'live-traffic', mainRoads, trafficDelaySeconds: 0, hasRoadClosure: false, alternatives: [] });

  it('returns the best route and up to two alternatives for every leg from one request', async () => {
    const { service, route } = fixture();
    route.mockImplementation(async (origin, destination) => ({ ...variant(origin, destination, 383_400, 18_780, ['A14', 'A2']),
      alternatives: [variant(origin, destination, 398_700, 19_440, ['A72', 'A38']), variant(origin, destination, 420_300, 22_140, ['A36', 'A2'])] }));
    const result = await service.calculate({ originAddress: 'Elterlein', stops: [{ address: 'Hannover', coords }, { address: 'Kassel', coords }] }, now);
    expect(route).toHaveBeenCalledTimes(2);
    expect(route.mock.calls[0][2]).toMatchObject({ maxAlternatives: 2 });
    expect(result.legs).toHaveLength(2);
    expect(result.legs[0]).toMatchObject({ from: 'Elterlein', to: 'Hannover' });
    expect(result.legs[1]).toMatchObject({ from: 'Hannover', to: 'Kassel' });
    expect(result.legs[0].options.map(option => [option.id, option.mainRoads.join('+'), option.distanceMeters, option.durationSeconds]))
      .toEqual([['0-0', 'A14+A2', 383_400, 18_780], ['0-1', 'A72+A38', 398_700, 19_440], ['0-2', 'A36+A2', 420_300, 22_140]]);
    expect(result.legs[0].options[0].geometry).toEqual([[13, 52], [13, 52]]);
  });

  it('re-times the plan for a chosen variant without asking the router again', async () => {
    const { service, route } = fixture();
    const result = await service.calculate({ originAddress: 'Berlin', stops: [{ ...visit }, { ...visit, address: 'B' }],
      legChoices: [{ distanceMeters: 5000, durationSeconds: 7200 }, { distanceMeters: 1000, durationSeconds: 3600 }] }, now);
    expect(route).not.toHaveBeenCalled();
    expect(result.stops[0].earliestArrival).toBe('2026-10-16T10:00:00.000Z');
    expect(result.stops[1].earliestArrival).toBe('2026-10-16T11:00:00.000Z');
    expect(result.distanceMeters).toBe(6000);
    expect(result.legs).toEqual([]);
  });

  it('uses the chosen variant for the vehicle forecast too', async () => {
    const { service, route } = fixture();
    const result = await service.calculate({ vehicleId: 'v1', stops: [visit], legChoices: [{ distanceMeters: 9000, durationSeconds: 5400 }] }, now);
    expect(route).not.toHaveBeenCalled();
    expect(result.stops[0].earliestArrival).toBe('2026-10-16T09:30:00.000Z');
    expect(result.distanceMeters).toBe(9000);
  });

  it('rejects choices that do not match the stops or are out of range', async () => {
    const app = Fastify();
    const calculate = vi.fn();
    await registerRouteScenarioRoutes(app, { service: { calculate } });
    for (const legChoices of [[{ distanceMeters: 1, durationSeconds: 1 }, null], [{ distanceMeters: -1, durationSeconds: 60 }], [{ distanceMeters: 1, durationSeconds: 99_999_999 }]]) {
      const response = await app.inject({ method: 'POST', url: '/route-scenarios/preview', payload: { originAddress: 'Berlin', stops: [visit], legChoices } });
      expect(response.statusCode).toBe(400);
    }
    expect(calculate).not.toHaveBeenCalled();
    await app.close();
  });
});
