/**
 * Dates printed on an Auftrag for a loading or unloading stop, turned into what the planner uses:
 * an exact appointment ("FIX 13:30") or a time window. All values are wall-clock times in Europe/Berlin
 * written as "YYYY-MM-DDTHH:mm"; the browser converts them when the tour is confirmed.
 */

/** Normal warehouse hours: the bounds of "bis 12 Uhr" / "ab 14 Uhr" (owner's decision, 2026-11-02). */
export const DATE_ONLY_WINDOW = { start: "06:00", end: "18:00" } as const;
/**
 * A stop with only a date (or "00:00h", which these orders print for "that day") is planned at 06:00.
 * It is a planning rule, not a Termin: no lateness against it (owner's decision, 2026-11-04).
 */
export const PLANNED_START = "06:00";

export type StopSchedule = {
  appointmentLocal: string | null;
  appointmentWindowStartLocal: string | null;
  appointmentWindowEndLocal: string | null;
  /** Planned time when only a date is known; never a Termin. */
  plannedLocal?: string | null;
  /** Machine-readable reason when the text could not be used fully. */
  note: "DATE_ONLY" | "MISSING_DATE" | "UNSUPPORTED" | null;
};

const EMPTY: StopSchedule = { appointmentLocal: null, appointmentWindowStartLocal: null, appointmentWindowEndLocal: null, plannedLocal: null, note: null };
const dateOnly = (day: string): StopSchedule => ({ ...EMPTY, plannedLocal: `${day}T${PLANNED_START}`, note: "DATE_ONLY" });
const isMidnight = (value: string | null | undefined) => Boolean(value && value.endsWith("T00:00"));

const DATE_ISO = /(\d{4})-(\d{1,2})-(\d{1,2})/;
const DATE_GERMAN = /(?<![\d:])(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?\.?(?![\d:])/;
const TIME = /(\d{1,2})(?:[:.](\d{2}))?\s*(?:uhr|h)?/i;

/** Parses one cell or phrase such as "05.11.2026 08:00-14:00", "Mi 05.11. bis 12 Uhr", "2026-11-05", "FIX 13:30". */
export function parseStopSchedule(raw: string | null | undefined, now = new Date()): StopSchedule {
  const text = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!text) return EMPTY;
  if (/\bkw\s*\d{1,2}\b/i.test(text)) return { ...EMPTY, note: "UNSUPPORTED" };

  const date = findDate(text, now);
  const rest = date ? text.replace(date.match, " ") : text;
  const times = findTimes(rest);
  if (!date) return times.kind === "none" ? { ...EMPTY, note: "UNSUPPORTED" } : { ...EMPTY, note: "MISSING_DATE" };

  const day = date.day;
  if (times.kind === "none" || (times.kind === "exact" && times.at === "00:00")) return dateOnly(day);
  if (times.kind === "exact") return { ...EMPTY, appointmentLocal: `${day}T${times.at}` };
  if (times.kind === "range") return times.from <= times.to ? window(day, times.from, times.to) : { ...EMPTY, note: "UNSUPPORTED" };
  if (times.kind === "until") return window(day, times.at < DATE_ONLY_WINDOW.start ? "00:00" : DATE_ONLY_WINDOW.start, times.at);
  return window(day, times.at, times.at > DATE_ONLY_WINDOW.end ? "23:59" : DATE_ONLY_WINDOW.end);
}

/** Merges a separate date column and time column ("05.11.2026" + "08:00-12:00"). */
export function parseDateAndTime(dateText: string | null | undefined, timeText: string | null | undefined, now = new Date()): StopSchedule {
  const joined = [dateText, timeText].map((value) => (value ?? "").trim()).filter(Boolean).join(" ");
  return parseStopSchedule(joined, now);
}

/**
 * Cleans what an AI reader returned: a date-only value becomes the working-hours window,
 * and an exact time wins over a window (both together would be rejected when the tour is saved).
 */
export function normalizeAiSchedule(stop: {
  appointmentLocal: string | null;
  appointmentWindowStartLocal: string | null;
  appointmentWindowEndLocal: string | null;
  appointmentDateLocal?: string | null;
}, options: { dateOnly?: "planned" | "window" } = {}): StopSchedule {
  const day = (stop.appointmentDateLocal && isValidDay(stop.appointmentDateLocal) ? stop.appointmentDateLocal : null)
    ?? (isMidnight(stop.appointmentLocal) ? stop.appointmentLocal!.slice(0, 10) : null)
    ?? (isMidnight(stop.appointmentWindowStartLocal) && (isMidnight(stop.appointmentWindowEndLocal) || stop.appointmentWindowEndLocal?.endsWith("T23:59")) ? stop.appointmentWindowStartLocal!.slice(0, 10) : null);
  const midnightOnly = isMidnight(stop.appointmentLocal) || (isMidnight(stop.appointmentWindowStartLocal) && !stop.appointmentLocal);
  if (stop.appointmentLocal && !midnightOnly) return { ...EMPTY, appointmentLocal: stop.appointmentLocal };
  if (stop.appointmentWindowStartLocal && stop.appointmentWindowEndLocal && !midnightOnly) {
    return { ...EMPTY, appointmentWindowStartLocal: stop.appointmentWindowStartLocal, appointmentWindowEndLocal: stop.appointmentWindowEndLocal };
  }
  if (day) return options.dateOnly === "window" ? window(day, DATE_ONLY_WINDOW.start, DATE_ONLY_WINDOW.end, "DATE_ONLY") : dateOnly(day);
  return EMPTY;
}

