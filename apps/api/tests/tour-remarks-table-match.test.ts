import { describe, expect, it, vi } from "vitest";
import { importPdfPreview, sameTownSpelling, splitTourRemarkParts } from "../src/services/pdf-order-import.js";

type Row = { company: string; address: string; city: string; type?: "LOAD" | "UNLOAD" };
const row = (item: Row, index: number) => ({ sequence: index + 1, type: item.type ?? "UNLOAD", company: item.company, address: item.address, city: item.city,
  appointmentLocal: null, referenceNumbers: [], sourcePage: 1, confidence: 0.9 });

async function read(tourRemarks: string, rows: Row[]) {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ output_text: JSON.stringify({
    drafts: [{
      orderNumber: "71123858", vehicleNumber: null, vehiclePlate: "B-CY7446", trailerPlate: "GÖ-FX283",
      departmentCompany: "Schnellecke Transportlogistik GmbH", departmentAddress: "Rudolf-Diesel-Straße 2, 14974 Ludwigsfelde", departmentCity: "Ludwigsfelde", departmentSourcePage: 1,
      tourRemarks, tourRemarksSourcePage: 1, stops: rows.map(row), warnings: []
    }], warnings: []
  }) }), { status: 200 })) as unknown as typeof fetch;
  return (await importPdfPreview(Buffer.from("%PDF-1.7"), "auftrag.pdf", { apiKey: "test-key", fetchImpl })).drafts[0]!;
}

const DAIMLER = { company: "Daimler Buses GmbH", address: "Otto-Renner-Str. 40, D 89231 Neu-Ulm", city: "Neu-Ulm" };
const PESTER = { company: "Pester Pac", address: "Haupstrasse 50, D 87787 Wolfertschwenden", city: "Wolfertschwenden" };
const codes = (draft: { warnings: Array<{ code: string }> }) => draft.warnings.map((warning) => warning.code);

describe("a Tourbemerkung stop finds its row in the Auftrag table (tour 71123858, 11.11.2026)", () => {
  it("'87 Wolfertschwerden' is the row in 87787 Wolfertschwenden: digits are the postcode area, the town is misspelt", async () => {
    const draft = await read("vorladen Lager --> Daimler Neu-Ulm + 87 Wolfertschwerden", [DAIMLER, PESTER]);
    expect(draft.stops.map((stop) => [stop.type, stop.company, stop.address])).toEqual([
      ["LOAD", "Schnellecke Transportlogistik GmbH", "Rudolf-Diesel-Straße 2, 14974 Ludwigsfelde"],
      ["UNLOAD", "Daimler Buses GmbH", "Otto-Renner-Str. 40, D 89231 Neu-Ulm"],
      ["UNLOAD", "Pester Pac", "Haupstrasse 50, D 87787 Wolfertschwenden"]
    ]);
    expect(draft.warnings.find((warning) => warning.code === "TOUR_REMARKS_CITY_SPELLING")?.message)
      .toBe("В Tourbemerkung «Wolfertschwerden» — это Wolfertschwenden: так напечатан адрес в Auftrag.");
    expect(codes(draft)).not.toContain("TOUR_REMARKS_STOP_NOT_FOUND");
    expect(draft.stops.some((stop) => stop.company === "87")).toBe(false);
  });

  it("the row is found when the model keeps the postcode in the city field", async () => {
    const draft = await read("vorladen Lager --> 87 Wolfertschwerden", [{ ...PESTER, city: "D 87787 Wolfertschwenden" }]);
    expect(draft.stops[1]).toMatchObject({ company: "Pester Pac", address: "Haupstrasse 50, D 87787 Wolfertschwenden" });
  });

  it("the digits must be the start of the row's postcode", async () => {
    const draft = await read("vorladen Lager --> 87 Wolfertschwerden", [{ ...PESTER, address: "Haupstrasse 50, D 12345 Wolfertschwenden" }]);
    expect(draft.stops[1]).toMatchObject({ company: null, address: "Wolfertschwerden", city: "Wolfertschwerden", provenance: "PLACEHOLDER" });
    expect(draft.warnings.find((warning) => warning.code === "TOUR_REMARKS_STOP_NOT_FOUND")?.message).toContain("индекс начинается на 87");
  });

  it("a misspelling is not forgiven while a row prints the town as written", async () => {
    const draft = await read("vorladen Lager --> Wolfertschwerden", [PESTER, { company: "Muster GmbH", address: "Dorfstr. 1, 99999 Wolfertschwerden", city: "Wolfertschwerden" }]);
    expect(draft.stops[1]).toMatchObject({ company: "Muster GmbH" });
    expect(codes(draft)).not.toContain("TOUR_REMARKS_CITY_SPELLING");
  });

  it("no row in the table: the stop is placed by the town of the Tourbemerkung, without a made-up company", async () => {
    const draft = await read("vorladen Lager --> Daimler Neu-Ulm + 87 Wolfertschwerden", [DAIMLER]);
    expect(draft.stops[2]).toMatchObject({ company: null, address: "Wolfertschwerden", city: "Wolfertschwerden", provenance: "PLACEHOLDER" });
  });
});

