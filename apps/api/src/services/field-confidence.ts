import { normalizeRouteText } from './pdf-order-import.js';

export const STOP_FIELDS = ['type', 'company', 'address', 'city', 'time', 'loadingMeters', 'references'] as const;
export const ORDER_FIELDS = ['orderNumber', 'vehicle', 'trailer'] as const;
export type StopField = (typeof STOP_FIELDS)[number];
export type OrderField = (typeof ORDER_FIELDS)[number];
export type FieldLevel = 'OK' | 'CHECK' | 'DOUBT';

/** Why a field scored as it did; the web shows each code as a short reason next to the field. */
export type ReasonCode =
  | 'AI_UNSURE' | 'NO_EVIDENCE' | 'MISSING'
  | 'ADDRESS_NO_HOUSE_NUMBER' | 'ADDRESS_NO_POSTCODE' | 'DATE_INVALID' | 'DATE_PAST'
  | 'ADDRESS_RULE' | 'DEPARTMENT' | 'ALIAS_APPLIED' | 'PLACEHOLDER' | 'FROM_OTHER_STOP_NOTE'
  | 'TOUR_REMARKS_MATCH' | 'WARNING' | 'OFTEN_CORRECTED';

export type FieldScore = { score: number; level: FieldLevel; reasons: ReasonCode[]; evidence: string | null };
/** What the model said about one field: its own certainty and the shortest quote that shows the value. */
export type AiField = { c: number; evidence: string | null };
/** Where the stop came from in the reconcile with the Tourbemerkung. */
export type StopProvenance = 'TABLE' | 'TOUR_REMARKS' | 'DEPARTMENT' | 'PLACEHOLDER' | 'OTHER_STOP_NOTE';

export const LEVEL_OK = 0.85;
export const LEVEL_CHECK = 0.6;

export function levelOf(score: number): FieldLevel {
  return score >= LEVEL_OK ? 'OK' : score >= LEVEL_CHECK ? 'CHECK' : 'DOUBT';
}

type StopLike = {
  type: 'LOAD' | 'UNLOAD';
  company?: string | null; address?: string | null; city?: string | null;
  appointmentLocal?: string | null; appointmentWindowStartLocal?: string | null; appointmentWindowEndLocal?: string | null; plannedLocal?: string | null;
  loadingMeters?: number | null; referenceNumbers?: string[];
  sourceExcerpt?: string | null; confidence?: number;
  aiConfidence?: Partial<Record<StopField, AiField>> | null;
  provenance?: StopProvenance; aliasApplied?: boolean; ruleApplied?: boolean;
};
type WarningLike = { code: string; stopIndex?: number; field?: string };
type DraftLike = {
  orderNumber?: string | null; vehicleNumber?: string | null; vehiclePlate?: string | null; trailerPlate?: string | null; tourRemarks?: string | null;
  orderAiConfidence?: Partial<Record<OrderField, AiField>> | null;
  stops: StopLike[]; warnings: WarningLike[];
};

export type ScoringContext = {
  /** Values read by the AI need a printed quote; Excel cells are the document itself. */
  ai: boolean;
  /** Berlin "YYYY-MM-DD" of today: a date before it is suspicious. */
  today: string;
  /** Share of this customer's recent Auftrag in which the dispatchers corrected the field (0..1). */
  correctionRate?: Partial<Record<StopField, number>>;
};

// Notes that explain rather than doubt: a date-only stop is planned at 06:00 on purpose.
const INFORMATIVE_WARNINGS = new Set(['DATE_ONLY']);

