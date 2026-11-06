import { describe, expect, it, vi } from "vitest";
import { compactAddress, importImagePreview, importPdfPreview, parseTourRemarksRoute, tourRemarksZuladung } from "../src/services/pdf-order-import.js";

describe("PDF Auftrag import", () => {
  it("sends the PDF as an OpenAI file input and validates the structured preview", async () => {
    const fetchMock = vi.fn(async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      return new Response(
        JSON.stringify({
          output_text: JSON.stringify({
            drafts: [
              {
                orderNumber: "PDF-4711",
                vehicleNumber: "LKW 936",
                vehiclePlate: "B-CY7490",
                trailerPlate: "Z-S3153",
                tourRemarks: "Werk Berlin für Hafen Hamburg // Fixtermin 13:30 Uhr",
                tourRemarksSourcePage: 1,
                stops: [
                  {
                    sequence: 1,
                    type: "LOAD",
                    company: "Werk Berlin",
                    address: "Alexanderplatz 1, 10178 Berlin, Deutschland",
                    city: "Berlin",
                    appointmentLocal: "2026-10-12T08:30",
                    appointmentWindowStartLocal: null,
                    appointmentWindowEndLocal: null,
                    loadingMeters: 13.6,
                    referenceNumbers: ["L-4711"],
                    instructions: "Tor 4, Anmeldung beim Pförtner",
                    sourcePage: 1,
                    sourceExcerpt: "Alexanderplatz 1, 10178 Berlin",
                    confidence: 0.96
                  },
                  {
                    sequence: 2,
                    type: "UNLOAD",
                    company: "Hafen Hamburg",
                    address: "Am Sandtorkai 1, 20457 Hamburg, Deutschland",
                    city: "Hamburg",
                    appointmentLocal: null,
                    appointmentWindowStartLocal: "2026-10-13T11:00",
                    appointmentWindowEndLocal: "2026-10-13T15:00",
                    loadingMeters: null,
                    referenceNumbers: ["E-99"],
                    instructions: null,
                    sourcePage: 2,
                    sourceExcerpt: "Am Sandtorkai 1, 20457 Hamburg",
                    confidence: 0.91
                  }
                ],
                warnings: []
              }
            ],
            warnings: []
          })
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });

    const result = await importPdfPreview(Buffer.from("%PDF-1.7\nauftrag"), "auftrag.pdf", {
      apiKey: "test-key",
      model: "gpt-test",
      fetchImpl: fetchMock as unknown as typeof fetch
    });

    expect(result).toMatchObject({
      source: "OPENAI",
      detectedLayout: "PDF",
      aiAvailable: true,
      usedAi: true,
      drafts: [
        {
          orderNumber: "PDF-4711",
          vehicleNumber: "LKW 936",
          vehiclePlate: "B-CY7490",
          trailerPlate: "Z-S3153",
          tourRemarksSourcePage: 1,
          stops: [
            { type: "LOAD", sourcePage: 1, loadingMeters: 13.6, referenceNumbers: ["L-4711"], instructions: "Tor 4, Anmeldung beim Pförtner" },
            { type: "UNLOAD", sourcePage: 2, appointmentLocal: null, appointmentWindowStartLocal: "2026-10-13T11:00", referenceNumbers: ["E-99"] }
          ]
        }
      ]
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as {
      model: string;
      store: boolean;
      input: Array<{ role: string; content: unknown }>;
      text: { format: { type: string; strict: boolean } };
    };
    const userMessage = body.input.find((item) => item.role === "user");
    expect(body).toMatchObject({
      model: "gpt-test",
      store: false,
      text: { format: { type: "json_schema", strict: true } }
    });
    expect(userMessage?.content).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "input_file",
        filename: "auftrag.pdf",
        file_data: expect.stringMatching(/^data:application\/pdf;base64,/),
        detail: "high"
      }),
      expect.objectContaining({ type: "input_text", text: expect.stringContaining("loadingMeters") })
    ]));
    const instruction = (userMessage?.content as Array<{ type: string; text?: string }>).find((item) => item.type === "input_text")?.text;
    expect(instruction).toContain("FIRST locate and read Tourbemerkung");
    expect(instruction).toContain("SECOND find those same locations");
    expect(instruction).toContain("every location before the first 'für' (or an arrow");
    expect(instruction).toContain("Hydro Crimmitschau + Voestalpine Schmölln für VW Braunschweig");
    expect(instruction).toContain("vorladen/Lager");
    expect(instruction).toContain("departmentAddress");
    expect(instruction).toContain("NOT adjacent RM or LMJ");
    expect(instruction).toContain("above Abteilung");
    expect(body.text.format).toMatchObject({
      schema: {
        properties: {
          drafts: {
            items: {
              required: expect.arrayContaining(["vehiclePlate", "trailerPlate", "departmentAddress", "departmentCity", "tourRemarks", "tourRemarksSourcePage"]),
              properties: {
                stops: {
                  items: {
                    required: expect.arrayContaining(["appointmentWindowStartLocal", "appointmentWindowEndLocal", "sourceExcerpt"])
                  }
                }
              }
            }
          }
        }
      }
    });
  });

  it("treats plus before für as additional loading stops and the destination after für as unloading", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ output_text: JSON.stringify({
      drafts: [{
        orderNumber: "20564735", vehicleNumber: null, vehiclePlate: "GÖ-FX321", trailerPlate: "Z-S3280",
        tourRemarks: "Hydro Crimmitschau + Voestalpine Schmölln für VW Braunschweig", tourRemarksSourcePage: 1,
        stops: [
          { sequence: 1, type: "LOAD", company: "Hydro", address: "Gewerbering 26a, 08451 Crimmitschau", city: "Crimmitschau", appointmentLocal: null, sourcePage: 1, confidence: 0.9 },
          { sequence: 2, type: "UNLOAD", company: "Voestalpine", address: "Zum Wasserturm 79/2, 04626 Schmölln", city: "Schmölln", appointmentLocal: null, sourcePage: 2, confidence: 0.8 },
          { sequence: 3, type: "UNLOAD", company: "VW", address: "Gifhorner Straße 180, 38112 Braunschweig", city: "Braunschweig", appointmentLocal: null, sourcePage: 4, confidence: 0.9 }
        ], warnings: []
      }], warnings: []
    }) }), { status: 200 })) as unknown as typeof fetch;

    const result = await importPdfPreview(Buffer.from("%PDF-1.7"), "auftrag.pdf", { apiKey: "test-key", fetchImpl });

    expect(result.drafts[0].stops).toMatchObject([
      { sequence: 1, type: "LOAD", city: "Crimmitschau" },
      { sequence: 2, type: "LOAD", city: "Schmölln" },
      { sequence: 3, type: "UNLOAD", city: "Braunschweig" }
    ]);
    expect(result.drafts[0].warnings).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "TOUR_REMARKS_ROUTE_MISMATCH" })
    ]));
  });

  it("keeps only Tourbemerkung cities and collapses repeated rows into one stop", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ output_text: JSON.stringify({
      drafts: [{
        orderNumber: "20564735", vehicleNumber: null, vehiclePlate: "GÖ-FX321", trailerPlate: null,
        tourRemarks: "Hydro Crimmitschau + Voestalpine Schmölln für VW Braunschweig", tourRemarksSourcePage: 1,
        stops: [
          { sequence: 1, type: "LOAD", company: "Hydro", address: "Gewerbering 26a, 08451 Crimmitschau", city: "Crimmitschau", appointmentLocal: null, referenceNumbers: ["H-1"], sourcePage: 1, confidence: 0.9 },
          { sequence: 2, type: "UNLOAD", company: "Voestalpine", address: "Zum Wasserturm 79/2, 04626 Schmölln", city: "Schmölln", appointmentLocal: null, referenceNumbers: ["V-1"], sourcePage: 2, confidence: 0.8 },
          { sequence: 3, type: "UNLOAD", company: "VW", address: "Gifhorner Straße 180, 38112 Braunschweig", city: "Braunschweig", appointmentLocal: null, referenceNumbers: ["B-1"], sourcePage: 4, confidence: 0.9 },
          { sequence: 4, type: "UNLOAD", company: "VW duplicate", address: "Gifhorner Straße 180, 38112 Braunschweig", city: "Braunschweig", appointmentLocal: null, referenceNumbers: ["B-2"], sourcePage: 5, confidence: 0.7 },
          { sequence: 5, type: "UNLOAD", company: "VW Logistikzentrum", address: "Harvesser Kamp 1, 38176 Wendeburg", city: "Wendeburg", appointmentLocal: null, referenceNumbers: ["W-1"], sourcePage: 6, confidence: 0.95 }
        ], warnings: []
      }], warnings: []
    }) }), { status: 200 })) as unknown as typeof fetch;

    const result = await importPdfPreview(Buffer.from("%PDF-1.7"), "auftrag.pdf", { apiKey: "test-key", fetchImpl });
    expect(result.drafts[0].stops).toHaveLength(3);
    expect(result.drafts[0].stops).toMatchObject([
      { sequence: 1, type: "LOAD", city: "Crimmitschau" },
      { sequence: 2, type: "LOAD", city: "Schmölln" },
      { sequence: 3, type: "UNLOAD", city: "Braunschweig", referenceNumbers: ["B-1", "B-2"] }
    ]);
    expect(result.drafts[0].stops.some((stop) => stop.city === "Wendeburg")).toBe(false);
  });

  it("reads an arrow route with '&': one stop per company and city, 00:00h as a planned day (Schnellecke tour, 04.11.2026)", async () => {
    const row = (company: string, address: string, city: string, lm: number, ref: string) =>
      ({ sequence: 1, type: "UNLOAD", company, address, city, appointmentLocal: "2026-11-05T00:00", loadingMeters: lm, referenceNumbers: [ref], sourcePage: 1, confidence: 0.9 });
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ output_text: JSON.stringify({
      drafts: [{
        orderNumber: "71123515", vehicleNumber: null, vehiclePlate: "B-CY3786", trailerPlate: "GÖ-FX271",
        departmentCompany: "Schnellecke Transportlogistik GmbH", departmentAddress: "Rudolf-Diesel-Straße 2, 14974 Ludwigsfelde", departmentCity: "Ludwigsfelde", departmentSourcePage: 1,
        tourRemarks: "vorladen Lager --> TST Hamburg + Seifert & BLG Bremen", tourRemarksSourcePage: 1,
        stops: [
          row("BLG Industrielogistik GmbH & Co. KG", "Senator-Mester-Straße 17, 28197 Bremen", "Bremen", 0.4, "710685764"),
          row("Mercedes-Benz AG / Werk 067", "Mercedesstraße 1, 28309 Bremen", "Bremen", 0.5, "710685172"),
          row("BLG Industrielogistik GmbH & Co. KG", "Senator-Apelt-Straße 90, 28197 Bremen", "Bremen", 0.17, "710685395"),
          row("BLG Industrielogistik GmbH & Co. KG", "Senator-Apelt-Straße 90, 28197 Bremen", "Bremen", 0.25, "710685550"),
          row("Mercedes-Benz AG / Werk 067", "Bordeauxstrasse 10, 28309 Bremen", "Bremen", 1.5, "710685401"),
          row("TST Süderelbe GmbH", "Dradenauer Deichweg 3, 21129 Hamburg", "Hamburg", 2.75, "710685596")
        ], warnings: []
      }], warnings: []
    }) }), { status: 200 })) as unknown as typeof fetch;

    const result = await importPdfPreview(Buffer.from("%PDF-1.7"), "transportauftrag.pdf", { apiKey: "test-key", fetchImpl, now: new Date("2026-11-04T08:00:00Z") });
    const stops = result.drafts[0].stops;
    expect(stops.map((stop) => [stop.type, stop.company, stop.city])).toEqual([
      ["LOAD", "Schnellecke Transportlogistik GmbH", "Ludwigsfelde"],
      ["UNLOAD", "TST Süderelbe GmbH", "Hamburg"],
      ["UNLOAD", "Seifert", "Bremen"],
      ["UNLOAD", "BLG Industrielogistik GmbH & Co. KG", "Bremen"]
    ]);
    // The three BLG rows are one stop with all their shipment numbers.
    expect(stops[3].referenceNumbers).toEqual(expect.arrayContaining(["710685764", "710685395", "710685550"]));
    expect(stops[3].loadingMeters).toBeCloseTo(0.82);
    // 00:00h is that day, planned at 06:00 — not a Termin.
    expect(stops[3]).toMatchObject({ appointmentLocal: null, appointmentWindowStartLocal: null, plannedLocal: "2026-11-05T06:00" });
    const codes = result.drafts[0].warnings.map((warning) => warning.code);
    expect(codes).toContain("TABLE_STOPS_NOT_IN_TOUR_REMARKS");
    expect(result.drafts[0].warnings.find((warning) => warning.code === "TABLE_STOPS_NOT_IN_TOUR_REMARKS")?.message).toContain("Mercedes-Benz AG / Werk 067");
  });

  it("reads 'Lager' as the Abteilung warehouse on the unloading side too, never as a town", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ output_text: JSON.stringify({
      drafts: [{
        orderNumber: "20565720", vehicleNumber: null, vehiclePlate: "GÖ-FX952", trailerPlate: "GÖ-FX671",
        departmentCompany: "Schnellecke Transportlogistik GmbH", departmentAddress: "Büttenstraße 4, 08058 Zwickau", departmentCity: "Zwickau", departmentSourcePage: 1,
        tourRemarks: "Vollmann Scheibenberg für VW Kassel + Lager", tourRemarksSourcePage: 1,
        stops: [
          { sequence: 1, type: "LOAD", company: "Vollmann (Sachsen) GmbH & Co. KG", address: "Elterleiner Str. 4, 09481 Scheibenberg", city: "Scheibenberg", appointmentLocal: null, referenceNumbers: ["23295302"], sourcePage: 1, confidence: 0.9 },
          { sequence: 2, type: "UNLOAD", company: "Volkswagen AG", address: "Dr.-Rudolf-Leiding-Platz 1, 34225 Baunatal", city: "Kassel", appointmentLocal: null, sourcePage: 1, confidence: 0.8 },
          { sequence: 3, type: "UNLOAD", company: "Lager", address: "Lager", city: "Lager", appointmentLocal: null, sourcePage: 1, confidence: 0.5 }
        ], warnings: []
      }], warnings: []
    }) }), { status: 200 })) as unknown as typeof fetch;

    const result = await importPdfPreview(Buffer.from("%PDF-1.7"), "auftrag.pdf", { apiKey: "test-key", fetchImpl });
    const stops = result.drafts[0].stops;
    expect(stops.map((stop) => [stop.type, stop.city])).toEqual([["LOAD", "Scheibenberg"], ["UNLOAD", "Kassel"], ["UNLOAD", "Zwickau"]]);
    expect(stops[2]).toMatchObject({ company: "Schnellecke Transportlogistik GmbH", address: "Büttenstraße 4, 08058 Zwickau" });
    expect(stops.some((stop) => stop.city === "Lager")).toBe(false);
  });

  it("reads 'divers' like 'Lager': the Abteilung address, on loading and unloading", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ output_text: JSON.stringify({
      drafts: [{
        orderNumber: "DIV-1", vehicleNumber: null, vehiclePlate: null, trailerPlate: null,
        departmentCompany: "Schnellecke Transportlogistik GmbH", departmentAddress: "Rudolf-Diesel-Straße 2, 14974 Ludwigsfelde", departmentCity: "Ludwigsfelde", departmentSourcePage: 1,
        tourRemarks: "divers für TST Hamburg + divers", tourRemarksSourcePage: 1,
        stops: [
          { sequence: 1, type: "UNLOAD", company: "TST Süderelbe GmbH", address: "Dradenauer Deichweg 3, 21129 Hamburg", city: "Hamburg", appointmentLocal: null, sourcePage: 1, confidence: 0.9 }
        ], warnings: []
      }], warnings: []
    }) }), { status: 200 })) as unknown as typeof fetch;
    const result = await importPdfPreview(Buffer.from("%PDF-1.7"), "auftrag.pdf", { apiKey: "test-key", fetchImpl });
    expect(result.drafts[0].stops.map((stop) => [stop.type, stop.address])).toEqual([
      ["LOAD", "Rudolf-Diesel-Straße 2, 14974 Ludwigsfelde"],
      ["UNLOAD", "Dradenauer Deichweg 3, 21129 Hamburg"],
      ["UNLOAD", "Rudolf-Diesel-Straße 2, 14974 Ludwigsfelde"]
    ]);
  });

  it("treats 'evt. Zuladung' as a note, not a stop, and recovers the receiver from the loading note (LKW 321, 06.11.2026)", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ output_text: JSON.stringify({
      drafts: [{
        orderNumber: "20565801", vehicleNumber: null, vehiclePlate: "GÖ-FX321", trailerPlate: null,
        departmentCompany: null, departmentAddress: null, departmentCity: null, departmentSourcePage: null,
        tourRemarks: "Borken für Königswalde + evt. Zuladung", tourRemarksSourcePage: 1,
        stops: [
          { sequence: 1, type: "LOAD", company: "Zenda Dienstleistungen GmbH", address: "Industriestraße 12, 46325 Borken", city: "Borken", appointmentDateLocal: "2026-11-06",
            instructions: "Direktlieferung an Handtmann Leichtmetallgießerei Annaberg GmbH, Arno-Schmidt-Straße 5, 09456 Königswalde", sourcePage: 1, confidence: 0.9 },
          { sequence: 2, type: "UNLOAD", company: "Zuladung", address: "evt. Zuladung", city: null, sourcePage: 1, confidence: 0.4 }
        ], warnings: []
      }], warnings: []
    }) }), { status: 200 })) as unknown as typeof fetch;

    const result = await importPdfPreview(Buffer.from("%PDF-1.7"), "auftrag.pdf", { apiKey: "test-key", fetchImpl, now: new Date("2026-11-06T08:00:00Z") });
    const draft = result.drafts[0];
    expect(draft.stops.map((stop) => [stop.type, stop.company, stop.address])).toEqual([
      ["LOAD", "Zenda Dienstleistungen GmbH", "Industriestraße 12, 46325 Borken"],
      ["UNLOAD", "Handtmann Leichtmetallgießerei Annaberg GmbH", "Arno-Schmidt-Straße 5, 09456 Königswalde"]
    ]);
    const codes = draft.warnings.map((warning) => warning.code);
    expect(codes).toContain("ZULADUNG_POSSIBLE");
    expect(codes).toContain("TOUR_REMARKS_STOP_FROM_NOTES");
    expect(codes).not.toContain("TOUR_REMARKS_STOP_NOT_FOUND");
    expect(draft.tourRemarks).toBe("Borken für Königswalde + evt. Zuladung");
  });

  it("finds Zuladung written outside the route and keeps it on the tour", async () => {
    expect(parseTourRemarksRoute("Hydro Crimmitschau für VW Emden, Zuladung möglich")?.map((stop) => stop.label)).toEqual(["Hydro Crimmitschau", "VW Emden"]);
    expect(tourRemarksZuladung("Borken für Königswalde + evtl. Zuladung in Kassel")).toEqual({ mentioned: true, place: "Kassel" });
    expect(tourRemarksZuladung("Borken für Königswalde")).toEqual({ mentioned: false, place: null });

    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ output_text: JSON.stringify({
      drafts: [{
        orderNumber: "Z-2", vehicleNumber: null, vehiclePlate: null, trailerPlate: null,
        tourRemarks: "Werk Berlin für Hafen Hamburg", tourRemarksSourcePage: 1,
        stops: [
          { sequence: 1, type: "LOAD", company: "Werk Berlin", address: "Alexanderplatz 1, 10178 Berlin", city: "Berlin", sourcePage: 1, confidence: 0.9 },
          { sequence: 2, type: "UNLOAD", company: "Hafen Hamburg", address: "Am Sandtorkai 1, 20457 Hamburg", city: "Hamburg", instructions: "Zuladung möglich", sourcePage: 1, confidence: 0.9 }
        ], warnings: []
      }], warnings: []
    }) }), { status: 200 })) as unknown as typeof fetch;
    const result = await importPdfPreview(Buffer.from("%PDF-1.7"), "auftrag.pdf", { apiKey: "test-key", fetchImpl });
    expect(result.drafts[0].stops).toHaveLength(2);
    expect(result.drafts[0].tourRemarks).toBe("Werk Berlin für Hafen Hamburg\nZuladung möglich");
    expect(result.drafts[0].warnings.map((warning) => warning.code)).toContain("ZULADUNG_POSSIBLE");
  });

  it("reads 'MB Düsseldorf 477339 070A & 070D LG --> Lager': MB is Mercedes-Benz, codes are references, LG is the cargo (Schnellecke 71123727, 06.11.2026)", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ output_text: JSON.stringify({
      drafts: [{
        orderNumber: "71123727", vehicleNumber: null, vehiclePlate: "B-CY3010", trailerPlate: "Z-S3241",
        departmentCompany: "Schnellecke Transportlogistik GmbH", departmentAddress: "Rudolf-Diesel-Straße 2 D 14974 Ludwigsfelde, 14974 D 14974 Ludwigsfelde", departmentCity: "Ludwigsfelde", departmentSourcePage: 1,
        tourRemarks: "MB Düsseldorf 477339 070A & 070D LG --> Lager", tourRemarksSourcePage: 1,
        stops: [
          { sequence: 1, type: "LOAD", company: "ELSTER WERKE gemeinnützige GmbH", address: "An den Steinenden 11, 04916 Herzberg (Elster)", city: "Herzberg (Elster)", appointmentDateLocal: "2026-11-10",
            sourceExcerpt: "09.11.2026 10.11.2026 710686727 070A Herzberg (Elster) 6100477339/ 1 ldm", referenceNumbers: ["6100477339-16507485", "710686727"], loadingMeters: 1, sourcePage: 2, confidence: 0.8 },
          { sequence: 2, type: "LOAD", company: "LG", address: "070D LG", city: null, sourceExcerpt: "070D LG", sourcePage: 1, confidence: 0.3 },
          { sequence: 3, type: "LOAD", company: "Mercedes-Benz AG / Werk 065", address: "Toulouser Allee, Tor 26/27, 40476 Düsseldorf", city: "Düsseldorf", appointmentDateLocal: "2026-11-09",
            sourceExcerpt: "Mercedes-Benz AG / Werk 065 Toulouser Allee, Tor 26/27 D 40476 Düsseldorf 6100477339-12315370", referenceNumbers: ["6100477339-12315370"], loadingMeters: 2, sourcePage: 1, confidence: 0.85 },
          { sequence: 4, type: "UNLOAD", company: "Webasto Roof & Components SE", address: "Werner-Baier-Straße 1, 17033 Neubrandenburg", city: "Neubrandenburg", sourcePage: 1, confidence: 0.8 },
          { sequence: 5, type: "UNLOAD", company: "Schnellecke Transportlogistik GmbH", address: "Rudolf-Diesel-Straße 2 D 14974 Ludwigsfelde, 14974 D 14974 Ludwigsfelde", city: "Ludwigsfelde", sourceExcerpt: "Abteilung: Schnellecke Transportlogistik GmbH, Rudolf-Diesel-Straße 2", sourcePage: 1, confidence: 0.7 }
        ], warnings: []
      }], warnings: []
    }) }), { status: 200 })) as unknown as typeof fetch;

    const result = await importPdfPreview(Buffer.from("%PDF-1.7"), "transportauftrag.pdf", { apiKey: "test-key", fetchImpl, now: new Date("2026-11-06T12:00:00Z") });
    const draft = result.drafts[0];
    expect(draft.stops.map((stop) => [stop.type, stop.company, stop.address])).toEqual([
      ["LOAD", "Mercedes-Benz AG / Werk 065", "Toulouser Allee, Tor 26/27, 40476 Düsseldorf"],
      ["UNLOAD", "Schnellecke Transportlogistik GmbH", "Rudolf-Diesel-Straße 2 D 14974 Ludwigsfelde"]
    ]);
    expect(draft.stops[0].referenceNumbers).toEqual(["6100477339-12315370", "070A", "070D"]);
    expect(draft.stops[0].instructions).toBe("Leergut");
    expect(draft.stops.some((stop) => /\bLG\b/.test(`${stop.company} ${stop.address} ${stop.city}`))).toBe(false);
    const codes = draft.warnings.map((warning) => warning.code);
    expect(codes).not.toContain("TOUR_REMARKS_STOP_NOT_FOUND");
    expect(codes).toContain("TABLE_STOPS_NOT_IN_TOUR_REMARKS");
  });

  it("takes codes and cargo words out of Tourbemerkung places", () => {
    const route = parseTourRemarksRoute("MB Düsseldorf 477339 070A & 070D LG --> Lager")!;
    expect(route.map((stop) => [stop.type, stop.label, stop.cityHint])).toEqual([["LOAD", "MB Düsseldorf", "Düsseldorf"], ["UNLOAD", "Lager", ""]]);
    expect(route[0]).toMatchObject({ references: ["477339", "070A", "070D"], cargo: "Leergut" });
    expect(parseTourRemarksRoute("Seifert & BLG Bremen für VW Kassel 4711")?.map((stop) => [stop.label, stop.references])).toEqual([
      ["Seifert Bremen", []], ["BLG Bremen", []], ["VW Kassel", ["4711"]]
    ]);
    expect(compactAddress("Rudolf-Diesel-Straße 2 D 14974 Ludwigsfelde, 14974 D 14974 Ludwigsfelde")).toBe("Rudolf-Diesel-Straße 2 D 14974 Ludwigsfelde");
    expect(compactAddress("Mercedesstraße 1, 28309 Bremen")).toBe("Mercedesstraße 1, 28309 Bremen");
  });

  it("uses Abteilung for vorladen and ignores a parenthetical city after the unload destination", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ output_text: JSON.stringify({
      drafts: [{
        orderNumber: "20564785", vehicleNumber: null, vehiclePlate: "GÖ-FX952", trailerPlate: "HH-PN6618",
        departmentCompany: "Schnellecke Transportlogistik GmbH",
        departmentAddress: "Büttenstraße 4, 08058 Zwickau, Deutschland",
        departmentCity: "Zwickau", departmentSourcePage: 1,
        tourRemarks: "vorladen//Lager für Rudolph Großmehring (Győr)", tourRemarksSourcePage: 1,
        stops: [
          { sequence: 1, type: "UNLOAD", company: "Rudolph General Solutions GmbH", address: "Gutenbergstr. 5, 85098 Großmehring, Deutschland", city: "Großmehring", appointmentLocal: null, referenceNumbers: ["23293289"], sourcePage: 1, confidence: 0.95 }
        ], warnings: []
      }], warnings: []
    }) }), { status: 200 })) as unknown as typeof fetch;

    const result = await importPdfPreview(Buffer.from("%PDF-1.7"), "auftrag.pdf", { apiKey: "test-key", fetchImpl });

    expect(result.drafts[0].stops).toMatchObject([
      {
        sequence: 1,
        type: "LOAD",
        company: "Schnellecke Transportlogistik GmbH",
        address: "Büttenstraße 4, 08058 Zwickau, Deutschland",
        city: "Zwickau"
      },
      {
        sequence: 2,
        type: "UNLOAD",
        company: "Rudolph General Solutions GmbH",
        address: "Gutenbergstr. 5, 85098 Großmehring, Deutschland",
        city: "Großmehring"
      }
    ]);
    expect(result.drafts[0].stops.some((stop) => stop.city === "Győr")).toBe(false);
  });

  it("marks a city-only address and missing Tourbemerkung as requiring review", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ output_text: JSON.stringify({
      drafts: [{
        orderNumber: "20562789", vehicleNumber: null, vehiclePlate: "B-CY7490", trailerPlate: "Z-S3153",
        tourRemarks: null, tourRemarksSourcePage: null,
        stops: [{ sequence: 1, type: "UNLOAD", company: "Kaufland", address: "Barsinghausen", city: "Barsinghausen",
          appointmentLocal: null, appointmentWindowStartLocal: null, appointmentWindowEndLocal: null,
          loadingMeters: 10.4, referenceNumbers: ["008965"], instructions: null, sourcePage: 2,
          sourceExcerpt: "Kaufland, Barsinghausen", confidence: 0.6 }], warnings: []
      }], warnings: []
    }) }), { status: 200 })) as unknown as typeof fetch;

    const result = await importPdfPreview(Buffer.from("%PDF-1.7"), "auftrag.pdf", { apiKey: "test-key", fetchImpl });
    expect(result.drafts[0].stops[0]).toMatchObject({ loadingMeters: 10.4, address: "Barsinghausen" });
    expect(result.drafts[0].warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "TOUR_REMARKS_MISSING" }),
      expect.objectContaining({ code: "ADDRESS_INCOMPLETE", page: 2 })
    ]));
  });

  it("rejects malformed structured output", async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ output_text: JSON.stringify({ drafts: [{ stops: [] }], warnings: [] }) }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    )) as unknown as typeof fetch;

    await expect(importPdfPreview(Buffer.from("%PDF-1.7\nauftrag"), "auftrag.pdf", {
      apiKey: "test-key",
      fetchImpl
    })).rejects.toThrow();
  });

  it("sends screenshots as OpenAI image input and fills missing city from postal addresses", async () => {
    const fetchMock = vi.fn(async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      return new Response(
        JSON.stringify({
          output_text: JSON.stringify({
            drafts: [
              {
                orderNumber: "IMG-17",
                vehicleNumber: null,
                stops: [
                  {
                    sequence: 1,
                    type: "LOAD",
                    company: null,
                    address: "Industriestraße 10, 28199 Bremen, Deutschland",
                    city: null,
                    appointmentLocal: null,
                    sourcePage: null,
                    confidence: 0.86
                  },
                  {
                    sequence: 2,
                    type: "UNLOAD",
                    company: null,
                    address: "Hafenstraße 2, 20457 Hamburg, Deutschland",
                    city: null,
                    appointmentLocal: null,
                    sourcePage: null,
                    confidence: 0.84
                  }
                ],
                warnings: []
              }
            ],
            warnings: []
          })
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });

    const result = await importImagePreview(Buffer.from("png-bytes"), "tabelle.png", "image/png", {
      apiKey: "test-key",
      model: "gpt-test",
      fetchImpl: fetchMock as unknown as typeof fetch
    });

    expect(result).toMatchObject({
      source: "OPENAI",
      detectedLayout: "IMAGE",
      drafts: [{ orderNumber: "IMG-17", stops: [{ type: "LOAD", city: "Bremen" }, { type: "UNLOAD", city: "Hamburg" }] }]
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as {
      input: Array<{ role: string; content: unknown }>;
    };
    const userMessage = body.input.find((item) => item.role === "user");
    expect(userMessage?.content).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "input_image",
        image_url: expect.stringMatching(/^data:image\/png;base64,/),
        detail: "high"
      }),
      expect.objectContaining({ type: "input_text", text: expect.stringContaining("city") })
    ]));
  });
});

