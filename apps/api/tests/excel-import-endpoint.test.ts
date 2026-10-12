import { Workbook } from "exceljs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("POST /imports/excel/preview", () => {
  it("returns a non-persistent preview for a valid xlsx upload", async () => {
    const app = await buildApp();
    apps.push(app);
    const workbook = new Workbook();
    const sheet = workbook.addWorksheet("Orders");
    sheet.addRow(["Auftragsnummer", "Ladeadresse", "Entladeadresse"]);
    sheet.addRow(["XLSX-1", "Berlin, Alexanderplatz 1", "Hamburg, Hafenstraße 2"]);
    const file = Buffer.from(await workbook.xlsx.writeBuffer());
    const multipart = buildMultipart("auftrag.xlsx", file);

    const response = await app.inject({
      method: "POST",
      url: "/imports/excel/preview",
      headers: { "content-type": `multipart/form-data; boundary=${multipart.boundary}` },
      payload: multipart.body
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      source: "RULES",
      drafts: [
        {
          orderNumber: "XLSX-1",
          stops: [
            { sequence: 1, type: "LOAD", address: "Berlin, Alexanderplatz 1" },
            { sequence: 2, type: "UNLOAD", address: "Hamburg, Hafenstraße 2" }
          ]
        }
      ]
    });
  });

  it("rejects legacy or disguised files", async () => {
    const app = await buildApp();
    apps.push(app);
    const multipart = buildMultipart("auftrag.xls", Buffer.from("not an xlsx"), "application/vnd.ms-excel");

    const response = await app.inject({
      method: "POST",
      url: "/imports/excel/preview",
      headers: { "content-type": `multipart/form-data; boundary=${multipart.boundary}` },
      payload: multipart.body
    });

    expect(response.statusCode).toBe(415);
  });

  it("rejects missing and fake xlsx uploads", async () => {
    const app = await buildApp();
    apps.push(app);

    const missing = await app.inject({ method: "POST", url: "/imports/excel/preview" });
    const multipart = buildMultipart("auftrag.xlsx", Buffer.from("not a zip"));
    const fake = await app.inject({
      method: "POST",
      url: "/imports/excel/preview",
      headers: { "content-type": `multipart/form-data; boundary=${multipart.boundary}` },
      payload: multipart.body
    });

    expect(missing.statusCode).toBe(400);
    expect(fake.statusCode).toBe(415);
  });

  it("enforces the five megabyte upload limit", async () => {
    const app = await buildApp();
    apps.push(app);
    const oversized = Buffer.alloc(5 * 1024 * 1024 + 1, 0x61);
    oversized[0] = 0x50;
    oversized[1] = 0x4b;
    const multipart = buildMultipart("zu-gross.xlsx", oversized);

    const response = await app.inject({
      method: "POST",
      url: "/imports/excel/preview",
      headers: { "content-type": `multipart/form-data; boundary=${multipart.boundary}` },
      payload: multipart.body
    });

    expect(response.statusCode).toBe(413);
  });
});

describe("POST /imports/pdf/preview", () => {
  it("returns an AI preview without creating an Auftrag", async () => {
    const pdfImport = vi.fn(async () => ({
      source: "OPENAI" as const,
      detectedLayout: "PDF" as const,
      drafts: [
        {
          orderNumber: "PDF-1",
          vehicleNumber: "936",
          stops: [
            {
              sequence: 1,
              type: "LOAD" as const,
              company: null,
              address: "Alexanderplatz 1, 10178 Berlin",
              city: "Berlin",
              appointmentLocal: null,
              sourcePage: 1,
              confidence: 0.9
            },
            {
              sequence: 2,
              type: "UNLOAD" as const,
              company: null,
              address: "Am Sandtorkai 1, 20457 Hamburg",
              city: "Hamburg",
              appointmentLocal: null,
              sourcePage: 1,
              confidence: 0.9
            }
          ],
          warnings: []
        }
      ],
      warnings: [],
      aiAvailable: true as const,
      usedAi: true as const
    }));
    const app = await buildApp({ pdfImport });
    apps.push(app);
    const file = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF");
    const multipart = buildMultipart("auftrag.pdf", file, "application/pdf");

    const response = await app.inject({
      method: "POST",
      url: "/imports/pdf/preview",
      headers: { "content-type": `multipart/form-data; boundary=${multipart.boundary}` },
      payload: multipart.body
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      source: "OPENAI",
      detectedLayout: "PDF",
      drafts: [{ orderNumber: "PDF-1", vehicleNumber: "936" }]
    });
    expect(pdfImport).toHaveBeenCalledWith(file, "auftrag.pdf");
  });

  it("rejects disguised and malformed PDF uploads before calling OpenAI", async () => {
    const pdfImport = vi.fn();
    const app = await buildApp({ pdfImport });
    apps.push(app);
    const wrongExtension = buildMultipart("auftrag.txt", Buffer.from("%PDF-1.7"), "text/plain");
    const fakePdf = buildMultipart("auftrag.pdf", Buffer.from("not a pdf"), "application/pdf");

    const wrongExtensionResponse = await app.inject({
      method: "POST",
      url: "/imports/pdf/preview",
      headers: { "content-type": `multipart/form-data; boundary=${wrongExtension.boundary}` },
      payload: wrongExtension.body
    });
    const fakePdfResponse = await app.inject({
      method: "POST",
      url: "/imports/pdf/preview",
      headers: { "content-type": `multipart/form-data; boundary=${fakePdf.boundary}` },
      payload: fakePdf.body
    });

    expect(wrongExtensionResponse.statusCode).toBe(415);
    expect(fakePdfResponse.statusCode).toBe(415);
    expect(pdfImport).not.toHaveBeenCalled();
  });
});

