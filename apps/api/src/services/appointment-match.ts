import type { PrismaClient } from '@prisma/client';

import type { AppointmentDocument } from './pdf-order-import.js';
import { normalizeRouteText } from './pdf-order-import.js';
import { hasTermin, samePlace } from './termin-groups.js';
import { normalizePlate } from './webfleet.js';

const DAY_MS = 24 * 3600_000;
/** A candidate needs this lead over the next one to count as found. */
const CLEAR_LEAD = 50;
const MIN_SCORE = 60;
// Words that name every plant and say nothing about which one.
const STOP_WORDS = new Set(['ag', 'se', 'gmbh', 'kg', 'co', 'werk', 'standort', 'plant', 'truck', 'bus', 'und', 'the', 'de', 'd']);

export type AppointmentTime = { appointmentAt: Date | null; windowStartAt: Date | null; windowEndAt: Date | null };

export type AppointmentCandidate = {
  stopId: string; tourId: string; vehicleId: string; vehicleNumber: string; licensePlate: string | null;
  orderNumber: string; tourStatus: string; planVersion: number; sequence: number; type: string;
  company: string | null; address: string; city: string | null;
  appointmentAt: string | null; windowStartAt: string | null; windowEndAt: string | null;
  score: number; reasons: string[];
};

export type VehicleMatch =
  | { status: 'MATCHED'; vehicleId: string; vehicleNumber: string; plate: string }
  | { status: 'NOT_FOUND'; plate: string }
  | { status: 'NO_PLATE' };

export type AppointmentMatch = {
  status: 'MATCHED' | 'AMBIGUOUS' | 'NONE';
  vehicle: VehicleMatch;
  candidates: AppointmentCandidate[];
};

/** Berlin wall-clock "YYYY-MM-DDTHH:mm" to an instant, across both DST switches. */
export function berlinLocalToDate(local: string | null | undefined): Date | null {
  const match = local?.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  let guess = wall;
  for (let step = 0; step < 2; step += 1) guess = wall - berlinOffsetMs(new Date(guess));
  return new Date(guess);
}

function berlinOffsetMs(at: Date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(at).map((part) => [part.type, part.value]));
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute)) - Math.floor(at.getTime() / 60_000) * 60_000;
}

export function appointmentTime(document: Pick<AppointmentDocument, 'appointmentLocal' | 'windowStartLocal' | 'windowEndLocal'>): AppointmentTime {
  return {
    appointmentAt: berlinLocalToDate(document.appointmentLocal),
    windowStartAt: berlinLocalToDate(document.windowStartLocal),
    windowEndAt: berlinLocalToDate(document.windowEndLocal)
  };
}

function placeTokens(document: Pick<AppointmentDocument, 'company' | 'site'>) {
  return [...new Set(normalizeRouteText([document.company, document.site].filter(Boolean).join(' ')).split(' '))]
    .filter((token) => token.length >= 2 && !STOP_WORDS.has(token));
}

function parseReferences(json: string | null) {
  try { const value: unknown = JSON.parse(json ?? '[]'); return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []; } catch { return []; }
}

const compactReference = (value: string) => value.replace(/[^A-Za-z0-9]/g, '').toUpperCase();

/** Which truck the slip is for: plate against the truck, its number and the trailer of its tours. */
export async function matchAppointmentVehicle(db: PrismaClient, plate: string | null, trailerPlate: string | null): Promise<VehicleMatch> {
  const wanted = [plate, trailerPlate].map((value) => normalizePlate(value)).filter(Boolean);
  if (!wanted.length) return { status: 'NO_PLATE' };
  const vehicles = await db.vehicle.findMany({ include: { tours: { where: { status: { in: ['ACTIVE', 'QUEUED'] } }, select: { trailerPlate: true } } } });
  for (const key of wanted) {
    const found = vehicles.filter((vehicle) => [vehicle.licensePlate, vehicle.vehicleNumber, vehicle.currentTrailerPlate, ...vehicle.tours.map((tour) => tour.trailerPlate)]
      .some((value) => normalizePlate(value) === key));
    if (found.length === 1) return { status: 'MATCHED', vehicleId: found[0].id, vehicleNumber: found[0].vehicleNumber, plate: plate ?? trailerPlate ?? key };
  }
  return { status: 'NOT_FOUND', plate: plate ?? trailerPlate ?? wanted[0] };
}

/**
 * Finds the open stop the slip belongs to. A shared reference number is decisive; the city, the plant's
 * name, the stop type and the date add up. Nothing is changed: the dispatcher confirms the result.
 */
