import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

export type PdfText = { pages: string[]; chars: number };

const MAX_PAGES = 12;
const MAX_PAGE_CHARS = 12_000;
// Below this the PDF is a scan without a text layer: the model then reads the pages as images.
const MIN_CHARS_PER_PAGE = 80;

type TextItem = { str: string; transform: number[]; width: number; hasEOL?: boolean };

/**
 * The text layer of a generated Auftrag, page by page, with the rows of its tables kept as rows: items on one
 * baseline become one line, a wide gap between items becomes a column break. Null for a scan or a broken file;
 * the caller then sends the pages as images, as before.
 */
export async function extractPdfText(buffer: Buffer): Promise<PdfText | null> {
  try {
    const task = getDocument({ data: new Uint8Array(buffer), disableFontFace: true, useSystemFonts: false, verbosity: 0 });
    const pdf = await task.promise;
    try {
      const pages: string[] = [];
      for (let number = 1; number <= Math.min(pdf.numPages, MAX_PAGES); number += 1) {
        const page = await pdf.getPage(number);
        const content = await page.getTextContent();
        pages.push(linesOf((content.items as Array<Partial<TextItem>>).filter((item): item is TextItem => typeof item.str === "string" && Array.isArray(item.transform))).slice(0, MAX_PAGE_CHARS));
      }
      const chars = pages.reduce((sum, page) => sum + page.replace(/\s+/g, "").length, 0);
      return { pages, chars };
    } finally {
      await task.destroy();
    }
  } catch {
    return null;
  }
}

/** Enough text to read the Auftrag from it rather than from the pages as images. */
export function hasTextLayer(text: PdfText | null): text is PdfText {
  return Boolean(text && text.pages.length && text.chars >= MIN_CHARS_PER_PAGE * text.pages.length);
}

/** The pages as the model sees them: numbered blocks, so sourcePage keeps its meaning. */
export function pagesAsText(text: PdfText): string {
  return text.pages.map((page, index) => `[Seite ${index + 1}]\n${page}`).join("\n\n");
}

function linesOf(items: TextItem[]): string {
  const placed = items
    .filter((item) => item.str.trim() || item.hasEOL)
    .map((item) => ({ text: item.str, x: item.transform[4], y: item.transform[5], width: item.width, size: Math.abs(item.transform[0]) || Math.abs(item.transform[3]) || 10 }));
  // Same baseline (within a third of the font size) = same row; rows from the top of the page down, items left to right.
  const rows: Array<{ y: number; items: typeof placed }> = [];
  for (const item of placed.sort((left, right) => right.y - left.y || left.x - right.x)) {
    const row = rows.find((candidate) => Math.abs(candidate.y - item.y) <= item.size / 3);
    if (row) row.items.push(item); else rows.push({ y: item.y, items: [item] });
  }
  return rows.map((row) => {
    let line = "";
    let end: number | null = null;
    for (const item of row.items.sort((left, right) => left.x - right.x)) {
      if (end !== null) {
        const gap = item.x - end;
        // A gap of more than a wide character is a column (table cell) break, kept as three spaces.
        line += gap > item.size * 1.2 ? "   " : gap > item.size * 0.1 || /\s$/.test(line) || /^\s/.test(item.text) ? " " : "";
      }
      line += item.text.trim();
      end = item.x + item.width;
    }
    return line.replace(/\s+$/, "");
  }).filter(Boolean).join("\n");
}
