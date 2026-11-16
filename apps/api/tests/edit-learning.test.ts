import { describe, expect, it } from 'vitest';
import { applyRulesToStop, type AddressRuleRecord } from '../src/services/address-rules.js';
import { lessonsFromEdits, type SavedStop } from '../src/services/edit-learning.js';

// Owner, 13.–15.11.2026: a Petershagen stop saved in the wrong town, corrected by the dispatcher in the saved tour.
const wrong: SavedStop = { id: 's1', company: 'Muster Logistik', address: 'Industriestraße 12, 15370 Petershagen', city: 'Petershagen', latitude: 52.53, longitude: 13.79 };
const fixed = { id: 's1', company: 'Muster Logistik', address: 'Industriestraße 12, 32469 Petershagen', city: 'Petershagen', latitude: 52.38, longitude: 8.97 };

describe('a correction in a saved tour is remembered (owner, 15.11)', () => {
  it('a corrected address becomes the place for the company in its town', () => {
    expect(lessonsFromEdits([wrong], [fixed])).toEqual([{ sourceLabel: 'Muster Logistik Petershagen', company: 'Muster Logistik', street: 'Industriestraße 12',
      postalCode: '32469', city: 'Petershagen', latitude: 52.38, longitude: 8.97 }]);
  });

  it('so the next Auftrag naming that company in that town gets the corrected place at once', () => {
    const [lesson] = lessonsFromEdits([wrong], [fixed]);
    const rule = { pattern: 'muster logistik petershagen', kind: 'SITE', company: lesson.company, street: lesson.street, postalCode: lesson.postalCode, city: lesson.city,
      latitude: lesson.latitude, longitude: lesson.longitude, requiresTermin: false, builtIn: false } as AddressRuleRecord;
    const next = applyRulesToStop({ company: 'Muster Logistik', address: 'Petershagen', city: 'Petershagen', appointmentLocal: null }, [rule]);
    expect(next).toMatchObject({ address: 'Industriestraße 12, 32469 Petershagen', ruleApplied: true });
  });

  it('a point moved to the gate with the same address is learned too', () => {
    const gate = { ...wrong, address: 'Industriestraße 12, 15370 Petershagen', latitude: 52.545, longitude: 13.79 };
    expect(lessonsFromEdits([wrong], [gate])).toHaveLength(1);
  });

  it('nothing to learn from an unchanged stop, a small nudge, a new stop, a town only, or no point', () => {
    expect(lessonsFromEdits([wrong], [{ ...wrong }])).toEqual([]);
    expect(lessonsFromEdits([wrong], [{ ...wrong, latitude: 52.531 }])).toEqual([]);
    expect(lessonsFromEdits([wrong], [{ ...fixed, id: undefined }])).toEqual([]);
    expect(lessonsFromEdits([wrong], [{ ...fixed, address: '32469 Petershagen' }])).toEqual([]);
    expect(lessonsFromEdits([wrong], [{ ...fixed, address: 'Industriestraße, 32469 Petershagen' }])).toEqual([]);
    expect(lessonsFromEdits([wrong], [{ ...fixed, latitude: undefined }])).toEqual([]);
  });
});