export async function matchAppointment(db: PrismaClient, document: AppointmentDocument): Promise<AppointmentMatch> {
  const vehicle = await matchAppointmentVehicle(db, document.plate, document.trailerPlate);
  const time = appointmentTime(document);
  const target = time.appointmentAt ?? time.windowStartAt;
  const stops = await db.stop.findMany({
    where: {
      completedAt: null,
      tour: { status: { in: ['ACTIVE', 'QUEUED'] }, ...(vehicle.status === 'MATCHED' ? { vehicleId: vehicle.vehicleId } : {}) }
    },
    include: { tour: { include: { vehicle: true } } }
  });
  const city = normalizeRouteText(document.city ?? '');
  const tokens = placeTokens(document);
  const references = document.references.map((item) => compactReference(item.value)).filter((value) => value.length >= 5);

  const candidates: AppointmentCandidate[] = [];
  for (const stop of stops) {
    const reasons: string[] = [];
    let score = 0;
    const stopReferences = parseReferences(stop.referenceNumbersJson).map(compactReference);
    const text = normalizeRouteText([stop.company, stop.address, stop.city, stop.instructions, stop.tour.tourRemarks].filter(Boolean).join(' '));
    const shared = references.filter((value) => stopReferences.includes(value) || text.replace(/ /g, '').toUpperCase().includes(value));
    if (shared.length) { score += 200; reasons.push('совпал номер из документа'); }
    const stopCity = normalizeRouteText(stop.city ?? '');
    const cityHit = Boolean(city && (stopCity === city || ` ${text} `.includes(` ${city} `)));
    if (cityHit) { score += 100; reasons.push(`город ${document.city}`); }
    const words = tokens.filter((token) => ` ${text} `.includes(` ${token} `));
    // The place must really agree: a shared number, the city, or the plant name on the slip's own truck.
    if (!shared.length && !cityHit && !(vehicle.status === 'MATCHED' && words.length)) continue;
    if (words.length) { score += 45 * words.length; reasons.push(`в адресе: ${words.join(', ')}`); }
    if (document.stopType && stop.type === document.stopType) { score += 20; reasons.push(document.stopType === 'LOAD' ? 'загрузка' : 'выгрузка'); }
    const planned = stop.appointmentAt ?? stop.appointmentWindowStartAt ?? stop.tour.plannedStartAt;
    if (target && planned) {
      const gap = Math.abs(planned.getTime() - target.getTime());
      if (gap > 2 * DAY_MS && !shared.length) continue;
      if (gap <= DAY_MS) { score += 30; reasons.push('та же дата'); }
    }
    if (vehicle.status === 'MATCHED') reasons.unshift(`LKW ${stop.tour.vehicle.vehicleNumber}`);
    if (score < MIN_SCORE && vehicle.status !== 'MATCHED') continue;
    candidates.push({
      stopId: stop.id, tourId: stop.tourId, vehicleId: stop.tour.vehicleId, vehicleNumber: stop.tour.vehicle.vehicleNumber,
      licensePlate: stop.tour.vehicle.licensePlate, orderNumber: stop.tour.orderNumber, tourStatus: stop.tour.status, planVersion: stop.tour.planVersion,
      sequence: stop.sequence, type: stop.type, company: stop.company, address: stop.address, city: stop.city,
      appointmentAt: stop.appointmentAt?.toISOString() ?? null, windowStartAt: stop.appointmentWindowStartAt?.toISOString() ?? null,
      windowEndAt: stop.appointmentWindowEndAt?.toISOString() ?? null, score, reasons
    });
  }
  // Unloading and loading at one plant share one Termin: the pair is one candidate, the stop that keeps the Termin.
  const records = new Map(stops.map((stop) => [stop.id, stop]));
  const before = (candidate: AppointmentCandidate) => candidates.find((other) => other.tourId === candidate.tourId
    && other.sequence === candidate.sequence - 1 && samePlace(records.get(other.stopId)!, records.get(candidate.stopId)!));
  const ranked = candidates.filter((candidate) => {
    if (hasTermin(records.get(candidate.stopId)!)) return true;
    let lead = before(candidate);
    if (!lead) return true;
    for (let earlier = before(lead); earlier; earlier = before(earlier)) lead = earlier;
    if (candidate.score > lead.score) Object.assign(lead, { score: candidate.score, reasons: candidate.reasons });
    return false;
  });
  ranked.sort((a, b) => b.score - a.score || a.sequence - b.sequence);
  const top = ranked.slice(0, 3);
  const status = !top.length ? 'NONE' : top.length === 1 || top[0].score - top[1].score >= CLEAR_LEAD ? 'MATCHED' : 'AMBIGUOUS';
  return { status, vehicle, candidates: top };
}
