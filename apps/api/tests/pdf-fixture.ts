/**
 * A small real PDF with a text layer, built by hand for tests: each page is a list of lines, each line a list of
 * cells printed at given x positions (PDF points, from the left) on one baseline. No fonts are embedded (Helvetica
 * is a standard font), so pdf.js reads the text back exactly.
 */
export type FixturePage = Array<{ y: number; cells: Array<{ x: number; text: string }> }>;

function escapePdfText(text: string) {
  return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

export function buildTextPdf(pages: FixturePage[]): Buffer {
  const objects: string[] = [];
  const add = (body: string) => { objects.push(body); return objects.length; };
  const fontId = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const pagesId = objects.length + 1 + pages.length * 2;
  const pageIds: number[] = [];
  for (const page of pages) {
    const stream = page.map((line) => line.cells.map((cell) => `BT /F1 10 Tf ${cell.x} ${line.y} Td (${escapePdfText(cell.text)}) Tj ET`).join("\n")).join("\n");
    const contentId = add(`<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`);
    pageIds.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`));
  }
  const realPagesId = add(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`);
  if (realPagesId !== pagesId) throw new Error("pdf fixture: page tree id mismatch");
  const catalogId = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);

  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, "latin1"));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body, "latin1");
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

/** One page like an mRoad Deckblatt printed from the browser: each value sits a little below its label. */
export function deckblattPdf(): Buffer {
  return buildTextPdf([[
    { y: 800, cells: [{ x: 40, text: "12.11.26, 13:10" }, { x: 250, text: "mRoad - mobile ROuting And Delivery" }] },
    { y: 760, cells: [{ x: 60, text: "Deckblatt zur Warenanlieferung" }] },
    { y: 730, cells: [{ x: 60, text: "Werk" }, { x: 300, text: "Spediteur: 17848466" }] },
    { y: 712, cells: [{ x: 62, text: "065, Düsseldorf" }, { x: 300, text: "Name: Schnellecke Transportlogistik" }] },
    { y: 690, cells: [{ x: 60, text: "Borderonummer" }] },
    { y: 672, cells: [{ x: 62, text: "15015236" }] },
    { y: 640, cells: [{ x: 60, text: "Anlieferdatum" }, { x: 160, text: "LKW-Kennzeichen" }, { x: 290, text: "Fabrikat" }, { x: 400, text: "Von:" }, { x: 430, text: "12:00" }, { x: 480, text: "Bis:" }] },
    { y: 626, cells: [{ x: 62, text: "13.11.2026" }, { x: 162, text: "B-CY3010" }, { x: 292, text: "Mercedes Benz" }, { x: 505, text: "12:30" }] },
    { y: 600, cells: [{ x: 60, text: "Leergutaufnahme (Leergutplatz)" }, { x: 250, text: "Ja" }, { x: 280, text: "Nein" }] },
    { y: 560, cells: [{ x: 60, text: "Fahrzeugtyp" }] },
    { y: 540, cells: [{ x: 60, text: "Megatrailer" }, { x: 200, text: "(1)" }, { x: 300, text: "Sattelauflieger" }, { x: 440, text: "(4)" }] }
  ]]);
}

/** Two pages like a generated Auftrag: letterhead, Tourbemerkung and a stop table with columns. */
export function auftragPdf(): Buffer {
  return buildTextPdf([
    [
      { y: 800, cells: [{ x: 50, text: "Schnellecke Transportlogistik GmbH" }] },
      { y: 780, cells: [{ x: 50, text: "Transportauftrag Nr. 20566316" }, { x: 400, text: "LKW B-CY2868" }] },
      { y: 740, cells: [{ x: 50, text: "Tourbemerkung: Zwickau fuer MB Duesseldorf" }] },
      { y: 700, cells: [{ x: 50, text: "Pos" }, { x: 100, text: "Ladestelle" }, { x: 300, text: "Datum" }, { x: 420, text: "LDM" }] },
      { y: 684, cells: [{ x: 50, text: "1" }, { x: 100, text: "Werk Zwickau, Audistr. 1, 08058 Zwickau" }, { x: 300, text: "10.11.2026 06:00" }, { x: 420, text: "13,6" }] }
    ],
    [
      { y: 800, cells: [{ x: 50, text: "Entladestelle" }] },
      { y: 784, cells: [{ x: 50, text: "Mercedes-Benz AG Werk Duesseldorf, Rather Str. 51, 40476 Duesseldorf" }] }
    ]
  ]);
}
