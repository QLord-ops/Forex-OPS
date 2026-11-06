import type { PrismaClient } from '@prisma/client';
import { normalizePattern, type AddressRuleService } from './address-rules.js';
import { writeAuditLog, type AuditActor } from './audit-log.js';
import {
  BUILT_IN_IMPORT_RULES, cleanCity, inferCityFromAddress, normalizeRouteText, parseTourRemarksRoute, tourRemarkCompanyTokens,
  withBuiltInImportRules, type LearnedImportRules
} from './pdf-order-import.js';

export type ImportRuleKind = 'ALIAS' | 'IGNORE_LABEL' | 'STOP_TYPE';
export type CorrectionKind = 'STOP_REMOVED' | 'STOP_ADDED' | 'FIELD_CHANGED';
export type CorrectionField = 'company' | 'address' | 'city' | 'type';

/** A stop as the AI read it (from previewJson) — only the fields the learning compares. */
export type PreviewStopLike = {
  sequence?: number;
  type: 'LOAD' | 'UNLOAD';
  company?: string | null;
  address?: string | null;
  city?: string | null;
  sourceExcerpt?: string | null;
  sourceLabel?: string | null;
};

/** A stop as the dispatcher saved it. `draftStopIndex` points back at the preview stop it came from. */
export type ConfirmedStopLike = {
  sequence: number;
  type: 'LOAD' | 'UNLOAD';
  company?: string | null;
  address: string;
  city?: string | null;
  latitude?: number;
  longitude?: number;
  geocodePrecision?: string | null;
  draftStopIndex?: number | null;
};

export type CorrectionContext = {
  tourRemarksLabel: string | null;
  sourceExcerpt: string | null;
  company: string | null;
  city: string | null;
  stopType: 'LOAD' | 'UNLOAD';
  /** The preview label the address rules key on, kept for SITE learning. */
  sourceLabel: string | null;
  /** Coordinates of the confirmed stop, when the dispatcher corrected a place. */
  latitude?: number;
  longitude?: number;
  geocodePrecision?: string | null;
};

export type CorrectionDraft = {
  kind: CorrectionKind;
  field: CorrectionField | null;
  aiValue: string | null;
  finalValue: string | null;
  context: CorrectionContext;
  signature: string;
};

export type RuleCandidate = { kind: ImportRuleKind; pattern: string; value: string | null };

const same = (left: string | null | undefined, right: string | null | undefined) => normalizePattern(left) === normalizePattern(right);
const cityOf = (stop: { city?: string | null; address?: string | null }) => cleanCity(stop.city) ?? inferCityFromAddress(stop.address ?? null);

function tokens(value: string | null | undefined): string[] {
  return normalizeRouteText(value ?? '').split(' ').filter((token) => token.length >= 2);
}

function overlap(left: string[], right: string[]): number {
  if (!left.length || !right.length) return 0;
  const set = new Set(right);
  const shared = left.filter((token) => set.has(token)).length;
  return shared / Math.min(left.length, right.length);
}

function signatureOf(kind: CorrectionKind, field: CorrectionField | null, contextKey: string, finalValue: string | null): string {
  return `${kind}:${field ?? ''}:${normalizeRouteText(contextKey)}:${normalizeRouteText(finalValue ?? '')}`;
}

/**
 * What the dispatcher changed between the AI preview and the saved tour. Stops pair up by `draftStopIndex`; stops the
 * client did not index pair by type and company or city. Notes, references and times are not compared: they change
 * on every tour and teach nothing.
 */
