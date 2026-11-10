/**
 * Short codes customers write instead of a town in Tourbemerkung ("VW SZ", "Audi IN"). The addresses printed in the
 * same Auftrag are the best evidence of what a code means; the dictionary of city codes comes second. A code that
 * neither explains is asked from the dispatcher and remembered.
 */

/** Lower case, ä → ae, ß → ss, everything that is not a letter dropped: "Göttingen" → "goettingen". */
export function foldGerman(value: string | null | undefined): string {
  return (value ?? '').toLocaleLowerCase('de-DE').replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^a-z]/g, '');
}

/** One to four capital letters, as customers write registration-plate codes: "SZ", "WOB", "H". Never "für" or "ES2". */
export function looksLikeCityCode(token: string | null | undefined): boolean {
  return /^\p{Lu}{1,4}$/u.test((token ?? '').trim());
}

function isSubsequence(code: string, name: string): boolean {
  let position = 0;
  for (const letter of code) {
    position = name.indexOf(letter, position);
    if (position < 0) return false;
    position += 1;
  }
  return true;
}

/**
 * "SZ" can stand for Salzgitter: same first letter, the other letters follow in order. Two letters at least —
 * one letter fits half of Germany. "GÖ" fits Göttingen written with ö or oe.
 */
export function isAbbreviationOf(code: string | null | undefined, name: string | null | undefined): boolean {
  const short = foldGerman(code);
  const plain = (code ?? '').toLocaleLowerCase('de-DE').normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^a-z]/g, '');
  const full = foldGerman(name);
  if (plain.length < 2 || full.length <= plain.length) return false;
  return [short, plain].some((form) => form[0] === full[0] && isSubsequence(form, full));
}

export type CityDecoding = { city: string; source: 'ADDRESS' | 'RULE' };

/**
 * What a code means. `candidateCities` are the towns of the address rows of this Auftrag that may belong to the
 * stop; exactly one fitting town decides. Otherwise the dictionary (key in lower case) answers, or nobody does.
 */
export function decodeCityCode(code: string, candidateCities: Array<string | null | undefined>, cityCodes: Record<string, string> = {}): CityDecoding | null {
  if (!looksLikeCityCode(code)) return null;
  const towns = new Map<string, string>();
  for (const city of candidateCities) {
    if (city && isAbbreviationOf(code, city) && !towns.has(foldGerman(city))) towns.set(foldGerman(city), city.trim());
  }
  if (towns.size === 1) return { city: [...towns.values()][0], source: 'ADDRESS' };
  const known = cityCodes[code.trim().toLocaleLowerCase('de-DE')];
  return known ? { city: known, source: 'RULE' } : null;
}
