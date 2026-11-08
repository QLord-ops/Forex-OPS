import { normalizeRouteText, type CustomerEvidence, type ImportCustomerContext, type PdfImportWarning } from './pdf-order-import.js';

export type CustomerCard = ImportCustomerContext['cards'][number];
/** How the customer of an Auftrag was found: picked by the dispatcher, printed in the letterhead or Abteilung, named by the AI, or the truck's line. */
export type CustomerSource = 'SELECTED' | 'DOCUMENT' | 'AI' | 'VEHICLE';
export type DetectedCustomer = { id: string; key: string; name: string; source: CustomerSource; confidence: number };
/** The customer an import preview belongs to. `profileApplied` false: the parse used no customer profile yet. */
export type ImportCustomer = DetectedCustomer & { profileApplied: boolean; detected: DetectedCustomer | null };

const WEIGHT = { DOCUMENT: 0.6, AI: 0.3, VEHICLE: 0.3 } as const;
const EMPTY_EVIDENCE: CustomerEvidence = { documentIssuer: null, customerKey: null, departmentCompanies: [] };

/** Name, key and aliases as whole words: "Walter (Tesla)" → "walter tesla"; shorter than 3 letters never counts. */
function namesOf(card: CustomerCard): string[] {
  return [...new Set([card.name, card.key.replace(/_/g, ' '), ...card.aliases].map(normalizeRouteText).filter((name) => name.length >= 3))];
}

function mentions(text: string, names: string[]): boolean {
  const padded = ` ${normalizeRouteText(text)} `;
  return names.some((name) => padded.includes(` ${name} `));
}

/**
 * Whose Auftrag this is. Only the letterhead, the sender and the Abteilung count as printed evidence — a place on the
 * route never does ("für Tesla Grünheide" in a Schnellecke Auftrag is a stop, not the customer). Evidence adds up;
 * a tie between customers is no answer.
 */
export function detectCustomer(cards: CustomerCard[], evidence: CustomerEvidence = EMPTY_EVIDENCE, vehicleCustomerIds: string[] = []): DetectedCustomer | null {
  const printed = [evidence.documentIssuer, ...evidence.departmentCompanies].filter((text): text is string => Boolean(text?.trim()));
  const scored = cards.map((card) => {
    const names = namesOf(card);
    const document = printed.some((text) => mentions(text, names)) ? WEIGHT.DOCUMENT : 0;
    const ai = evidence.customerKey && evidence.customerKey.trim().toUpperCase() === card.key ? WEIGHT.AI : 0;
    const vehicle = vehicleCustomerIds.includes(card.id) ? WEIGHT.VEHICLE : 0;
    const source: CustomerSource = document ? 'DOCUMENT' : ai ? 'AI' : 'VEHICLE';
    return { card, score: document + ai + vehicle, source };
  }).filter((item) => item.score > 0).sort((left, right) => right.score - left.score);
  const [best, second] = scored;
  if (!best || (second && second.score === best.score)) return null;
  return { id: best.card.id, key: best.card.key, name: best.card.name, source: best.source, confidence: Math.min(0.99, Math.round(best.score * 100) / 100) };
}

/**
 * The customer of the preview and what the dispatcher should know: a chosen customer always wins, but a letterhead of
 * another customer is pointed out; without a choice the detected customer is used (its profile was not applied).
 */
export function resolveImportCustomer(input: {
  cards: CustomerCard[]; selectedId: string | null; evidence?: CustomerEvidence | null; vehicleCustomerIds?: string[];
}): { customer: ImportCustomer | null; warnings: PdfImportWarning[] } {
  const detected = detectCustomer(input.cards, input.evidence ?? EMPTY_EVIDENCE, input.vehicleCustomerIds ?? []);
  const selected = input.selectedId ? input.cards.find((card) => card.id === input.selectedId) ?? null : null;
  if (selected) {
    const mismatch = detected && detected.id !== selected.id && detected.source === 'DOCUMENT';
    return {
      customer: { id: selected.id, key: selected.key, name: selected.name, source: 'SELECTED', confidence: 1, profileApplied: true, detected },
      warnings: mismatch ? [{ code: 'CUSTOMER_MISMATCH', message: `Похоже, это Auftrag заказчика ${detected.name} (по шапке документа), а разобран по профилю ${selected.name}. Выберите ${detected.name}, чтобы разобрать заново по его профилю.` }] : []
    };
  }
  if (detected) return { customer: { ...detected, profileApplied: false, detected }, warnings: [] };
  return {
    customer: null,
    warnings: input.cards.length ? [{ code: 'CUSTOMER_UNKNOWN', message: 'Заказчик не определён. Выберите его, чтобы разобрать Auftrag по профилю заказчика и учить правила именно для него.' }] : []
  };
}

/** "LKW 936", "GÖ-FX 997" → "936", "GOFX997": the same truck however the Auftrag prints it. */
export function vehicleKey(value: string | null | undefined): string {
  return normalizeRouteText(value ?? '').replace(/^lkw\s+/, '').replace(/\s+/g, '').toUpperCase();
}
