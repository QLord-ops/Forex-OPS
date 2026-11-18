import { describe, expect, it } from 'vitest';
import { EtaService } from '../src/services/eta.js';
import { createInitialClockState } from '../src/services/vehicle-clock.js';

/**
 * Owner, 18.11.2026: the main screen shows an ETA for every stop of the tour, counting one to two hours of loading or
 * unloading at each stop before it and the driver's break on the way.
 */
const H = 3600_000;
const MIN = 60_000;
const now = new Date('2026-11-18T08:00:00Z');
const after = (ms: number) => new Date(now.getTime() + ms);
const ms = (iso: string | null | undefined) => new Date(iso!).getTime();

const stop = (id: string, sequence: number, type: 'LOAD' | 'UNLOAD', extra: Record<string, unknown> = {}) => ({
  id, tourId: 'tour', sequence, type, address: id, city: id, appointmentAt: null, appointmentWindowStartAt: null, appointmentWindowEndAt: null,
  plannedAt: null, arrivedAt: null, completedAt: null, serviceMinMinutes: 60, serviceMaxMinutes: 120, ...extra
});
const leg = (from: string, to: string, hours: number, extra: Record<string, unknown> = {}) => ({
  id: `${from}-${to}`, tourId: 'tour', fromStopId: from, toStopId: to, status: 'WAITING', startedAt: null, finishedAt: null,
  simulatedDurationSeconds: hours * 3600, drivePlan: null, ...extra
});
const tour = (stops: unknown[], legs: unknown[]) => [{
  id: 'tour', status: 'ACTIVE', queueIndex: 0, plannedStartAt: null, createdAt: now, approachDurationSeconds: null, stops, legs,
  vehicle: { clockState: JSON.stringify(createInitialClockState({ effectiveAt: now })), manualStoppedAt: null, issues: [] }
}] as never;

describe('ETA of every stop of the active tour', () => {
  /** Loaded, two hours from the unloading; then five hours of driving to the next loading. */
  const onTheRoad = () => tour(
    [stop('a', 1, 'LOAD', { arrivedAt: after(-2 * H), completedAt: after(-H) }), stop('b', 2, 'UNLOAD'), stop('c', 3, 'LOAD')],
    [leg('a', 'b', 2, { status: 'ACTIVE', startedAt: now }), leg('b', 'c', 5)]
  );

  it('continues from the ETA the page shows, with the stay at the stop and the 45-minute break', () => {
    const shown = after(2.5 * H);
    const etas = new EtaService().stopEtas(onTheRoad(), 'tour', now, null, shown);
    expect(etas.get('a')).toBeUndefined();
    expect(etas.get('b')).toEqual({ eta: shown.toISOString(), earliest: shown.toISOString(), latest: shown.toISOString(), basis: 'ETA' });
    const next = etas.get('c')!;
    // One hour of unloading at the least, five hours of driving and the break after 4 h 30.
    expect(ms(next.earliest) - shown.getTime()).toBeGreaterThanOrEqual(60 * MIN + 5 * H + 45 * MIN);
    expect(ms(next.earliest) - shown.getTime()).toBeLessThan(60 * MIN + 5 * H + 60 * MIN);
    // Two hours of unloading at the most: the latest arrival is an hour later, the shown time is the middle.
    expect(ms(next.latest) - ms(next.earliest)).toBe(60 * MIN);
    expect(ms(next.eta)).toBe((ms(next.earliest) + ms(next.latest)) / 2);
  });

  it('without a shown ETA plans the current stop by the drive timer', () => {
    const etas = new EtaService().stopEtas(onTheRoad(), 'tour', now);
    expect(etas.get('b')?.eta).toBe(after(2 * H).toISOString());
    expect(ms(etas.get('c')!.earliest) - ms(etas.get('b')!.eta)).toBeGreaterThanOrEqual(6 * H);
  });

  it('at the stop counts what is left of the one to two hours', () => {
    const tours = tour(
      [stop('a', 1, 'LOAD', { arrivedAt: after(-40 * MIN) }), stop('b', 2, 'UNLOAD')],
      [leg('a', 'b', 3)]
    );
    const etas = new EtaService().stopEtas(tours, 'tour', now, null, after(H));
    // The arrival is a fact: the ETA measured before it no longer moves the stop.
    expect(etas.get('a')?.eta).toBe(after(-40 * MIN).toISOString());
    expect(etas.get('b')?.earliest).toBe(after(20 * MIN + 3 * H).toISOString());
    expect(etas.get('b')?.latest).toBe(after(80 * MIN + 3 * H).toISOString());
  });

  it('before the tour begins assumes the first stop at its Termin and says so', () => {
    const notStarted = (termin: Date | null) => tour(
      [stop('a', 1, 'LOAD', { appointmentAt: termin }), stop('b', 2, 'UNLOAD')],
      [leg('a', 'b', 3)]
    );
    const termin = after(5 * H);
    const etas = new EtaService().stopEtas(notStarted(termin), 'tour', now);
    expect(etas.get('a')).toEqual({ eta: null, earliest: null, latest: null, basis: 'PLAN' });
    expect(etas.get('b')).toMatchObject({ earliest: new Date(termin.getTime() + 4 * H).toISOString(), latest: new Date(termin.getTime() + 5 * H).toISOString(), basis: 'PLAN' });
    // A Termin already missed says nothing about where the truck is: no times are invented.
    const missed = new EtaService().stopEtas(notStarted(after(-H)), 'tour', now);
    expect(missed.get('a')?.eta).toBeNull();
    expect(missed.get('b')?.eta).toBeNull();
  });

  it('leaves the schedule of alerts and the tour list as it was', () => {
    const service = new EtaService();
    const plain = service.calculateVehicleSchedule(onTheRoad(), now);
    service.stopEtas(onTheRoad(), 'tour', now, null, after(4 * H));
    expect(service.calculateVehicleSchedule(onTheRoad(), now)).toEqual(plain);
    expect(plain[0].predictedEta?.toISOString()).toBe(after(2 * H).toISOString());
  });
});
