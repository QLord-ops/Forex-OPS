import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import type { CurrentPosition } from '../src/domain.js';
import { RoutingError } from '../src/services/routing.js';
import { TerminService } from '../src/services/termin-service.js';
import { createInitialClockState } from '../src/services/vehicle-clock.js';
import type { DriverHours, WebfleetDrivingTimes } from '../src/services/webfleet-live.js';

const now = new Date('2026-11-05T08:00:00Z');
const H = 3600;
const times: WebfleetDrivingTimes = {
  driverUid: 'd1', name: 'hidden', referenceTime: '2026-11-05T07:58:00Z',
  remainDrivingTodayMs: 6 * H * 1000, totalDrivingTodayMs: 3 * H * 1000, totalOtherWorkTodayMs: 0, totalAvailabilityTodayMs: 0, maxDrivingTodayMs: 9 * H * 1000,
  remainDrivingWeekMs: null, maxDrivingWeekMs: null, shiftStartedAt: null, latestShiftEndAt: '2026-11-05T18:00:00Z',
  nextBreakAt: '2026-11-05T09:28:00Z', nextBreakMinMs: 45 * 60_000, nextRestAt: '2026-11-05T18:00:00Z', nextRestMinMs: 11 * H * 1000, earliestNextShiftAt: null,
  extendedShiftsUsed: 0, maxExtendedShifts: 2, reducedRestsUsed: 0, maxReducedRests: 3, restBalances: [], infringements: false, lastCardActivityAt: null
};
const signedOn: DriverHours = { status: 'SIGNED_ON', workState: 3, activitySince: null, times, timesStatus: 'OK' };
const stop = (id: string, sequence: number, overrides: Record<string, unknown> = {}) => ({
  id, sequence, type: 'UNLOAD', company: `Werk ${id}`, address: `${id}straße 1`, city: id, latitude: 52 + sequence, longitude: 13,
  completedAt: null, arrivedAt: null, serviceMinMinutes: 60, serviceMaxMinutes: 120, plannedAt: null, terminRequired: false,
  appointmentAt: null, appointmentWindowStartAt: null, appointmentWindowEndAt: null, ...overrides
});
const leg = (id: string, toStopId: string, seconds: number, overrides: Record<string, unknown> = {}) => ({
  id, toStopId, status: 'WAITING', simulatedDurationSeconds: seconds, distanceMeters: seconds * 20, startedAt: null, drivePlan: null, routeGeometry: '[]', ...overrides
});

function fixture(options: { tours?: unknown[]; hours?: DriverHours; position?: Partial<CurrentPosition> | null; stops?: Record<string, unknown> } = {}) {
  const vehicle = { id: 'v1', vehicleNumber: '321', licensePlate: 'GÖ-FX321', operationVersion: 1, maxSpeedKmh: 85, truckProfile: null, manualStoppedAt: null,
    clockState: JSON.stringify(createInitialClockState({ effectiveAt: now })), issues: [], tours: options.tours ?? [] };
  const db = { vehicle: { findUnique: vi.fn().mockResolvedValue(vehicle) }, stop: { findUnique: vi.fn().mockImplementation(async ({ where }) => options.stops?.[where.id] ?? null) } } as unknown as PrismaClient;
  const route = vi.fn().mockImplementation(async (origin, destination) => ({ geometry: [origin, destination], distanceMeters: 72_000, durationSeconds: 3600, provider: 'test' }));
  const routing = { calculateRoute: route, geocode: vi.fn().mockResolvedValue({ latitude: 54, longitude: 10, label: 'X', provider: 'test' }), calculateMultiStopRoute: route };
  const position = options.position === null ? { position: null } : { position: { latitude: 52, longitude: 13 }, positionSource: 'WEBFLEET', telemetryStale: false, remainingDistanceMeters: 36_000, ...options.position };
  const service = new TerminService(db, routing, vi.fn().mockResolvedValue(position as CurrentPosition), vi.fn().mockResolvedValue(options.hours ?? signedOn));
  return { service, route, routing };
}
const activeTour = (extra: Record<string, unknown> = {}) => ({
  id: 't1', status: 'ACTIVE', queueIndex: 0, createdAt: now, plannedStartAt: null, orderNumber: '20565779',
  stops: [stop('Zwoenitz', 1, { type: 'LOAD', completedAt: '2026-11-05T06:00:00Z' }), stop('Meerane', 2, { appointmentAt: new Date('2026-11-05T11:00:00Z') }), stop('Hannover', 3, { terminRequired: true })],
  legs: [leg('l1', 'Zwoenitz', 0, { status: 'COMPLETED' }), leg('l2', 'Meerane', 2 * H, { status: 'ACTIVE', startedAt: new Date('2026-11-05T07:00:00Z'), distanceMeters: 72_000 }), leg('l3', 'Hannover', 3 * H)],
  ...extra
});

