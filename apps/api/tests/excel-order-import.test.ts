import ExcelJS from "exceljs";
import { describe, expect, it, vi } from "vitest";
import {
  importExcelPreview,
  parseRowsWithRules,
  readBoundedExcelRows,
  type BoundedExcelRow
} from "../src/services/excel-order-import.js";
import { importOrdersWithOpenAi } from "../src/services/openai-order-import.js";

const { Workbook } = ExcelJS;

describe("Excel order import", () => {
  it("parses one-row wide Auftrag layouts with German headers", async () => {
    const buffer = await workbookBuffer([
      ["Auftragsnummer", "LKW", "Ladefirma", "Ladeadresse", "Ladetermin", "Entladefirma", "Entladeadresse", "Entladetermin"],
      [
        "A-100",
        "HH-AB 123",
        "Werk Nord",
        "Industriestr. 1, 30159 Hannover",
        new Date(Date.UTC(2026, 9, 5, 8, 30)),
        "Kunde Süd",
        "Hauptstr. 8, 80331 München",
        "06.10.2026 14:15"
      ]
    ]);

    const result = await importExcelPreview(buffer);

    expect(result.usedAi).toBe(false);
    expect(result.aiAvailable).toBe(false);
    expect(result.drafts).toHaveLength(1);
    expect(result.detectedLayout).toBe("LOAD_UNLOAD_COLUMNS");
    expect(result.drafts[0]).toMatchObject({
      orderNumber: "A-100",
      vehicleNumber: "HH-AB 123"
    });
    expect(result.drafts[0].stops).toEqual([
      expect.objectContaining({
        type: "LOAD",
        company: "Werk Nord",
        address: "Industriestr. 1, 30159 Hannover",
        appointmentLocal: "2026-10-05T08:30"
      }),
      expect.objectContaining({
        type: "UNLOAD",
        company: "Kunde Süd",
        address: "Hauptstr. 8, 80331 München",
        appointmentLocal: "2026-10-06T14:15"
      })
    ]);
  });

  it("groups row-per-stop layouts by order number and supports Russian aliases", () => {
    const rows: BoundedExcelRow[] = [
      row(1, ["номер заказа", "тип", "компания", "адрес", "дата"]),
      row(2, ["RU-1", "загрузка", "Склад", "Berlin, Alexanderplatz 1", "05.10.2026 09:00"]),
      row(3, ["RU-1", "выгрузка", "Клиент", "Hamburg, Hafenstrasse 2", "2026-10-05 18:30"]),
      row(4, ["RU-2", "load", "", "Bremen, Am Markt 1", ""])
    ];

    const parsed = parseRowsWithRules(rows);
    const drafts = parsed.drafts;

    expect(parsed.detectedLayout).toBe("ROW_PER_STOP");
    expect(drafts).toHaveLength(2);
    expect(drafts[0].orderNumber).toBe("RU-1");
    expect(drafts[0].stops.map((stop) => stop.type)).toEqual(["LOAD", "UNLOAD"]);
    expect(drafts[0].stops.map((stop) => stop.appointmentLocal)).toEqual(["2026-10-05T09:00", "2026-10-05T18:30"]);
    expect(drafts[1]).toMatchObject({ orderNumber: "RU-2" });
    expect(drafts[1].stops[0]).toMatchObject({ type: "LOAD", address: "Bremen, Am Markt 1" });
  });

  it("uses cached formula results and warns without evaluating formulas", async () => {
    const workbook = new Workbook();
    const sheet = workbook.addWorksheet("Formula Auftrag");
    sheet.addRow(["Auftragsnummer", "Ladeadresse", "Entladeadresse"]);
    sheet.addRow(["F-1", { formula: "CONCAT(\"Berlin\")", result: "Berlin, Torstr. 1" }, { formula: "NOW()" }]);

    const buffer = await workbookBufferFromWorkbook(workbook);
    const rowsResult = await readBoundedExcelRows(buffer);
    const importResult = await importExcelPreview(buffer);

    expect(rowsResult.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "FORMULA_CACHED_RESULT" }),
        expect.objectContaining({ code: "FORMULA_NO_CACHE" })
      ])
    );
    expect(importResult.drafts[0].stops).toEqual([
      expect.objectContaining({ type: "LOAD", address: "Berlin, Torstr. 1" })
    ]);
    expect(importResult.drafts[0].warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "MISSING_UNLOAD_ADDRESS" })]));
  });

  it("uses sparse worksheet row and column bounds without dropping trailing data", async () => {
    const workbook = new Workbook();
    const sheet = workbook.addWorksheet("Sparse");
    sheet.getCell("A10").value = "Auftragsnummer";
    sheet.getCell("B10").value = "Ladeadresse";
    sheet.getCell("Z10").value = "Entladeadresse";
    sheet.getCell("A12").value = "SPARSE-1";
    sheet.getCell("B12").value = "Berlin";
    sheet.getCell("Z12").value = "Hamburg";

    const result = await importExcelPreview(await workbookBufferFromWorkbook(workbook));

    expect(result.drafts[0]).toMatchObject({ orderNumber: "SPARSE-1" });
    expect(result.drafts[0].stops.map((stop) => stop.address)).toEqual(["Berlin", "Hamburg"]);
  });

  it("warns for ignored nonempty sheets and truncated cells", async () => {
    const workbook = new Workbook();
    const first = workbook.addWorksheet("First");
    first.addRow(["Auftragsnummer", "Ladeadresse", "Entladeadresse"]);
    first.addRow(["TRUNC-1", "A".repeat(2501), "Hamburg"]);
    const second = workbook.addWorksheet("Second");
    second.addRow(["Auftragsnummer", "Ladeadresse", "Entladeadresse"]);
    second.addRow(["IGNORED-1", "Paris", "Lyon"]);

    const result = await importExcelPreview(await workbookBufferFromWorkbook(workbook));

    expect(result.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "SHEET_IGNORED" })]));
    expect(result.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "CELL_TRUNCATED" })]));
    expect(result.drafts[0].stops[0].address).toHaveLength(2000);
  });

  it("caps sheets, rows, columns and cell lengths before parsing", async () => {
    const workbook = new Workbook();
    workbook.addWorksheet("Empty");
    const sheet = workbook.addWorksheet("Orders");
    sheet.addRow(["Auftragsnummer", "Ladeadresse", "Entladeadresse", ...Array.from({ length: 55 }, (_, index) => `X${index}`)]);
    sheet.addRow(["CAP-1", "A".repeat(2500), "B".repeat(2500)]);
    for (let index = 0; index < 510; index += 1) {
      sheet.addRow([`CAP-${index + 2}`, "Berlin", "Hamburg"]);
    }
    workbook.addWorksheet("Extra 1");
    workbook.addWorksheet("Extra 2");
    workbook.addWorksheet("Extra 3");
    workbook.addWorksheet("Extra 4");

    const result = await readBoundedExcelRows(await workbookBufferFromWorkbook(workbook));

    expect(result.sheetsScanned).toBe(5);
    expect(result.rows).toHaveLength(500);
    expect(result.rows[1].values).toHaveLength(50);
    expect(result.rows[1].values[1]).toHaveLength(2000);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "SHEETS_TRUNCATED" }),
        expect.objectContaining({ code: "ROWS_TRUNCATED" }),
        expect.objectContaining({ code: "COLUMNS_TRUNCATED" })
      ])
    );
  });

  it("returns an empty rules result with warnings for unknown layout when no OpenAI key exists", async () => {
    const buffer = await workbookBuffer([
      ["foo", "bar"],
      ["one", "two"]
    ]);

    const result = await importExcelPreview(buffer, "auftrag.xlsx", { openAiApiKey: "" });

    expect(result).toMatchObject({
      drafts: [],
      source: "RULES",
      aiAvailable: false,
      usedAi: false
    });
    expect(result.detectedLayout).toBe("UNKNOWN");
    expect(result.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "UNKNOWN_LAYOUT" })]));
  });

  it("never sends a rules-compatible workbook to OpenAI", async () => {
    const buffer = await workbookBuffer([
      ["Order number", "Loading address", "Delivery address"],
      ["LOCAL-1", "Berlin", "Hamburg"]
    ]);
    const fetchImpl = vi.fn(async () => {
      throw new Error("OpenAI must not be called");
    }) as unknown as typeof fetch;

    const result = await importExcelPreview(buffer, "auftrag.xlsx", {
      openAiApiKey: "test-key",
      fetchImpl
    });

    expect(result.source).toBe("RULES");
    expect(result.drafts).toHaveLength(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps date-only and invalid calendar appointments empty with warnings", () => {
    const parsed = parseRowsWithRules([
      row(1, ["Auftragsnummer", "Ladeadresse", "Ladetermin", "Entladeadresse", "Entladetermin"]),
      row(2, ["DATE-1", "Berlin", "31.02.2026 25:00", "Hamburg", "2026-10-05"])
    ]);

    expect(parsed.drafts[0].stops.map((stop) => stop.appointmentLocal)).toEqual([null, null]);
    expect(parsed.drafts[0].warnings).toEqual([
      expect.objectContaining({ code: "UNSUPPORTED_APPOINTMENT" }),
      expect.objectContaining({ code: "MISSING_TIME" })
    ]);
  });

  it("groups anonymous adjacent row-per-stop rows and carries explicit order numbers across blanks", () => {
    const parsed = parseRowsWithRules([
      row(1, ["Auftragsnummer", "Typ", "Firma", "Adresse", "Termin"]),
      row(2, ["", "load", "A", "Berlin", "05.10.2026 09:00"]),
      row(3, ["", "unload", "B", "Hamburg", "05.10.2026 18:00"]),
      row(5, ["EXP-1", "load", "C", "Bremen", "06.10.2026 09:00"]),
      row(6, ["", "unload", "D", "Köln", "06.10.2026 18:00"]),
      row(8, ["", "load", "E", "Munich", "07.10.2026 09:00"])
    ]);

    expect(parsed.drafts).toHaveLength(2);
    expect(parsed.drafts[0]).toMatchObject({ orderNumber: null });
    expect(parsed.drafts[0].stops.map((stop) => stop.address)).toEqual(["Berlin", "Hamburg"]);
    expect(parsed.drafts[1]).toMatchObject({ orderNumber: "EXP-1" });
    expect(parsed.drafts[1].stops.map((stop) => stop.address)).toEqual(["Bremen", "Köln", "Munich"]);
    expect(parsed.drafts[1].warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "ORDER_NUMBER_CARRIED" })]));
  });

  it("preserves typed row-per-stop stops with missing addresses", () => {
    const parsed = parseRowsWithRules([
      row(1, ["Auftragsnummer", "Typ", "Adresse"]),
      row(2, ["MISS-1", "load", "Berlin"]),
      row(3, ["", "unload", ""])
    ]);

    expect(parsed.drafts[0].stops).toEqual([
      expect.objectContaining({ sequence: 1, type: "LOAD", address: "Berlin" }),
      expect.objectContaining({ sequence: 2, type: "UNLOAD", address: null })
    ]);
    expect(parsed.drafts[0].warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "MISSING_ADDRESS" })]));
  });

  it("rejects non-xlsx filenames in the preview service", async () => {
    const result = await importExcelPreview(Buffer.from("legacy"), "auftrag.xls");

    expect(result).toMatchObject({
      detectedLayout: "UNKNOWN",
      drafts: [],
      warnings: [expect.objectContaining({ code: "UNSUPPORTED_FILE" })]
    });
  });

  it("uses OpenAI fallback only when rules find no drafts and validates structured output", async () => {
    const rows = [row(1, ["mystery", "columns"]), row(2, ["x", "y"])];
    const fetchMock = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) => {
      return new Response(
        JSON.stringify({
          output_text: JSON.stringify({
            drafts: [
              {
                orderNumber: "AI-1",
                vehicleNumber: null,
                stops: [
                  {
                    sequence: 1,
                    type: "LOAD",
                    company: null,
                    address: "Berlin",
                    appointmentLocal: null,
                    sourceRow: 2,
                    confidence: 0.7
                  }
                ],
                warnings: []
              }
            ],
            warnings: [{ code: "LOW_CONFIDENCE", message: "low confidence", sourceSheet: null, sourceRow: null, sourceColumn: null }]
          })
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });
    const fetchImpl = fetchMock as unknown as typeof fetch;

    const result = await importOrdersWithOpenAi(rows, {
      apiKey: "test-key",
      model: "gpt-test",
      fetchImpl
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
      model: "gpt-test",
      store: false,
      text: { format: { type: "json_schema", strict: true } }
    });
    expect(result.drafts[0]).toMatchObject({ orderNumber: "AI-1" });
    expect(result.drafts[0].stops[0]).toMatchObject({ appointmentLocal: null });
    expect(result.drafts[0].stops[0]).not.toHaveProperty("appointmentAt");
    expect(result.warnings).toEqual([expect.objectContaining({ code: "LOW_CONFIDENCE", message: "low confidence" })]);
  });

  it("rejects OpenAI rows with invalid calendar dates", async () => {
    const response = {
      drafts: [
        {
          orderNumber: "AI-2",
          vehicleNumber: null,
          stops: [
            {
              sequence: 1,
              type: "LOAD",
              company: null,
              address: "Berlin",
              appointmentLocal: "2026-02-31T10:00",
              sourceRow: 99,
              confidence: 0.7
            }
          ],
          warnings: []
        }
      ],
      warnings: []
    };
    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify({ output_text: JSON.stringify(response) }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }) as unknown as typeof fetch;

    await expect(importOrdersWithOpenAi([row(1, ["x"])], { apiKey: "test-key", fetchImpl })).rejects.toThrow();
  });

  it("rejects OpenAI rows with sourceRow values that were not submitted", async () => {
    const response = {
      drafts: [
        {
          orderNumber: "AI-3",
          vehicleNumber: null,
          stops: [
            {
              sequence: 1,
              type: "LOAD",
              company: null,
              address: "Berlin",
              appointmentLocal: "2026-02-28T10:00",
              sourceRow: 99,
              confidence: 0.7
            }
          ],
          warnings: []
        }
      ],
      warnings: []
    };
    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify({ output_text: JSON.stringify(response) }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }) as unknown as typeof fetch;

    await expect(importOrdersWithOpenAi([row(1, ["x"])], { apiKey: "test-key", fetchImpl })).rejects.toThrow(
      "не было в отправленных строках"
    );
  });

  it("rejects oversized OpenAI output before parsing", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify({ output_text: "x".repeat(100_001) }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }) as unknown as typeof fetch;

    await expect(importOrdersWithOpenAi([row(1, ["x"])], { apiKey: "test-key", fetchImpl })).rejects.toThrow(
      "превышает 100000 символов"
    );
  });

  it("caps OpenAI input JSON and warns when rows are truncated", async () => {
    const longRows = Array.from({ length: 200 }, (_, index) =>
      row(index + 1, [`row-${index}`, "x".repeat(2000), "y".repeat(2000)])
    );
    const fetchMock = vi.fn(async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const body = JSON.parse(String(init?.body)) as { input: Array<{ role: string; content: string }> };
      const submitted = JSON.parse(body.input.find((item) => item.role === "user")?.content ?? "{}") as { rows: BoundedExcelRow[] };
      expect(JSON.stringify({ rows: submitted.rows }).length).toBeLessThanOrEqual(100_000);
      return new Response(JSON.stringify({ output_text: JSON.stringify({ drafts: [], warnings: [] }) }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });

    const result = await importOrdersWithOpenAi(longRows, {
      apiKey: "test-key",
      fetchImpl: fetchMock as unknown as typeof fetch
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "OPENAI_ROWS_TRUNCATED" })]));
    expect(result.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "OPENAI_JSON_TRUNCATED" })]));
  });

  it("rejects invalid OpenAI extraction output", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify({ output_text: JSON.stringify({ drafts: [{ stops: [] }], warnings: [] }) }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }) as unknown as typeof fetch;

    await expect(importOrdersWithOpenAi([row(1, ["x"])], { apiKey: "test-key", fetchImpl })).rejects.toThrow();
  });
});

async function workbookBuffer(rows: unknown[][]): Promise<Buffer> {
  const workbook = new Workbook();
  const sheet = workbook.addWorksheet("Orders");
  rows.forEach((values) => sheet.addRow(values));
  return workbookBufferFromWorkbook(workbook);
}

async function workbookBufferFromWorkbook(workbook: InstanceType<typeof Workbook>): Promise<Buffer> {
  return Buffer.from((await workbook.xlsx.writeBuffer()) as unknown as ArrayBuffer);
}

function row(rowNumber: number, values: string[]): BoundedExcelRow {
  return { sheetName: "Orders", rowNumber, values };
}