export function diffImportedStops(previewStops: PreviewStopLike[], confirmedStops: ConfirmedStopLike[], context: { tourRemarks?: string | null } = {}): CorrectionDraft[] {
  const route = parseTourRemarksRoute(context.tourRemarks ?? null) ?? [];
  const preview = [...previewStops].sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0));
  const pairs = new Map<number, ConfirmedStopLike>();
  const unmatched: ConfirmedStopLike[] = [];
  for (const stop of confirmedStops) {
    const index = stop.draftStopIndex;
    if (typeof index === 'number' && index >= 0 && index < preview.length && !pairs.has(index)) pairs.set(index, stop);
    else unmatched.push(stop);
  }
  // Same type first; then the same place with the type changed, so a LOAD→UNLOAD flip is a correction, not a swap.
  for (const sameType of [true, false]) {
    for (const stop of unmatched.splice(0)) {
      const index = preview.findIndex((candidate, position) => !pairs.has(position) && (!sameType || candidate.type === stop.type)
        && (overlap(tokens(candidate.company), tokens(stop.company)) >= 0.5 || (cityOf(candidate) !== null && same(cityOf(candidate), cityOf(stop)))));
      if (index >= 0) pairs.set(index, stop); else unmatched.push(stop);
    }
  }

  const contextOf = (stop: PreviewStopLike, index: number, confirmed?: ConfirmedStopLike): CorrectionContext => {
    const city = cityOf(stop);
    const routeStop = route.length === preview.length ? route[index] : route.find((item) => item.cityHint && same(item.cityHint, city));
    // A stop the current rules no longer produce from the Tourbemerkung ("LG") still names itself: no street, only a label.
    const hasStreet = /\d/.test(stop.address ?? '') && !same(stop.address, city);
    const ownLabel = !hasStreet && stop.company && (!stop.address || same(stop.address, stop.company) || same(stop.address, city)) ? stop.company : null;
    return {
      tourRemarksLabel: routeStop?.label ?? ownLabel, sourceExcerpt: stop.sourceExcerpt ?? null, company: stop.company ?? null, city,
      stopType: stop.type, sourceLabel: stop.sourceLabel ?? ([stop.company, city].filter(Boolean).join(' ') || null),
      ...(confirmed?.latitude !== undefined && confirmed.longitude !== undefined ? { latitude: confirmed.latitude, longitude: confirmed.longitude, geocodePrecision: confirmed.geocodePrecision ?? null } : {})
    };
  };

  const corrections: CorrectionDraft[] = [];
  preview.forEach((stop, index) => {
    const confirmed = pairs.get(index);
    const ctx = contextOf(stop, index, confirmed);
    if (!confirmed) {
      corrections.push({ kind: 'STOP_REMOVED', field: null, aiValue: [stop.company, stop.address].filter(Boolean).join(', ') || null, finalValue: null, context: ctx,
        signature: signatureOf('STOP_REMOVED', null, ctx.tourRemarksLabel ?? `${stop.company ?? ''} ${ctx.city ?? ''}`, null) });
      return;
    }
    const changes: Array<[CorrectionField, string | null, string | null]> = [];
    if (!same(stop.company, confirmed.company) && (stop.company || confirmed.company)) changes.push(['company', stop.company ?? null, confirmed.company ?? null]);
    if (!same(stop.address, confirmed.address) && (stop.address || confirmed.address)) changes.push(['address', stop.address ?? null, confirmed.address]);
    const previewCity = cityOf(stop); const confirmedCity = cityOf(confirmed);
    if (!same(previewCity, confirmedCity) && (previewCity || confirmedCity)) changes.push(['city', previewCity, confirmedCity]);
    if (stop.type !== confirmed.type) changes.push(['type', stop.type, confirmed.type]);
    for (const [field, aiValue, finalValue] of changes) {
      corrections.push({ kind: 'FIELD_CHANGED', field, aiValue, finalValue, context: ctx,
        signature: signatureOf('FIELD_CHANGED', field, field === 'type' ? `${confirmed.company ?? ''} ${confirmedCity ?? ''}` : aiValue ?? '', finalValue) });
    }
  });
  for (const stop of unmatched) {
    const city = cityOf(stop);
    corrections.push({ kind: 'STOP_ADDED', field: null, aiValue: null, finalValue: [stop.company, stop.address].filter(Boolean).join(', ') || stop.address,
      context: { tourRemarksLabel: null, sourceExcerpt: null, company: stop.company ?? null, city, stopType: stop.type, sourceLabel: null },
      signature: signatureOf('STOP_ADDED', null, `${stop.company ?? ''} ${city ?? ''}`, stop.type) });
  }
  return corrections;
}

/**
 * Rules a correction supports. Conservative on purpose: an alias only for a short token the dispatcher renamed,
 * an ignored label only for a one-word label that never had a street, a stop type only when the type itself changed.
 */