describe("POST /imports/image/preview", () => {
  it("returns an AI preview for a screenshot without creating an Auftrag", async () => {
    const imageImport = vi.fn(async () => ({
      source: "OPENAI" as const,
      detectedLayout: "IMAGE" as const,
      drafts: [
        {
          orderNumber: "IMG-1",
          vehicleNumber: null,
          stops: [
            {
              sequence: 1,
              type: "LOAD" as const,
              company: null,
              address: "Alexanderplatz 1, 10178 Berlin",
              city: "Berlin",
              appointmentLocal: null,
              sourcePage: null,
              confidence: 0.9
            },
            {
              sequence: 2,
              type: "UNLOAD" as const,
              company: null,
              address: "Am Sandtorkai 1, 20457 Hamburg",
              city: "Hamburg",
              appointmentLocal: null,
              sourcePage: null,
              confidence: 0.9
            }
          ],
          warnings: []
        }
      ],
      warnings: [],
      aiAvailable: true as const,
      usedAi: true as const
    }));
    const app = await buildApp({ imageImport });
    apps.push(app);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    const multipart = buildMultipart("auftrag.png", png, "image/png");

    const response = await app.inject({
      method: "POST",
      url: "/imports/image/preview",
      headers: { "content-type": `multipart/form-data; boundary=${multipart.boundary}` },
      payload: multipart.body
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      source: "OPENAI",
      detectedLayout: "IMAGE",
      drafts: [{ orderNumber: "IMG-1", stops: [{ city: "Berlin" }, { city: "Hamburg" }] }]
    });
    expect(imageImport).toHaveBeenCalledWith(png, "auftrag.png", "image/png");
  });

  it("accepts valid JPEG and WebP screenshot signatures", async () => {
    const imageImport = vi.fn(async () => ({
      source: "OPENAI" as const,
      detectedLayout: "IMAGE" as const,
      drafts: [],
      warnings: [],
      aiAvailable: true as const,
      usedAi: true as const
    }));
    const app = await buildApp({ imageImport });
    apps.push(app);
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);
    const webp = Buffer.from("RIFF\u0004\u0000\u0000\u0000WEBPVP8 ", "binary");

    for (const [filename, file, mimeType] of [
      ["auftrag.jpg", jpeg, "image/jpeg"],
      ["auftrag.webp", webp, "image/webp"]
    ] as const) {
      const multipart = buildMultipart(filename, file, mimeType);
      const response = await app.inject({
        method: "POST",
        url: "/imports/image/preview",
        headers: { "content-type": `multipart/form-data; boundary=${multipart.boundary}` },
        payload: multipart.body
      });
      expect(response.statusCode).toBe(200);
    }

    expect(imageImport).toHaveBeenNthCalledWith(1, jpeg, "auftrag.jpg", "image/jpeg");
    expect(imageImport).toHaveBeenNthCalledWith(2, webp, "auftrag.webp", "image/webp");
  });

  it("rejects disguised screenshot uploads before calling OpenAI", async () => {
    const imageImport = vi.fn();
    const app = await buildApp({ imageImport });
    apps.push(app);
    const wrongExtension = buildMultipart("auftrag.gif", Buffer.from("GIF89a"), "image/gif");
    const fakePng = buildMultipart("auftrag.png", Buffer.from("not a png"), "image/png");
    const mismatchedPng = buildMultipart("auftrag.png", Buffer.from([0xff, 0xd8, 0xff, 0x00]), "image/jpeg");

    const wrongExtensionResponse = await app.inject({
      method: "POST",
      url: "/imports/image/preview",
      headers: { "content-type": `multipart/form-data; boundary=${wrongExtension.boundary}` },
      payload: wrongExtension.body
    });
    const fakePngResponse = await app.inject({
      method: "POST",
      url: "/imports/image/preview",
      headers: { "content-type": `multipart/form-data; boundary=${fakePng.boundary}` },
      payload: fakePng.body
    });
    const mismatchedPngResponse = await app.inject({
      method: "POST",
      url: "/imports/image/preview",
      headers: { "content-type": `multipart/form-data; boundary=${mismatchedPng.boundary}` },
      payload: mismatchedPng.body
    });

    expect(wrongExtensionResponse.statusCode).toBe(415);
    expect(fakePngResponse.statusCode).toBe(415);
    expect(mismatchedPngResponse.statusCode).toBe(415);
    expect(imageImport).not.toHaveBeenCalled();
  });

  it("enforces the ten megabyte screenshot limit before calling OpenAI", async () => {
    const imageImport = vi.fn();
    const app = await buildApp({ imageImport });
    apps.push(app);
    const oversized = Buffer.alloc(10 * 1024 * 1024 + 1, 0x00);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(oversized);
    const multipart = buildMultipart("zu-gross.png", oversized, "image/png");

    const response = await app.inject({
      method: "POST",
      url: "/imports/image/preview",
      headers: { "content-type": `multipart/form-data; boundary=${multipart.boundary}` },
      payload: multipart.body
    });

    expect(response.statusCode).toBe(413);
    expect(imageImport).not.toHaveBeenCalled();
  });
});

function buildMultipart(filename: string, file: Buffer, contentType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") {
  const boundary = "----ops-disponent-test-boundary";
  const prefix = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`
  );
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { boundary, body: Buffer.concat([prefix, file, suffix]) };
}