class Scorer {
  score: number;
  readonly reasons: ReasonCode[] = [];
  constructor(base: number) { this.score = clamp(base); }
  cap(limit: number, reason: ReasonCode) { if (this.score > limit) this.score = limit; this.note(reason); }
  floor(limit: number, reason: ReasonCode) { if (this.score < limit) this.score = limit; this.note(reason); }
  lower(by: number, reason: ReasonCode) { this.score = clamp(this.score - by); this.note(reason); }
  raise(by: number, reason: ReasonCode) { this.score = clamp(Math.min(0.99, this.score + by)); this.note(reason); }
  note(reason: ReasonCode) { if (!this.reasons.includes(reason)) this.reasons.push(reason); }
  result(evidence: string | null): FieldScore {
    const score = Math.round(this.score * 100) / 100;
    return { score, level: levelOf(score), reasons: this.reasons, evidence };
  }
}

const clamp = (value: number) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));

/** Most of the value's words appear in the quote, the stop's excerpt or the Tourbemerkung. */
export function supported(value: string, texts: Array<string | null | undefined>): boolean {
  const tokens = normalizeRouteText(value).split(' ').filter((token) => token.length >= 2);
  if (!tokens.length) return true;
  const haystack = ` ${normalizeRouteText(texts.filter(Boolean).join(' '))} `;
  if (haystack.trim() === '') return false;
  const found = tokens.filter((token) => haystack.includes(` ${token} `) || (token.length >= 5 && haystack.includes(token))).length;
  return found / tokens.length >= 0.5;
}

function stopValue(stop: StopLike, field: StopField): string | null {
  switch (field) {
    case 'type': return stop.type;
    case 'company': return stop.company?.trim() || null;
    case 'address': return stop.address?.trim() || null;
    case 'city': return stop.city?.trim() || null;
    case 'time': return stop.appointmentLocal || stop.appointmentWindowStartLocal || null;
    case 'loadingMeters': return typeof stop.loadingMeters === 'number' ? String(stop.loadingMeters) : null;
    case 'references': return stop.referenceNumbers?.length ? stop.referenceNumbers.join(' ') : null;
  }
}

/** "Rudolf-Diesel-Straße 2, 14974 Ludwigsfelde": street with a number, a postcode (DE 5 digits, AT/HU 4, PL 00-000). */
export function addressShape(address: string): { houseNumber: boolean; postcode: boolean } {
  const street = address.split(',')[0] ?? '';
  return { houseNumber: /\d/.test(street) && /\p{L}/u.test(street), postcode: /\b\d{4,5}\b|\b\d{2}-\d{3}\b/.test(address) };
}

const LOCAL = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/;

function scoreStopField(stop: StopLike, field: StopField, index: number, draft: DraftLike, context: ScoringContext): FieldScore | null {
  const value = stopValue(stop, field);
  const ai = stop.aiConfidence?.[field];
  // Optional details the Auftrag simply does not have are not doubts.
  if (!value && field !== 'address') return null;
  const scorer = new Scorer(ai?.c ?? stop.confidence ?? 0.65);
  if (ai && ai.c < LEVEL_CHECK) scorer.note('AI_UNSURE');
  if (!value) { scorer.cap(0.2, 'MISSING'); return scorer.result(null); }

  if (context.ai && field !== 'type' && !supported(value, [ai?.evidence, stop.sourceExcerpt, field === 'company' || field === 'city' ? draft.tourRemarks : null])) {
    scorer.cap(LEVEL_CHECK, 'NO_EVIDENCE');
  }
  if (field === 'address') {
    const shape = addressShape(value);
    if (!shape.houseNumber) scorer.cap(0.5, 'ADDRESS_NO_HOUSE_NUMBER');
    else if (!shape.postcode) scorer.cap(0.7, 'ADDRESS_NO_POSTCODE');
  }
  if (field === 'time') {
    const match = LOCAL.exec(value);
    const valid = match && Number(match[2]) < 24 && Number(match[3]) < 60 && !Number.isNaN(Date.parse(`${match[1]}T00:00:00Z`));
    if (!valid) scorer.cap(0.3, 'DATE_INVALID');
    else if (match[1] < context.today) scorer.cap(0.3, 'DATE_PAST');
  }

  // Where the value came from. A learned site rule or the Abteilung block is as good as printed; a guess is not.
  const place = field === 'address' || field === 'company' || field === 'city';
  if (place && stop.ruleApplied) scorer.floor(0.95, 'ADDRESS_RULE');
  else if (place && stop.provenance === 'DEPARTMENT') scorer.floor(0.9, 'DEPARTMENT');
  if (field === 'company' && stop.aliasApplied) scorer.floor(0.9, 'ALIAS_APPLIED');
  // A placeholder is only the Tourbemerkung label; a company the learned shorthand resolved ("MB") is known, its address is not.
  if (place && !stop.ruleApplied && stop.provenance === 'PLACEHOLDER' && !(field === 'company' && stop.aliasApplied)) scorer.cap(field === 'address' ? 0.4 : LEVEL_CHECK, 'PLACEHOLDER');
  if (field === 'address' && !stop.ruleApplied && stop.provenance === 'OTHER_STOP_NOTE') scorer.cap(0.55, 'FROM_OTHER_STOP_NOTE');
  if ((field === 'type' || field === 'company') && stop.provenance === 'TOUR_REMARKS') scorer.raise(0.1, 'TOUR_REMARKS_MATCH');

  if (draft.warnings.some((warning) => warning.stopIndex === index && warning.field === field && !INFORMATIVE_WARNINGS.has(warning.code))) scorer.cap(LEVEL_CHECK, 'WARNING');

  const rate = context.correctionRate?.[field] ?? 0;
  if (rate >= 0.2 && !stop.ruleApplied) scorer.lower(Math.min(0.25, rate * 0.5), 'OFTEN_CORRECTED');
  return scorer.result(ai?.evidence ?? null);
}

