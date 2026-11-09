import type { PrismaClient } from "@prisma/client";
import { writeAuditLog, type AuditActor } from "./audit-log.js";

export type AddressRuleKind = "COMPANY" | "CITY_CODE" | "SITE";
export type AddressRuleRecord = {
  pattern: string; kind: AddressRuleKind; company: string | null; street: string | null; postalCode: string | null; city: string | null;
  latitude: number | null; longitude: number | null; requiresTermin: boolean; builtIn?: boolean;
};

/** Lower case, umlauts kept as base letters, ß as ss, punctuation as spaces: "VW  Wolfsburg," → "vw wolfsburg". */
export function normalizePattern(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFKD").replace(/\p{M}/gu, "").replace(/ß/g, "ss")
    .toLocaleLowerCase("de-DE").replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}

const company = (pattern: string, name: string, requiresTermin = false): AddressRuleRecord =>
  ({ pattern, kind: "COMPANY", company: name, street: null, postalCode: null, city: null, latitude: null, longitude: null, requiresTermin, builtIn: true });
const cityCode = (pattern: string, city: string): AddressRuleRecord =>
  ({ pattern, kind: "CITY_CODE", company: null, street: null, postalCode: null, city, latitude: null, longitude: null, requiresTermin: false, builtIn: true });

/**
 * Base dictionary (owner's decision 2026-11-04). Learned rules in the database win over these.
 * Termin always arrives separately for VW, BLG, Mercedes-Benz, Seifert, Audi, Rudolph and Rhenus.
 */
export const BUILT_IN_RULES: AddressRuleRecord[] = [
  company("vw", "Volkswagen AG", true), company("volkswagen", "Volkswagen AG", true),
  company("audi", "AUDI AG", true), company("man", "MAN Truck & Bus SE"),
  company("blg", "BLG Logistics", true), company("porsche", "Porsche AG"),
  company("mercedes", "Mercedes-Benz AG", true), company("mercedes benz", "Mercedes-Benz AG", true), company("daimler", "Mercedes-Benz AG", true),
  company("bmw", "BMW AG"), company("schenker", "DB Schenker"), company("dhl", "DHL"),
  company("seifert", "Seifert Logistics", true), company("rudolph", "Rudolph Logistik", true), company("rhenus", "Rhenus Logistics", true),
  // German registration codes used as city shorthand in orders.
  cityCode("wob", "Wolfsburg"), cityCode("bs", "Braunschweig"), cityCode("go", "Göttingen"), cityCode("goe", "Göttingen"),
  cityCode("h", "Hannover"), cityCode("ks", "Kassel"), cityCode("md", "Magdeburg"), cityCode("z", "Zwickau"),
  cityCode("emd", "Emden"), cityCode("in", "Ingolstadt"), cityCode("m", "München"), cityCode("hb", "Bremen"),
  cityCode("hh", "Hamburg"), cityCode("b", "Berlin"), cityCode("l", "Leipzig"), cityCode("dd", "Dresden"),
  cityCode("c", "Chemnitz"), cityCode("ef", "Erfurt"), cityCode("s", "Stuttgart"), cityCode("ka", "Karlsruhe"),
  cityCode("bre", "Bremen"), cityCode("ld", "Ludwigsfelde")
];