export function deriveRuleCandidates(correction: CorrectionDraft): RuleCandidate[] {
  const { context } = correction;
  if (correction.kind === 'STOP_REMOVED') {
    const label = context.tourRemarksLabel;
    const hadStreet = /\d/.test(context.sourceExcerpt ?? '') && (context.company ?? '').trim().length > 0 && context.city !== null && !same(context.company, label);
    if (label && tokens(label).length === 1 && normalizeRouteText(label).length >= 2 && !hadStreet) return [{ kind: 'IGNORE_LABEL', pattern: normalizeRouteText(label), value: null }];
    return [];
  }
  if (correction.kind !== 'FIELD_CHANGED') return [];
  if (correction.field === 'company' && correction.finalValue) {
    const aiTokens = tokens(correction.aiValue).filter((token) => !context.city || token !== normalizeRouteText(context.city));
    const labelTokens = context.tourRemarksLabel ? tourRemarkCompanyTokens({ type: context.stopType, label: context.tourRemarksLabel, cityHint: context.city ?? '', addressSource: 'TOUR_REMARKS', references: [], cargo: null }) : [];
    const token = aiTokens.length === 1 && aiTokens[0].length <= 4 ? aiTokens[0] : labelTokens.length === 1 && labelTokens[0].length <= 4 ? labelTokens[0] : null;
    if (token && !normalizeRouteText(correction.finalValue).split(' ').includes(token)) return [{ kind: 'ALIAS', pattern: token, value: correction.finalValue.trim() }];
    return [];
  }
  if (correction.field === 'type' && (correction.finalValue === 'LOAD' || correction.finalValue === 'UNLOAD')) {
    const pattern = normalizeRouteText([context.company, context.city].filter(Boolean).join(' '));
    return pattern ? [{ kind: 'STOP_TYPE', pattern, value: correction.finalValue }] : [];
  }
  return [];
}

type RuleRow = { id: string; kind: string; pattern: string; value: string | null; active: boolean; hits: number; applied: number; builtIn: boolean; lastSeenAt: Date | null; createdAt: Date; updatedAt: Date };

export type ImportLearningOptions = { threshold?: number; exampleLimit?: number };

/**
 * Keeps the dispatchers' corrections of AI imports, turns repeated ones into rules and feeds the rules and a few
 * confirmed examples back into the next import. Nothing here ever blocks a tour: callers catch and log.
 */
export class ImportLearningService {
  private cache: { at: number; learned: LearnedImportRules } | null = null;
  private readonly threshold: number;
  private readonly exampleLimit: number;

  constructor(private readonly db: PrismaClient, private readonly addressRules: Pick<AddressRuleService, 'learn'>, options: ImportLearningOptions = {}) {
    this.threshold = options.threshold ?? 2;
    this.exampleLimit = options.exampleLimit ?? 3;
  }

  /** Called once per newly created tour. Re-saving the same document adds nothing. */
  async recordConfirmation(input: {
    documentId: string; tourId: string | null; dispatcherId: string | null; preview: unknown; orderNumber: string;
    confirmedStops: ConfirmedStopLike[]; tourRemarks: string | null; actor?: AuditActor;
  }, now = new Date()) {
    const draft = pickDraft(input.preview, input.orderNumber);
    if (!draft) return { corrections: 0, rules: [] as RuleCandidate[] };
    const corrections = diffImportedStops(draft.stops, input.confirmedStops, { tourRemarks: input.tourRemarks ?? draft.tourRemarks ?? null });
    if (!corrections.length) return { corrections: 0, rules: [] };
    const known = new Set((await this.db.importCorrection.findMany({ where: { documentId: input.documentId }, select: { signature: true } })).map((row) => row.signature));
    const fresh = corrections.filter((correction) => !known.has(correction.signature) && known.add(correction.signature));
    if (!fresh.length) return { corrections: 0, rules: [] };
    await this.db.importCorrection.createMany({
      data: fresh.map((correction) => ({
        documentId: input.documentId, tourId: input.tourId, dispatcherId: input.dispatcherId, kind: correction.kind, field: correction.field,
        aiValue: correction.aiValue?.slice(0, 500) ?? null, finalValue: correction.finalValue?.slice(0, 500) ?? null,
        contextJson: JSON.stringify(correction.context), signature: correction.signature.slice(0, 400), createdAt: now
      }))
    });
    const rules: RuleCandidate[] = [];
    for (const correction of fresh) {
      await this.learnSite(correction, input.actor, now);
      for (const candidate of deriveRuleCandidates(correction)) {
        if (rules.some((rule) => rule.kind === candidate.kind && rule.pattern === candidate.pattern)) continue;
        rules.push(candidate);
        await this.countRule(candidate, input.actor, now);
      }
    }
    this.cache = null;
    return { corrections: fresh.length, rules };
  }

