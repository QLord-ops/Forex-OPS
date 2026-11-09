import { describe, expect, it } from "vitest";
import { extractPdfText, hasTextLayer, pagesAsText } from "../src/services/pdf-text.js";
import { auftragPdf, buildTextPdf } from "./pdf-fixture.js";

describe("the text layer of a PDF Auftrag", () => {
  it("reads the pages as rows, keeps table columns apart and numbers the pages", async () => {
    const text = await extractPdfText(auftragPdf());
    expect(text).not.toBeNull();
    expect(text!.pages).toHaveLength(2);
    const [first, second] = text!.pages;
    expect(first.split("\n")[0]).toBe("Schnellecke Transportlogistik GmbH");
    expect(first).toContain("Transportauftrag Nr. 20566316   LKW B-CY2868");
    expect(first).toContain("Tourbemerkung: Zwickau fuer MB Duesseldorf");
    // One table row stays one line, its cells three spaces apart.
    expect(first).toContain("1   Werk Zwickau, Audistr. 1, 08058 Zwickau   10.11.2026 06:00   13,6");
    expect(second).toContain("Mercedes-Benz AG Werk Duesseldorf");
    expect(hasTextLayer(text)).toBe(true);
    expect(pagesAsText(text!)).toMatch(/^\[Seite 1\]\n[\s\S]*\n\n\[Seite 2\]\nEntladestelle/);
  });

  it("treats a scan or a broken file as having no text layer", async () => {
    expect(await extractPdfText(Buffer.from("%PDF-1.7 not really a pdf"))).toBeNull();
    const scan = await extractPdfText(buildTextPdf([[{ y: 800, cells: [{ x: 50, text: "Nr. 1" }] }], []]));
    expect(scan).not.toBeNull();
    expect(hasTextLayer(scan)).toBe(false);
    expect(hasTextLayer(null)).toBe(false);
  });
});
