import { describe, expect, it } from 'vitest';
import { mentionsZuladung, withZuladungNote, zuladungState } from '../src/services/zuladung.js';

const stop = (sequence: number, type: string, extra: Record<string, unknown> = {}) => ({ sequence, type, instructions: null, completedAt: null, ...extra });

describe('Zuladung on a tour', () => {
  it.each([
    ['Borken für Königswalde + evt. Zuladung', true],
    ['Werk Berlin für Hafen Hamburg\nZuladung möglich', true],
    ['evtl. Zuladung in Kassel', true],
    ['ZULADUNG', true],
    ['Borken für Königswalde', false],
    ['Zuladungsstelle Nord', false],
    [null, false]
  ])('%s → %s', (text, expected) => expect(mentionsZuladung(text)).toBe(expected));

  it('is OPEN until the dispatcher adds the pick-up or the first unloading is done', () => {
    const tourRemarks = 'Borken für Königswalde + evt. Zuladung';
    expect(zuladungState({ tourRemarks, stops: [stop(1, 'LOAD'), stop(2, 'UNLOAD')] })).toBe('OPEN');
    expect(zuladungState({ tourRemarks, stops: [stop(1, 'LOAD'), stop(2, 'LOAD', { instructions: 'Zuladung' }), stop(3, 'UNLOAD')] })).toBe('ADDED');
    expect(zuladungState({ tourRemarks, stops: [stop(1, 'LOAD'), stop(2, 'UNLOAD', { completedAt: new Date() })] })).toBe('NONE');
    expect(zuladungState({ tourRemarks: 'Borken für Königswalde', stops: [stop(1, 'LOAD'), stop(2, 'UNLOAD')] })).toBe('NONE');
  });

  it('adds the German note only while OPEN', () => {
    const open = { tourRemarks: 'evt. Zuladung', stops: [stop(1, 'LOAD'), stop(2, 'UNLOAD')] };
    expect(withZuladungNote(null, open)).toBe('Zuladung möglich');
    expect(withZuladungNote('Fahrzeug steht an der Ladestelle', open)).toBe('Fahrzeug steht an der Ladestelle; Zuladung möglich');
    expect(withZuladungNote('Text', null)).toBe('Text');
  });
});
