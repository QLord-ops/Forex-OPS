// A truck standing at a stop's place this long before the stop's planned time is on another trip: tomorrow's loading at
// the same plant must not take this morning's stay (owner, 12.11.2026, LKW GÖ FX 727).
export const AUTO_EARLY_HOURS = 12;

type TimedStop = { appointmentAt?: Date | null; appointmentWindowStartAt?: Date | null; plannedAt?: Date | null };

/** The earliest planned moment of the stop: its Termin, the start of its window or its planned time. */
export function plannedTimeOf(stop: TimedStop): Date | null {
  const times = [stop.appointmentWindowStartAt, stop.appointmentAt, stop.plannedAt]
    .filter((value): value is Date => value instanceof Date && Number.isFinite(value.getTime()))
    .map((value) => value.getTime());
  return times.length ? new Date(Math.min(...times)) : null;
}

/** GPS before this moment is not about this stop: automatic arrival and BELADEN/ENTLADEN ignore it. Null: no planned time. */
export function autoWindowStart(stop: TimedStop): Date | null {
  const planned = plannedTimeOf(stop);
  return planned ? new Date(planned.getTime() - AUTO_EARLY_HOURS * 3600_000) : null;
}