function orderValue(draft: DraftLike, field: OrderField): string | null {
  if (field === 'orderNumber') return draft.orderNumber?.trim() || null;
  if (field === 'vehicle') return draft.vehiclePlate?.trim() || draft.vehicleNumber?.trim() || null;
  return draft.trailerPlate?.trim() || null;
}

function scoreOrderField(draft: DraftLike, field: OrderField, context: ScoringContext): FieldScore | null {
  const value = orderValue(draft, field);
  const ai = draft.orderAiConfidence?.[field];
  if (!value) return field === 'orderNumber' ? { score: 0.2, level: 'DOUBT', reasons: ['MISSING'], evidence: null } : null;
  const scorer = new Scorer(ai?.c ?? 0.9);
  if (ai && ai.c < LEVEL_CHECK) scorer.note('AI_UNSURE');
  if (context.ai && ai && !supported(value, [ai.evidence])) scorer.cap(LEVEL_CHECK, 'NO_EVIDENCE');
  return scorer.result(ai?.evidence ?? null);
}

export type ScoredStop<T> = Omit<T, 'aiConfidence'> & { fieldConfidence: Partial<Record<StopField, FieldScore>> };
export type ScoredDraft<T extends DraftLike> = Omit<T, 'stops' | 'orderAiConfidence'> & {
  stops: Array<ScoredStop<T['stops'][number]>>;
  orderConfidence: Partial<Record<OrderField, FieldScore>>;
  confidenceSummary: { doubt: number; check: number };
};

/**
 * Every recognised field gets a score, a level (≥ 0.85 fine, 0.6–0.85 check, below 0.6 doubt) and the reasons. The
 * model's own certainty is the start; evidence, address shape, provenance, warnings and the customer's history move it.
 */
export function scoreDraft<T extends DraftLike>(draft: T, context: ScoringContext): ScoredDraft<T> {
  const stops = draft.stops.map((stop, index) => {
    const { aiConfidence: _ai, ...rest } = stop;
    const fieldConfidence: Partial<Record<StopField, FieldScore>> = {};
    for (const field of STOP_FIELDS) {
      const score = scoreStopField(stop, field, index, draft, context);
      if (score) fieldConfidence[field] = score;
    }
    return { ...rest, fieldConfidence } as ScoredStop<T['stops'][number]>;
  });
  const orderConfidence: Partial<Record<OrderField, FieldScore>> = {};
  for (const field of ORDER_FIELDS) {
    const score = scoreOrderField(draft, field, context);
    if (score) orderConfidence[field] = score;
  }
  const levels = [...stops.flatMap((stop) => Object.values(stop.fieldConfidence)), ...Object.values(orderConfidence)].map((item) => item!.level);
  const { orderAiConfidence: _order, ...rest } = draft;
  return { ...rest, stops, orderConfidence, confidenceSummary: { doubt: levels.filter((level) => level === 'DOUBT').length, check: levels.filter((level) => level === 'CHECK').length } } as ScoredDraft<T>;
}