  /** A corrected place with a street and coordinates becomes an address rule (same as the old learnLabel path). */
  private async learnSite(correction: CorrectionDraft, actor: AuditActor | undefined, now: Date) {
    const { context } = correction;
    if (correction.kind !== 'FIELD_CHANGED' || !['address', 'company', 'city'].includes(correction.field ?? '')) return;
    if (!context.sourceLabel || context.latitude === undefined || context.longitude === undefined) return;
    if (context.geocodePrecision && context.geocodePrecision !== 'EXACT' && context.geocodePrecision !== 'STREET') return;
    const address = correction.field === 'address' ? correction.finalValue : null;
    if (!address || !/\d/.test(address)) return;
    await this.addressRules.learn({ sourceLabel: context.sourceLabel, company: context.company, street: address.split(',')[0]?.trim() || null,
      postalCode: address.match(/\b\d{5}\b/)?.[0] ?? null, city: context.city, latitude: context.latitude, longitude: context.longitude }, actor, now).catch(() => undefined);
  }

  private async countRule(candidate: RuleCandidate, actor: AuditActor | undefined, now: Date) {
    const existing = await this.db.importRule.findUnique({ where: { kind_pattern: { kind: candidate.kind, pattern: candidate.pattern } } });
    const hits = (existing?.hits ?? 0) + 1;
    // Activation happens exactly at the threshold: a rule an admin switched off later stays off however often it recurs.
    const activate = !existing?.builtIn && hits === this.threshold && !existing?.active;
    const saved = await this.db.importRule.upsert({
      where: { kind_pattern: { kind: candidate.kind, pattern: candidate.pattern } },
      create: { kind: candidate.kind, pattern: candidate.pattern, value: candidate.value, hits, lastSeenAt: now, active: activate },
      update: { hits, lastSeenAt: now, ...(activate ? { active: true } : {}), ...(existing && !existing.active && candidate.value ? { value: candidate.value } : {}) }
    });
    if (activate) await writeAuditLog(this.db, actor, { action: 'IMPORT_RULE_ACTIVATED', entityType: 'ImportRule', entityId: saved.id, metadata: { kind: candidate.kind, pattern: candidate.pattern, value: candidate.value, hits }, createdAt: now });
  }

  /** Active rules merged over the built-in ones; the import reads this on every preview (cached 30 s). */
  async learned(): Promise<LearnedImportRules> {
    if (this.cache && Date.now() - this.cache.at < 30_000) return this.cache.learned;
    const rows = await this.db.importRule.findMany({ where: { active: true }, orderBy: { hits: 'desc' } }).catch(() => null);
    if (!rows) return BUILT_IN_IMPORT_RULES;
    const aliases: Record<string, string> = {};
    const ignoreLabels: Record<string, string | null> = {};
    const stopTypes: Record<string, 'LOAD' | 'UNLOAD'> = {};
    for (const row of rows) {
      if (row.kind === 'ALIAS' && row.value) aliases[row.pattern] = row.value;
      else if (row.kind === 'IGNORE_LABEL') ignoreLabels[row.pattern] = row.value;
      else if (row.kind === 'STOP_TYPE' && (row.value === 'LOAD' || row.value === 'UNLOAD')) stopTypes[row.pattern] = row.value;
    }
    const learned = withBuiltInImportRules({ aliases, ignoreLabels, stopTypes, rulesText: rulesText(rows), examplesText: await this.examplesText() });
    this.cache = { at: Date.now(), learned };
    return learned;
  }