/** "YYYY-MM-DD" of today in Berlin, given to the AI reader so it can complete a date without a year. */
export function berlinToday(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

function window(day: string, start: string, end: string, note: StopSchedule["note"] = null): StopSchedule {
  return { appointmentLocal: null, appointmentWindowStartLocal: `${day}T${start}`, appointmentWindowEndLocal: `${day}T${end}`, plannedLocal: null, note };
}

function findDate(text: string, now: Date): { day: string; match: string } | null {
  const iso = DATE_ISO.exec(text);
  if (iso) {
    const day = toDay(Number(iso[1]), Number(iso[2]), Number(iso[3]));
    return day ? { day, match: iso[0] } : null;
  }
  const german = DATE_GERMAN.exec(text);
  if (!german) return null;
  const dayOfMonth = Number(german[1]);
  const month = Number(german[2]);
  let year: number;
  if (german[3]) {
    year = german[3].length === 2 ? 2000 + Number(german[3]) : Number(german[3]);
  } else {
    // No year printed: the next such date, allowing orders from the last two months.
    const today = berlinToday(now);
    year = Number(today.slice(0, 4));
    const candidate = toDay(year, month, dayOfMonth);
    if (candidate && Date.parse(`${candidate}T00:00:00Z`) < Date.parse(`${today}T00:00:00Z`) - 60 * 86_400_000) year += 1;
  }
  const day = toDay(year, month, dayOfMonth);
  return day ? { day, match: german[0] } : null;
}

type Times =
  | { kind: "none" }
  | { kind: "exact"; at: string }
  | { kind: "range"; from: string; to: string }
  | { kind: "until"; at: string }
  | { kind: "from"; at: string };

function findTimes(text: string): Times {
  const lower = text.toLocaleLowerCase("de-DE");
  const range = /(\d{1,2}(?:[:.]\d{2})?)\s*(?:uhr|h)?\s*(?:-|–|—|bis)\s*(\d{1,2}(?:[:.]\d{2})?)\s*(?:uhr|h)?/i.exec(lower);
  if (range && !/^\s*bis/.test(lower.slice(range.index))) {
    const from = toTime(range[1]);
    const to = toTime(range[2]);
    if (from && to) return { kind: "range", from, to };
  }
  const until = /\b(?:bis|spätestens|spaetestens|until|до)\s*(\d{1,2}(?:[:.]\d{2})?)/i.exec(lower);
  if (until) {
    const at = toTime(until[1]);
    if (at) return { kind: "until", at };
  }
  const from = /\b(?:ab|from|с)\s*(\d{1,2}(?:[:.]\d{2})?)/i.exec(lower);
  if (from) {
    const at = toTime(from[1]);
    if (at) return { kind: "from", at };
  }
  const single = /(\d{1,2})[:.](\d{2})|(\d{1,2})\s*uhr/i.exec(lower);
  if (single) {
    const at = toTime(single[0]);
    if (at) return { kind: "exact", at };
  }
  return { kind: "none" };
}

function toTime(value: string): string | null {
  const match = TIME.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = match[2] === undefined ? 0 : Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function toDay(year: number, month: number, day: number): string | null {
  if (year < 2000 || year > 2100) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function isValidDay(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return Boolean(match && toDay(Number(match[1]), Number(match[2]), Number(match[3])));
}

/** Date rules for the AI reader; "today" lets it complete a date printed without a year. */
export function aiDateRules(now = new Date()): string {
  return [
    `Stop dates: today is ${berlinToday(now)} (Europe/Berlin). Every loading and unloading stop usually has a date; find it next to the stop or under labels such as Ladedatum, Ladetermin, Beladung, Abholdatum, Abholung, Liefertermin, Lieferdatum, Anlieferung, Entladedatum, Entladetermin, Zustelltermin, Fixtermin, Termin, Datum.`,
    'Write Berlin wall-clock values. Fill at most ONE of: appointmentLocal; the pair appointmentWindowStartLocal/appointmentWindowEndLocal; appointmentDateLocal.',
    'appointmentLocal (YYYY-MM-DDTHH:mm) only for one printed time such as "FIX 13:30" or "um 9 Uhr".',
    'A printed time range ("08:00-14:00", "von 8 bis 12 Uhr") goes to the window pair. "bis 12 Uhr" means window 06:00 to 12:00 of that day; "ab 14 Uhr" means 14:00 to 18:00.',
    'A date WITHOUT any time goes to appointmentDateLocal as YYYY-MM-DD; leave the other three null. Never turn a date-only value into 00:00.',
    'If the year is missing, use the next such date that is not more than 60 days before today. A calendar week (KW) alone is not a date: leave all null and add a Russian warning.',
    'Never invent a date or time that is not printed.'
  ].join(' ');
}