describe('Termin service', () => {
  it('plans the stop that needs a Termin from the stored legs without asking the router', async () => {
    const { service, route } = fixture({ tours: [activeTour()] });
    const plan = await service.plan({}, 'v1', now);
    expect(route).not.toHaveBeenCalled();
    expect(plan.target).toMatchObject({ stopId: 'Hannover', label: 'Выгрузка · Werk Hannover, Hannover', terminRequired: true });
    // GPS: half of the active leg is left (1 h), then 1 h unloading in Meerane after its 11:00 Termin, then 3 h with a break.
    expect(plan.stops.map(s => s.label)).toEqual(['Выгрузка · Werk Meerane, Meerane', 'Выгрузка · Werk Hannover, Hannover']);
    expect(plan.stops[0]).toMatchObject({ earliestArrival: '2026-11-05T09:00:00.000Z', waitingMinutes: 120, verdict: 'OK' });
    expect(plan.timeline.map(s => s.type)).toEqual(['DRIVE', 'WAIT', 'SERVICE', 'DRIVE']);
    expect(plan.stops[1]!.earliestArrival).toBe('2026-11-05T15:00:00.000Z');
    expect(plan.recommendation.terminAt).toBe('2026-11-05T15:30:00.000Z');
    expect(plan.source).toBe('WEBFLEET');
    expect(JSON.stringify(plan)).not.toContain('hidden');
  });
  it('routes the first stop of a queued tour once and a new address once', async () => {
    const queued = { id: 't2', status: 'QUEUED', queueIndex: 1, createdAt: now, plannedStartAt: null, orderNumber: '2', stops: [stop('Bremen', 1), stop('Emden', 2)], legs: [leg('l4', 'Emden', H)] };
    const { service, route, routing } = fixture({ tours: [activeTour(), queued] });
    const plan = await service.plan({ stopId: 'Emden' }, 'v1', now);
    expect(route).toHaveBeenCalledTimes(1);
    expect(plan.target.stopId).toBe('Emden');
    expect(plan.stops.map(s => s.driveSeconds)).toEqual([3600, 10800, 3600, 3600]);
    const free = await service.plan({ address: 'Hafen Kiel', type: 'UNLOAD' }, 'v1', now);
    expect(routing.geocode).toHaveBeenCalledWith('Hafen Kiel');
    expect(free.target).toMatchObject({ stopId: null, label: 'Выгрузка · Hafen Kiel', type: 'UNLOAD' });
    expect(free.stops).toHaveLength(5);
  });
  it('warns about an open Zuladung but keeps the times unchanged', async () => {
    const plain = await fixture({ tours: [activeTour()] }).service.plan({}, 'v1', now);
    const withZuladung = await fixture({ tours: [activeTour({ tourRemarks: 'Zwönitz für Meerane + Hannover + evt. Zuladung' })] }).service.plan({}, 'v1', now);
    expect(withZuladung.warnings.some(w => w.includes('Zuladung'))).toBe(true);
    expect(plain.warnings.some(w => w.includes('Zuladung'))).toBe(false);
    expect(withZuladung.recommendation.terminAt).toBe(plain.recommendation.terminAt);
  });
  it('rejects a stop of another truck and explains a completed one', async () => {
    const { service } = fixture({ tours: [activeTour()], stops: { Zwoenitz: { tour: { vehicleId: 'v1' } }, Foreign: { tour: { vehicleId: 'v2' } } } });
    await expect(service.plan({ stopId: 'Foreign' }, 'v1', now)).rejects.toThrow('не принадлежит');
    await expect(service.plan({ stopId: 'Zwoenitz' }, 'v1', now)).rejects.toThrow('уже завершена');
    await expect(service.plan({ stopId: 'a', address: 'b' }, 'v1', now)).rejects.toThrow();
  });
  it('falls back to the calculated clock when the truck has no Webfleet driver', async () => {
    const { service } = fixture({ tours: [activeTour()], hours: { status: 'NONE', workState: null, activitySince: null, times: null, timesStatus: 'NO_DATA' } });
    const plan = await service.plan({}, 'v1', now);
    expect(plan.source).toBe('CALCULATED');
    expect(plan.preliminary).toBe(true);
    expect(plan.warnings).toContain('Карта водителя не вставлена: часы по тахографу недоступны.');
  });
  it('needs a tour or an address and tolerates a router outage', async () => {
    const { service, route } = fixture({ tours: [] });
    await expect(service.plan({}, 'v1', now)).rejects.toThrow('нет активного тура');
    route.mockRejectedValue(new RoutingError('quota', 429));
    const plan = await service.plan({ address: 'Kiel' }, 'v1', now);
    expect(plan.recommendation.terminAt).toBeNull();
    expect(plan.warnings.some(w => w.includes('не рассчитан'))).toBe(true);
  });
});