const SITE_RADIUS_METERS = 300;
function metersApart(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number {
  const meridian = 111_320;
  return Math.hypot((a.latitude - b.latitude) * meridian, (a.longitude - b.longitude) * meridian * Math.cos((a.latitude * Math.PI) / 180));
}

/**
 * Companies whose Termin always comes as a separate slip, and learned places the admin marked «Termin нужен»:
 * such a place counts when the stop names it or stands on it.
 */
export function requiresTermin(text: string | null | undefined, rules: AddressRuleRecord[] = BUILT_IN_RULES,
  point?: { latitude: number; longitude: number } | null): boolean {
  const words = ` ${normalizePattern(text)} `;
  return rules.some((rule) => {
    if (!rule.requiresTermin) return false;
    if (rule.kind === "COMPANY") return words.includes(` ${rule.pattern} `);
    if (rule.kind !== "SITE") return false;
    if (point && rule.latitude !== null && rule.longitude !== null && metersApart(point, { latitude: rule.latitude, longitude: rule.longitude }) <= SITE_RADIUS_METERS) return true;
    return rule.pattern.split(" ").every((token) => words.includes(` ${token} `));
  });
}

/** A single-token city code ("WOB") spelled out; anything else stays as written. */
export function expandCity(city: string | null | undefined, rules: AddressRuleRecord[] = BUILT_IN_RULES): string | null {
  const pattern = normalizePattern(city);
  if (!pattern) return city ?? null;
  const rule = rules.find((item) => item.kind === "CITY_CODE" && item.pattern === pattern);
  return rule?.city ?? city ?? null;
}

/** The full company name for an abbreviation at the start of a label ("VW Wolfsburg" → Volkswagen AG). */
export function expandCompany(name: string | null | undefined, rules: AddressRuleRecord[] = BUILT_IN_RULES): string | null {
  const tokens = normalizePattern(name).split(" ").filter(Boolean);
  if (!tokens.length) return name ?? null;
  for (const pattern of [tokens.join(" "), tokens.slice(0, 2).join(" "), tokens[0]]) {
    const rule = rules.find((item) => item.kind === "COMPANY" && item.pattern === pattern);
    if (rule?.company) return rule.company;
  }
  return name ?? null;
}

/**
 * The learned place for a company in a city ("seifert bremen"), most specific first. A rule learned under the bare
 * company name applies in another town only when it names no town itself: a carrier has a site in every city.
 */
export function findSiteRule(companyName: string | null | undefined, city: string | null | undefined, rules: AddressRuleRecord[]): AddressRuleRecord | null {
  const companyPattern = normalizePattern(companyName);
  if (!companyPattern) return null;
  const cityPattern = normalizePattern(expandCity(city, rules));
  const candidates = [cityPattern ? `${companyPattern} ${cityPattern}` : null, companyPattern].filter((value): value is string => Boolean(value));
  for (const pattern of candidates) {
    const rule = rules.find((item) => item.kind === "SITE" && item.pattern === pattern && (item.street || item.latitude !== null));
    if (!rule) continue;
    const ruleCity = normalizePattern(rule.city);
    if (pattern === companyPattern && cityPattern && ruleCity && ruleCity !== cityPattern && !ruleCity.endsWith(` ${cityPattern}`)) continue;
    return rule;
  }
  return null;
}

type StoredAddressRule = Omit<AddressRuleRecord, "kind" | "builtIn"> & { kind: string };

/** A stored rule with the same pattern replaces the built-in one. */
export function mergeAddressRules(stored: StoredAddressRule[]): AddressRuleRecord[] {
  const own = new Set(stored.map((rule) => rule.pattern));
  return [
    ...stored.map((rule) => ({ ...rule, kind: rule.kind as AddressRuleKind, builtIn: false })),
    ...BUILT_IN_RULES.filter((rule) => !own.has(rule.pattern))
  ];
}

/** Stored rules plus the built-in dictionary. */
export class AddressRuleService {
  private cache: { at: number; rules: AddressRuleRecord[] } | null = null;
  constructor(private readonly db: Pick<PrismaClient, "addressRule" | "$transaction">) {}

  async all(): Promise<AddressRuleRecord[]> {
    if (this.cache && Date.now() - this.cache.at < 30_000) return this.cache.rules;
    // An unreachable rules table must not stop an import: the built-in dictionary still applies.
    const stored = await this.db.addressRule.findMany({ orderBy: { pattern: "asc" } }).catch(() => null);
    if (!stored) return BUILT_IN_RULES;
    const rules = mergeAddressRules(stored);
    this.cache = { at: Date.now(), rules };
    return rules;
  }

  list() { return this.db.addressRule.findMany({ orderBy: [{ kind: "asc" }, { pattern: "asc" }] }); }

  /**
   * The dispatcher corrected an imported place ("Seifert, Bremen" → Senator-Bortscheller-Straße 1): remember it,
   * so the next Auftrag with the same company and city is resolved without asking.
   */
  async learn(input: { sourceLabel: string; company: string | null; street: string | null; postalCode: string | null; city: string | null; latitude: number; longitude: number },
    actor?: AuditActor, now = new Date()) {
    const pattern = normalizePattern(input.sourceLabel);
    if (pattern.length < 2) return null;
    const data = { kind: "SITE", company: input.company, street: input.street, postalCode: input.postalCode, city: input.city,
      latitude: input.latitude, longitude: input.longitude };
    const needsTermin = requiresTermin(`${input.company ?? ""} ${input.sourceLabel}`);
    const rule = await this.db.$transaction(async (tx) => {
      // Learning the place again keeps the «Termin нужен» mark the admin set by hand.
      const saved = await tx.addressRule.upsert({ where: { pattern },
        create: { pattern, ...data, requiresTermin: needsTermin, createdByDispatcherId: actor?.dispatcherId ?? null }, update: { ...data, hits: { increment: 1 } } });
      await writeAuditLog(tx, actor, { action: "ADDRESS_RULE_LEARNED", entityType: "AddressRule", entityId: saved.id, metadata: { pattern, city: input.city }, createdAt: now });
      return saved;
    });
    this.cache = null;
    return rule;
  }

  async update(id: string, patch: Partial<Pick<AddressRuleRecord, "company" | "street" | "postalCode" | "city" | "requiresTermin">>, actor?: AuditActor) {
    const rule = await this.db.$transaction(async (tx) => {
      const saved = await tx.addressRule.update({ where: { id }, data: patch });
      await writeAuditLog(tx, actor, { action: "ADDRESS_RULE_UPDATED", entityType: "AddressRule", entityId: id, metadata: { fields: Object.keys(patch) } });
      return saved;
    });
    this.cache = null;
    return rule;
  }

  async remove(id: string, actor?: AuditActor) {
    await this.db.$transaction(async (tx) => {
      const removed = await tx.addressRule.delete({ where: { id } });
      await writeAuditLog(tx, actor, { action: "ADDRESS_RULE_DELETED", entityType: "AddressRule", entityId: id, metadata: { pattern: removed.pattern } });
    });
    this.cache = null;
  }
}

type DraftStopLike = { company: string | null; address: string | null; city?: string | null; appointmentLocal: string | null; appointmentWindowStartLocal?: string | null };

/**
 * Applies the rules to one recognised stop: city codes spelled out, short company names expanded,
 * a learned place filled in, and whether the customer still owes a Termin. The original label is kept
 * for learning when the dispatcher corrects the place.
 */
export function applyRulesToStop<T extends DraftStopLike>(stop: T, rules: AddressRuleRecord[]): T & { sourceLabel: string; terminRequired: boolean; ruleApplied: boolean } {
  const city = expandCity(stop.city ?? null, rules);
  const sourceLabel = [stop.company, city].filter(Boolean).join(" ");
  const site = findSiteRule(stop.company, city, rules);
  const shortCompany = (stop.company ?? "").trim().split(/\s+/).length <= 2;
  const companyName = site?.company ?? (shortCompany ? expandCompany(stop.company, rules) : stop.company);
  const address = site?.street ? [site.street, [site.postalCode, site.city ?? city].filter(Boolean).join(" ")].filter(Boolean).join(", ") : stop.address;
  const hasTermin = Boolean(stop.appointmentLocal || stop.appointmentWindowStartLocal);
  return {
    ...stop,
    company: companyName,
    address,
    city: site?.city ?? city,
    sourceLabel,
    terminRequired: !hasTermin && requiresTermin(`${companyName ?? ""} ${stop.company ?? ""} ${stop.address ?? ""}`, rules),
    ruleApplied: Boolean(site)
  };
}
