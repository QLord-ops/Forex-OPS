import type { PdfText } from './pdf-text.js';

/**
 * The model reads an Auftrag; this checks it did not invent the address (owner, 15.11.2026: addresses must be right
 * after reading). For a PDF with a text layer every part of a stop's address — postcode, street, house number, town — must
 * be printed in the document. What is not there was made up or taken from elsewhere, and the dispatcher must look.
 * Stops whose address came from a learned rule, a placeholder or another stop's note are not the model's reading.
 */
export const NOT_IN_DOCUMENT = 'ADDRESS_NOT_IN_DOCUMENT';

type Stop = { address?: string | null; provenance?: string; ruleApplied?: boolean };
type Warning = { code: string; message: string; stopIndex?: number; field?: string };
type Draft = { stops: Stop[]; warnings: Warning[] };

const fold = (value: string) => value.toLowerCase()
  .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
  .normalize('NFKD').replace(/\p{M}/gu, '')
  .replace(/strasse/g, 'str')
  .replace(/[^a-z0-9]+/g, '');

/** The parts of an address the document must print, with the text to show when one is missing. */
export function addressParts(address: string): Array<{ label: string; found: (text: { folded: string; raw: string }) => boolean }> {
  const parts: Array<{ label: string; found: (text: { folded: string; raw: string }) => boolean }> = [];
  const postcodes = address.match(/\b\d{5}\b/g) ?? [];
  for (const code of postcodes) parts.push({ label: code, found: (text) => new RegExp(`(^|\\D)${code}(\\D|$)`).test(text.raw) });
  const head = address.split(',')[0].trim();
  const numbered = /^(.*\D)\s*(\d{1,4}\s*[a-zA-Z]?(?:\s*[-–/]\s*\d{1,4}\s*[a-zA-Z]?)?)\s*$/.exec(head);
  const streetName = (numbered ? numbered[1] : head).replace(/[\s,.-]+$/, '');
  const street = fold(streetName);
  // A street only when it is not the postcode and town the model put first. A bare town ("Bremen", an Abteilung found
  // by its town) has no street to look for.
  if (street.length >= 4 && !/\b\d{5}\b/.test(head) && (numbered || postcodes.length)) {
    parts.push({ label: streetName, found: (text) => text.folded.includes(street) });
    if (numbered) {
      const number = fold(numbered[2]);
      parts.push({ label: `${streetName} ${numbered[2].trim()}`, found: (text) => {
        if (text.folded.includes(street + number)) return true;
        // Tables put the number in its own column: it must follow the street closely.
        let at = text.folded.indexOf(street);
        while (at >= 0) {
          if (text.folded.slice(at + street.length, at + street.length + 40).includes(number)) return true;
          at = text.folded.indexOf(street, at + 1);
        }
        return false;
      } });
    }
  }
  const postcode = postcodes[0];
  const town = postcode ? address.slice(address.indexOf(postcode) + 5).split(',')[0].trim() : '';
  const firstWord = fold(town.split(/[\s/(]/)[0] ?? '');
  if (firstWord.length >= 3) parts.push({ label: town, found: (text) => text.folded.includes(firstWord) });
  return parts;
}

/** Adds a warning on the address of every stop whose address is not printed in the document. */
export function checkAddressesAgainstText<T extends { drafts: Draft[] }>(preview: T, text: PdfText): T {
  const raw = text.pages.join('\n');
  const document = { raw, folded: fold(raw) };
  return { ...preview, drafts: preview.drafts.map((draft) => {
    const warnings = [...draft.warnings];
    draft.stops.forEach((stop, index) => {
      if (!stop.address || stop.ruleApplied || stop.provenance === 'PLACEHOLDER' || stop.provenance === 'OTHER_STOP_NOTE') return;
      if (warnings.some((warning) => warning.code === NOT_IN_DOCUMENT && warning.stopIndex === index)) return;
      const missing = addressParts(stop.address).filter((part) => !part.found(document)).map((part) => part.label);
      if (!missing.length) return;
      warnings.push({ code: NOT_IN_DOCUMENT, stopIndex: index, field: 'address',
        message: `Точка ${index + 1}: в тексте Auftrag нет «${missing.join('», «')}» — адрес мог быть додуман. Проверьте по документу.` });
    });
    return { ...draft, warnings };
  }) };
}
