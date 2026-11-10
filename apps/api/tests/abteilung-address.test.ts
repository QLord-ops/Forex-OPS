import { describe, expect, it, vi } from "vitest";
import { importPdfPreview, isForeignToDepartment } from "../src/services/pdf-order-import.js";

const clarios = { sequence: 2, type: "LOAD", company: "Clarios Zwickau GmbH & Co. KG", address: "Reichenbacher Straße 89, 08056 Zwickau", city: "Zwickau", appointmentLocal: null, sourcePage: 1, confidence: 0.9 };
const sese = { sequence: 3, type: "UNLOAD", company: "SESE Heilbronn SEAT Recambios (49)", address: "Dieselstraße 12, 74076 Heilbronn", city: "Heilbronn", appointmentLocal: null, sourcePage: 1, confidence: 0.9 };

async function read(department: Record<string, unknown>, extraStops: unknown[] = []) {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ output_text: JSON.stringify({
    drafts: [{
      orderNumber: "20566480", vehicleNumber: null, vehiclePlate: null, trailerPlate: null,
      departmentCompany: "Schnellecke Transportlogistik GmbH", departmentCity: "Zwickau", departmentSourcePage: 1, ...department,
      tourRemarks: "vorladen/Lager + Clarios Zwickau für SESE Heilbronn", tourRemarksSourcePage: 1,
      stops: [...extraStops, clarios, sese], warnings: []
    }], warnings: []
  }) }), { status: 200 })) as unknown as typeof fetch;
  const result = await importPdfPreview(Buffer.from("%PDF-1.7"), "auftrag.pdf", { apiKey: "test-key", fetchImpl });
  return { draft: result.drafts[0]!, fetchImpl };
}

describe("Abteilung warehouse address (tour 20566480, 10.11.2026)", () => {
  it("the fleet's own yard is never the warehouse: Mühlenweg 78 under Abteilung Zwickau is dropped", async () => {
    const { draft } = await read({ departmentAddress: "Mühlenweg 78" });
    expect(draft.stops[0]).toMatchObject({ type: "LOAD", company: "Schnellecke Transportlogistik GmbH", address: "Zwickau", city: "Zwickau" });
    expect(draft.warnings.find((warning) => warning.code === "DEPARTMENT_ADDRESS_NOT_FOUND")?.message)
      .toBe("У Abteilung Zwickau в Auftrag нет своей улицы — напечатан адрес перевозчика, он не использован. Склад ищется как «Schnellecke Transportlogistik GmbH» в Zwickau; проверьте загрузку.");
    expect(draft.stops.map((stop) => stop.city)).toEqual(["Zwickau", "Zwickau", "Heilbronn"]);
  });

  it("the carrier address named by the model, and a row for 'Lager' that carries it, are dropped too", async () => {
    const lager = { sequence: 1, type: "LOAD", company: "Lager", address: "Hauptstr. 5, 99999 Anderswo", city: "Zwickau", appointmentLocal: null, sourcePage: 1, confidence: 0.6 };
    const { draft } = await read({ departmentAddress: "Hauptstraße 5", carrierAddress: "Spedition Beispiel, Hauptstraße 5, 99999 Anderswo" }, [lager]);
    expect(draft.stops[0]).toMatchObject({ address: "Zwickau", city: "Zwickau", company: "Schnellecke Transportlogistik GmbH" });
  });

  it("an address printed with another town is not the warehouse of this Abteilung", async () => {
    const { draft } = await read({ departmentAddress: "Industrieweg 9, D 38112 Braunschweig" });
    expect(draft.stops[0]).toMatchObject({ address: "Zwickau", city: "Zwickau" });
    expect(draft.warnings.some((warning) => warning.code === "DEPARTMENT_ADDRESS_NOT_FOUND")).toBe(true);
  });

  it("no street under Abteilung: the company is looked up in its town and the dispatcher is told", async () => {
    const { draft } = await read({ departmentAddress: null });
    expect(draft.stops[0]).toMatchObject({ address: "Zwickau", city: "Zwickau", provenance: "DEPARTMENT" });
    expect(draft.warnings.find((warning) => warning.code === "DEPARTMENT_ADDRESS_NOT_FOUND")?.message)
      .toBe("У Abteilung Zwickau в Auftrag нет улицы. Склад ищется как «Schnellecke Transportlogistik GmbH» в Zwickau; проверьте загрузку.");
  });

  it("the warehouse's own address stays as printed", async () => {
    const { draft, fetchImpl } = await read({ departmentAddress: "Büttenstraße 4, 08058 Zwickau" });
    expect(draft.stops[0]).toMatchObject({ address: "Büttenstraße 4, 08058 Zwickau", city: "Zwickau" });
    expect(draft.warnings.some((warning) => warning.code === "DEPARTMENT_ADDRESS_NOT_FOUND")).toBe(false);
    const body = JSON.stringify(JSON.parse(String((fetchImpl as unknown as { mock: { calls: Array<[unknown, { body: string }]> } }).mock.calls[0]![1].body)));
    expect(body).toContain("carrierAddress");
    expect(body).toContain("never the Abteilung");
  });

  it("compares streets, not towns", () => {
    expect(isForeignToDepartment("Mühlenweg 78", "Zwickau")).toBe(true);
    expect(isForeignToDepartment("Mühlenweg 78, D-37120 Bovenden", "Bovenden")).toBe(true);
    expect(isForeignToDepartment("Mühlenweg 7", "Zwickau")).toBe(false);
    expect(isForeignToDepartment("Rudolf-Diesel-Straße 2 D 14974 Ludwigsfelde, 14974 D 14974 Ludwigsfelde", "Ludwigsfelde")).toBe(false);
    expect(isForeignToDepartment("Büttenstr. 4, 08058 Zwickau-Pölbitz", "D 08058 Zwickau")).toBe(false);
    expect(isForeignToDepartment("Hauptstr. 5", "Zwickau", "Hauptstraße 5, 99999 Anderswo")).toBe(true);
  });
});
