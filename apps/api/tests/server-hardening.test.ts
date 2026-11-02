import ExcelJS from "exceljs";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp, proxyTrust, trustedProxyHops } from "../src/app.js";
import { importExcelPreview } from "../src/services/excel-order-import.js";

const apps: Array<{ close(): Promise<unknown> }> = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function unknownLayoutWorkbook(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Orders");
  sheet.addRow(["foo", "bar"]);
  sheet.addRow(["one", "two"]);
  return Buffer.from((await workbook.xlsx.writeBuffer()) as unknown as ArrayBuffer);
}

describe("proxy chain", () => {
  it("trusts two proxies in production by default and follows TRUST_PROXY_HOPS", () => {
    expect(trustedProxyHops(undefined, true)).toBe(2);
    expect(trustedProxyHops(undefined, false)).toBe(false);
    expect(trustedProxyHops("1", true)).toBe(1);
    expect(trustedProxyHops("0", true)).toBe(false);
    expect(trustedProxyHops("abc", false)).toBe(false);
  });

  it("finds the browser address behind Vercel and DigitalOcean, not the proxy address", async () => {
    const app = Fastify({ trustProxy: proxyTrust(2) });
    apps.push(app);
    app.get("/ip", async (request) => ({ ip: request.ip }));
    const viaVercel = await app.inject({ url: "/ip", headers: { "x-forwarded-for": "203.0.113.5, 76.76.21.9" } });
    expect(viaVercel.json().ip).toBe("203.0.113.5");
    const otherUser = await app.inject({ url: "/ip", headers: { "x-forwarded-for": "198.51.100.7, 76.76.21.9" } });
    expect(otherUser.json().ip).toBe("198.51.100.7");
  });
});

describe("Excel AI budget", () => {
  it("reserves the AI budget before calling OpenAI and stops when the limit is reached", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const limit = Object.assign(new Error("Лимит обращений к ИИ исчерпан."), { statusCode: 429 });
    await expect(importExcelPreview(await unknownLayoutWorkbook(), "auftrag.xlsx", {
      openAiApiKey: "test-key", fetchImpl, beforeAi: async () => { throw limit; }
    })).rejects.toBe(limit);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not spend budget on workbooks the rules can read", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Orders");
    sheet.addRow(["Auftrag", "Typ", "Adresse"]);
    sheet.addRow(["A-1", "Beladen", "Lindenstraße 4, 85354 Freising"]);
    sheet.addRow(["A-1", "Entladen", "Dieselstraße 2, 30890 Barsinghausen"]);
    const beforeAi = vi.fn(async () => undefined);
    const result = await importExcelPreview(Buffer.from((await workbook.xlsx.writeBuffer()) as unknown as ArrayBuffer), "auftrag.xlsx", { openAiApiKey: "test-key", beforeAi });
    expect(result.drafts.length).toBeGreaterThan(0);
    expect(beforeAi).not.toHaveBeenCalled();
  });

  it("does not show the provider's raw error text to the dispatcher", async () => {
    const fetchImpl = vi.fn(async () => new Response("upstream secret-ish failure sk-test-123", { status: 500 })) as unknown as typeof fetch;
    const result = await importExcelPreview(await unknownLayoutWorkbook(), "auftrag.xlsx", { openAiApiKey: "test-key", fetchImpl, beforeAi: async () => undefined });
    const warning = result.warnings.find((item) => item.code === "OPENAI_FAILED");
    expect(warning?.message).toBeTruthy();
    expect(warning?.message).not.toContain("sk-test");
    expect(warning?.message).not.toContain("500");
  });
});

describe("health", () => {
  it("reports the database as part of the health check", async () => {
    const app = await buildApp({ auth: { disabled: true }, databaseCheck: async () => 1 });
    apps.push(app);
    const response = await app.inject({ url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, database: "ok" });
  });

  it("answers 503 without details when the database is unreachable", async () => {
    const app = await buildApp({ auth: { disabled: true }, databaseCheck: async () => { throw new Error("connect ECONNREFUSED db-host:25060 password=x"); } });
    apps.push(app);
    const response = await app.inject({ url: "/health" });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ ok: false, database: "unavailable" });
    expect(response.body).not.toContain("db-host");
  });
});