  /** Up to a few recent tours the dispatchers corrected, as compact text: Tourbemerkung and the stops they saved. */
  private async examplesText(): Promise<string> {
    const documents = await this.db.orderDocument.findMany({
      where: { status: 'ATTACHED', confirmedJson: { not: null }, corrections: { some: {} } },
      orderBy: { attachedAt: 'desc' }, take: this.exampleLimit, select: { confirmedJson: true }
    }).catch(() => []);
    const examples: string[] = [];
    let length = 0;
    for (const document of documents) {
      const example = exampleOf(document.confirmedJson);
      if (!example || examples.includes(example) || length + example.length > 2000) continue;
      examples.push(example);
      length += example.length;
    }
    return examples.join(' ');
  }

  list() { return this.db.importRule.findMany({ orderBy: [{ active: 'desc' }, { hits: 'desc' }, { pattern: 'asc' }] }); }

  async correctionsSince(since: Date) { return this.db.importCorrection.count({ where: { createdAt: { gte: since } } }); }

  async update(id: string, patch: { active?: boolean; value?: string | null }, actor?: AuditActor) {
    const saved = await this.db.importRule.update({ where: { id }, data: patch });
    await writeAuditLog(this.db, actor, { action: 'IMPORT_RULE_UPDATED', entityType: 'ImportRule', entityId: id, metadata: { fields: Object.keys(patch), ...patch } });
    this.cache = null;
    return saved;
  }

  async remove(id: string, actor?: AuditActor) {
    const removed = await this.db.importRule.delete({ where: { id } });
    await writeAuditLog(this.db, actor, { action: 'IMPORT_RULE_DELETED', entityType: 'ImportRule', entityId: id, metadata: { kind: removed.kind, pattern: removed.pattern } });
    this.cache = null;
  }
}

type DraftLike = { orderNumber?: string | null; tourRemarks?: string | null; stops: PreviewStopLike[] };

/** The draft of the stored preview the tour was made from: by Auftrag number, else the only one. */
export function pickDraft(preview: unknown, orderNumber: string): DraftLike | null {
  const drafts = (preview as { drafts?: unknown })?.drafts;
  if (!Array.isArray(drafts) || !drafts.length) return null;
  const valid = drafts.filter((draft): draft is DraftLike => Boolean(draft) && Array.isArray((draft as DraftLike).stops));
  return valid.find((draft) => same(draft.orderNumber, orderNumber)) ?? (valid.length === 1 ? valid[0] : null);
}

/** One line per rule, in the model's language; values are data from the dispatchers and are flattened to one line. */
function rulesText(rows: RuleRow[]): string {
  const lines = rows.slice(0, 40).map((row) => {
    const pattern = clean(row.pattern).toUpperCase();
    if (row.kind === 'ALIAS') return `'${pattern}' means the company ${clean(row.value)}.`;
    if (row.kind === 'IGNORE_LABEL') return `'${pattern}' is never a stop or a place${row.value ? ` (it describes the cargo: ${clean(row.value)})` : ''}.`;
    return `'${clean(row.pattern)}' is always an ${row.value} stop.`;
  });
  let text = '';
  for (const line of lines) { if (text.length + line.length > 1200) break; text += (text ? ' ' : '') + line; }
  return text;
}

function exampleOf(confirmedJson: string | null): string | null {
  try {
    const confirmed = JSON.parse(confirmedJson ?? 'null') as { tourRemarks?: string | null; stops?: Array<{ type?: string; company?: string | null; city?: string | null; address?: string }> } | null;
    if (!confirmed?.tourRemarks || !Array.isArray(confirmed.stops) || !confirmed.stops.length) return null;
    const stops = confirmed.stops.map((stop, index) => `${index + 1} ${stop.type === 'LOAD' ? 'LOAD' : 'UNLOAD'} ${clean([stop.company, stop.city ?? inferCityFromAddress(stop.address ?? null)].filter(Boolean).join(', '))}`);
    return `Tourbemerkung '${clean(confirmed.tourRemarks)}' → ${stops.join('; ')}.`;
  } catch { return null; }
}

/** One line, no quotes or braces, at most 120 characters: the model gets values, never markup or instructions. */
function clean(value: string | null | undefined): string {
  return (value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/[{}[\]"'`]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);
}