describe("the only row of a town is the place, whatever the company is called", () => {
  const evobus = { company: "EvoBus GmbH", address: "Otto-Renner-Str. 40, 89231 Neu-Ulm", city: "Neu-Ulm" };

  it("'Daimler Neu-Ulm' takes the single Neu-Ulm row and the dispatcher is asked to check the company", async () => {
    const draft = await read("vorladen Lager --> Daimler Neu-Ulm", [evobus]);
    expect(draft.stops[1]).toMatchObject({ company: "EvoBus GmbH", address: "Otto-Renner-Str. 40, 89231 Neu-Ulm", provenance: "TOUR_REMARKS" });
    expect(draft.stops[1]!.confidence).toBeLessThanOrEqual(0.6);
    expect(draft.warnings.find((warning) => warning.code === "TOUR_REMARKS_COMPANY_DIFFERS")?.message)
      .toBe("В Tourbemerkung «Daimler Neu-Ulm», в таблице в Neu-Ulm одна строка — «EvoBus GmbH». Взят её адрес; проверьте фирму.");
  });

  it("two rows in the town and neither names the company: no guess", async () => {
    const draft = await read("vorladen Lager --> Daimler Neu-Ulm", [evobus, { company: "Muster Logistik", address: "Industriestr. 3, 89231 Neu-Ulm", city: "Neu-Ulm" }]);
    expect(draft.stops[1]).toMatchObject({ provenance: "PLACEHOLDER", company: "Daimler" });
    expect(codes(draft)).not.toContain("TOUR_REMARKS_COMPANY_DIFFERS");
  });

  it("'Seifert & BLG Bremen': the BLG row stays with BLG, Seifert does not take it", async () => {
    const draft = await read("vorladen Lager --> Seifert & BLG Bremen", [{ company: "BLG Industrielogistik GmbH & Co. KG", address: "Senator-Mester-Straße 17, 28197 Bremen", city: "Bremen" }]);
    expect(draft.stops.slice(1).map((stop) => [stop.company, stop.provenance])).toEqual([
      ["Seifert", "PLACEHOLDER"], ["BLG Industrielogistik GmbH & Co. KG", "TOUR_REMARKS"]
    ]);
    expect(codes(draft)).not.toContain("TOUR_REMARKS_COMPANY_DIFFERS");
  });
});

describe("parts of a Tourbemerkung", () => {
  it("digits before a town are the postcode area; codes after a place stay references", () => {
    expect(splitTourRemarkParts("Daimler Neu-Ulm + 87 Wolfertschwerden")).toEqual([
      { label: "Daimler Neu-Ulm", references: [], cargo: null },
      { label: "Wolfertschwerden", references: [], cargo: null, postalPrefix: "87" }
    ]);
    expect(splitTourRemarkParts("38239 Salzgitter")[0]).toMatchObject({ label: "Salzgitter", postalPrefix: "38239" });
    expect(splitTourRemarkParts("MB Düsseldorf 477339 070A")).toEqual([{ label: "MB Düsseldorf", references: ["477339", "070A"], cargo: null }]);
    expect(splitTourRemarkParts("477339 MB Düsseldorf")[0]).toMatchObject({ label: "MB Düsseldorf", references: ["477339"] });
  });

  it("a typo is one or two letters in a long name, never in a short one", () => {
    expect(sameTownSpelling("Wolfertschwerden", "Wolfertschwenden")).toBe(true);
    expect(sameTownSpelling("Salzgiter", "Salzgitter")).toBe(true);
    expect(sameTownSpelling("Kassel", "Kasel")).toBe(true);
    expect(sameTownSpelling("Hof", "Hot")).toBe(false);
    expect(sameTownSpelling("Ulm", "Ulm")).toBe(true);
    expect(sameTownSpelling("Halle", "Kalle")).toBe(false);
    expect(sameTownSpelling("Neustadt", "Neuburg")).toBe(false);
    expect(sameTownSpelling("Bremen", "Bremerhaven")).toBe(false);
  });
});