/** Share of the customer's recent Auftrag in which each field was corrected (the learning records company, address, city, type). */
export function correctionRates(documents: number, corrected: Array<{ field: string | null; documents: number }>): Partial<Record<StopField, number>> {
  if (documents < 5) return {};
  const rates: Partial<Record<StopField, number>> = {};
  for (const row of corrected) {
    if (row.field && (STOP_FIELDS as readonly string[]).includes(row.field)) rates[row.field as StopField] = Math.min(1, row.documents / documents);
  }
  return rates;
}

type PreviewStopForOutcome = { type?: string; company?: string | null; address?: string | null; city?: string | null; appointmentLocal?: string | null; appointmentWindowStartLocal?: string | null;
  loadingMeters?: number | null; referenceNumbers?: string[]; fieldConfidence?: Partial<Record<StopField, FieldScore>> };
type ConfirmedStopForOutcome = { type?: string; company?: string | null; address?: string | null; city?: string | null; appointmentAt?: string | null; appointmentWindowStartAt?: string | null;
  loadingMeters?: number | null; referenceNumbers?: string[]; draftStopIndex?: number | null };

const sameText = (left: unknown, right: unknown) => normalizeRouteText(String(left ?? '')) === normalizeRouteText(String(right ?? ''));

/**
 * For calibration: each scored field of the preview and whether the dispatcher changed it before saving. Stops pair
 * by `draftStopIndex`; a removed stop counts as changed. Times compare by presence only (the client sends UTC).
 */
export function fieldOutcomes(previewStops: PreviewStopForOutcome[], confirmedStops: ConfirmedStopForOutcome[]): Array<{ field: StopField; level: FieldLevel; changed: boolean }> {
  const byIndex = new Map<number, ConfirmedStopForOutcome>();
  for (const stop of confirmedStops) if (typeof stop.draftStopIndex === 'number') byIndex.set(stop.draftStopIndex, stop);
  return previewStops.flatMap((stop, index) => {
    const saved = byIndex.get(index);
    return Object.entries(stop.fieldConfidence ?? {}).map(([field, score]) => {
      const key = field as StopField;
      let changed = !saved;
      if (saved) {
        if (key === 'type') changed = stop.type !== saved.type;
        else if (key === 'company' || key === 'address' || key === 'city') changed = !sameText(stop[key], saved[key]);
        else if (key === 'time') changed = Boolean(stop.appointmentLocal || stop.appointmentWindowStartLocal) !== Boolean(saved.appointmentAt || saved.appointmentWindowStartAt);
        else if (key === 'loadingMeters') changed = (stop.loadingMeters ?? null) !== (saved.loadingMeters ?? null);
        else changed = !sameText((stop.referenceNumbers ?? []).join(' '), (saved.referenceNumbers ?? []).join(' '));
      }
      return { field: key, level: score!.level, changed };
    });
  });
}

export type Calibration = Record<FieldLevel, { fields: number; changed: number }>;

export function calibrate(outcomes: Array<{ level: FieldLevel; changed: boolean }>): Calibration {
  const result: Calibration = { OK: { fields: 0, changed: 0 }, CHECK: { fields: 0, changed: 0 }, DOUBT: { fields: 0, changed: 0 } };
  for (const outcome of outcomes) {
    result[outcome.level].fields += 1;
    if (outcome.changed) result[outcome.level].changed += 1;
  }
  return result;
}