describe("stop dates read from a PDF Auftrag", () => {
  const stop = (sequence: number, type: "LOAD" | "UNLOAD", dates: Record<string, string | null>) => ({
    sequence, type, company: type === "LOAD" ? "Werk Göttingen" : "Audi AG", address: type === "LOAD" ? "Otto-Brenner-Str. 20, 37079 Göttingen" : "Auto-Union-Str. 1, 85057 Ingolstadt",
    city: null, appointmentLocal: null, appointmentWindowStartLocal: null, appointmentWindowEndLocal: null, appointmentDateLocal: null, ...dates,
    loadingMeters: null, referenceNumbers: [], instructions: null, sourcePage: 1, sourceExcerpt: null, confidence: 0.9
  });

  it("gives the reader today's date and plans a date-only stop at 06:00 without a Termin; an exact time wins over a window", async () => {
    let instruction = "";
    const fetchMock = vi.fn(async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      instruction = JSON.stringify(JSON.parse(String(init?.body)).input);
      return new Response(JSON.stringify({ output_text: JSON.stringify({ drafts: [{
        orderNumber: "PDF-DATES", vehicleNumber: null, vehiclePlate: null, trailerPlate: null, tourRemarks: null, tourRemarksSourcePage: null,
        departmentCompany: null, departmentAddress: null, departmentCity: null, departmentSourcePage: null,
        stops: [
          stop(1, "LOAD", { appointmentDateLocal: "2026-11-05" }),
          stop(2, "UNLOAD", { appointmentLocal: "2026-11-06T13:30", appointmentWindowStartLocal: "2026-11-06T08:00", appointmentWindowEndLocal: "2026-11-06T16:00" })
        ], warnings: [] }], warnings: [] }) }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const preview = await importPdfPreview(Buffer.from("%PDF-1.7"), "auftrag.pdf", { apiKey: "test", fetchImpl: fetchMock as typeof fetch, now: new Date("2026-11-02T10:00:00Z") });
    expect(instruction).toContain("today is 2026-11-02");
    expect(instruction).toContain("Ladedatum");
    const [load, unload] = preview.drafts[0].stops;
    expect(load).toMatchObject({ appointmentLocal: null, appointmentWindowStartLocal: null, appointmentWindowEndLocal: null, plannedLocal: "2026-11-05T06:00" });
    expect(unload).toMatchObject({ appointmentLocal: "2026-11-06T13:30", appointmentWindowStartLocal: null, appointmentWindowEndLocal: null });
    expect(preview.drafts[0].warnings.map((warning) => warning.code)).toEqual(expect.arrayContaining(["DATE_ONLY", "APPOINTMENT_CONFLICT"]));
  });
});
