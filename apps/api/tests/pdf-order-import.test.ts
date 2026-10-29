import { describe, expect, it, vi } from "vitest";
import { importImagePreview, importPdfPreview } from "../src/services/pdf-order-import.js";

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
    expect(instruction).toContain("every location before the first word 'für' is a LOAD");
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
