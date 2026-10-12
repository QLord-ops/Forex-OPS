import { Workbook } from "exceljs";
import { describe, expect, it } from "vitest";
import { validateXlsxArchive } from "../src/services/xlsx-validation.js";

describe("XLSX archive safety", () => {
  it("accepts a normal workbook", async () => {
    const book = new Workbook();
    book.addWorksheet("Orders").addRow(["Ladeadresse", "Entladeadresse"]);
    const buffer = Buffer.from(await book.xlsx.writeBuffer());
    expect(() => validateXlsxArchive(buffer)).not.toThrow();
  });

  it("rejects malformed containers and an inflated declared entry size", async () => {
    expect(() => validateXlsxArchive(Buffer.from("PK broken"))).toThrow();
    const book = new Workbook();
    book.addWorksheet("Orders").addRow(["Berlin", "Hamburg"]);
    const buffer = Buffer.from(await book.xlsx.writeBuffer());
    const directory = buffer.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    buffer.writeUInt32LE(21 * 1024 * 1024, directory + 24);
    expect(() => validateXlsxArchive(buffer)).toThrow(/20 МБ/);
  });
});
