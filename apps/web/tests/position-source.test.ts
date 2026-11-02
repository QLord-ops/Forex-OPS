import { describe, expect, it } from 'vitest';
import { calculatedPositionLabel, positionSourceText } from '../src/lib/format';

describe('position source label', () => {
  it('names fresh and stale Webfleet, manual and calculated positions', () => {
    expect(positionSourceText({ positionSource: 'WEBFLEET', telemetryStale: false, telemetryAgeSeconds: 90 })).toBe('Webfleet GPS · 2 мин назад');
    expect(positionSourceText({ positionSource: 'WEBFLEET', telemetryStale: true, telemetryAgeSeconds: 1800 })).toBe('Webfleet GPS устарел · 30 мин назад');
    expect(positionSourceText({ positionSource: 'MANUAL' })).toBe('Позиция указана диспетчером вручную');
    expect(positionSourceText({ positionSource: 'CALCULATED' })).toBe(calculatedPositionLabel);
    expect(positionSourceText(null)).toBe(calculatedPositionLabel);
  });
});
