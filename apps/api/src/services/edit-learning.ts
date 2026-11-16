import { distanceMeters } from './webfleet.js';

/**
 * A dispatcher who fixes a stop of a saved tour (a wrong Petershagen, the plant gate instead of the postal address) teaches
 * the system for good (owner, 15.11.2026): the corrected place becomes the learned site for the stop's company in its town,
 * and the next Auftrag naming them gets it straight away. Only a full address (street with number and postcode) with a
 * point on the map is learned; a town or a guess is not.
 */
export type SavedStop = { id: string; company: string | null; address: string; city: string | null; latitude: number; longitude: number };
export type EditedStop = { id?: string; company?: string | null; address: string; city?: string | null; latitude?: number; longitude?: number };
export type SiteLesson = { sourceLabel: string; company: string | null; street: string | null; postalCode: string | null; city: string | null; latitude: number; longitude: number };

// A point moved less than this is the same place: nothing to learn.
const MOVED_METERS = 300;
const fold = (value: string | null | undefined) => (value ?? '').toLowerCase().replace(/[^a-z0-9äöüß]+/g, ' ').trim();

export function lessonsFromEdits(before: SavedStop[], after: EditedStop[]): SiteLesson[] {
  const lessons: SiteLesson[] = [];
  for (const edited of after) {
    const saved = edited.id ? before.find((stop) => stop.id === edited.id) : undefined;
    if (!saved || edited.latitude === undefined || edited.longitude === undefined) continue;
    const label = [saved.company, saved.city].filter(Boolean).join(' ').trim();
    const postalCode = edited.address.match(/\b\d{5}\b/)?.[0] ?? null;
    const street = edited.address.split(',')[0]?.trim() || null;
    if (!label || !postalCode || !street || !/\d/.test(street) || street.includes(postalCode)) continue;
    const readAgain = fold(edited.address) !== fold(saved.address);
    const moved = distanceMeters(saved.latitude, saved.longitude, edited.latitude, edited.longitude) > MOVED_METERS;
    if (!readAgain && !moved) continue;
    lessons.push({ sourceLabel: label, company: edited.company?.trim() || saved.company, street, postalCode,
      city: edited.city?.trim() || saved.city, latitude: edited.latitude, longitude: edited.longitude });
  }
  return lessons;
}
