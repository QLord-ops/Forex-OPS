import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PrismaClient as PostgresPrismaClient } from "@prisma/client";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "../src/generated/sqlite-client/index.js";
import { registerDispatcherRoutes } from "../src/routes/dispatchers.js";
import { hashDispatcherPassword, registerDispatcherAuth } from "../src/services/dispatcher-auth.js";
import { migrateTestDatabase } from "./test-database.js";

const ORIGIN = "https://ops.test";
const adminPasswordHash = hashDispatcherPassword("break glass admin");
const HOUR = 3_600_000;
let directory: string;
let db: PrismaClient;
let now = Date.UTC(2026, 10, 24, 8);
let app: FastifyInstance;

async function login(body: Record<string, string | boolean>) {
  const response = await app.inject({ method: "POST", url: "/auth/login", headers: { origin: ORIGIN }, payload: body });
  const setCookie = String(response.headers["set-cookie"] ?? "");
  return { response, setCookie, headers: { origin: ORIGIN, cookie: setCookie.split(";")[0], "x-csrf-token": response.json().csrfToken ?? "" } };
}
const signedIn = async (headers: Record<string, string>) => (await app.inject({ method: "GET", url: "/vehicles", headers })).statusCode;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "ops-remember-"));
  db = new PrismaClient({ datasources: { db: { url: `file:${join(directory, "test.db")}` } } });
  await migrateTestDatabase(db);
  await db.dispatcher.create({ data: { login: "anna", displayName: "Anna", role: "dispatcher", passwordHash: hashDispatcherPassword("anna long password"), active: true } });
  app = Fastify();
  registerDispatcherAuth(app, db as never, { adminPasswordHash, secret: "s".repeat(32), origins: [ORIGIN], now: () => now });
  registerDispatcherRoutes(app, db as unknown as PostgresPrismaClient);
  app.get("/vehicles", async () => []);
  await app.ready();
}, 20_000);

afterAll(async () => {
  await app?.close();
  await db?.$disconnect();
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe("«Запомнить меня» (owner, 24.11)", () => {
  it("keeps a personal login for 7 days with the box ticked, 12 h without", async () => {
    const start = now;
    const remembered = await login({ login: "anna", password: "anna long password", remember: true });
    expect(remembered.response.statusCode).toBe(200);
    expect(remembered.setCookie).toContain("Max-Age=604800");
    const plain = await login({ login: "anna", password: "anna long password" });
    expect(plain.setCookie).toContain("Max-Age=43200");

    now = start + 13 * HOUR;
    expect(await signedIn(plain.headers)).toBe(401);
    expect(await signedIn(remembered.headers)).toBe(200);
    now = start + 2 * 24 * HOUR;
    expect(await signedIn(remembered.headers)).toBe(200);
    now = start + 7 * 24 * HOUR + 1;
    expect(await signedIn(remembered.headers)).toBe(401);
    now = start;
  });

  it("never gives the shared admin password more than 12 h", async () => {
    const shared = await login({ password: "break glass admin", remember: true });
    expect(shared.response.statusCode).toBe(200);
    expect(shared.setCookie).toContain("Max-Age=43200");
  });

  it("refuses a forged token that claims a longer life", async () => {
    const remembered = await login({ login: "anna", password: "anna long password", remember: true });
    const [expires, ...rest] = remembered.headers.cookie.split("=")[1].split(".");
    const forged = `ops_dispatcher=${[String(Number(expires) + 30 * 24 * HOUR), ...rest].join(".")}`;
    expect(await signedIn({ ...remembered.headers, cookie: forged })).toBe(401);
  });

  it("a new password ends the sessions made with the old one", async () => {
    // Later than everything above: the account cache only ever moves forward in time.
    now += 30 * 24 * HOUR;
    const start = now;
    const anna = await login({ login: "anna", password: "anna long password", remember: true });
    expect(await signedIn(anna.headers)).toBe(200);
    const admin = await login({ password: "break glass admin" });
    const id = (await db.dispatcher.findUniqueOrThrow({ where: { login: "anna" } })).id;
    expect((await app.inject({ method: "POST", url: `/dispatchers/${id}/password`, headers: admin.headers, payload: { password: "anna second password" } })).statusCode).toBe(200);
    // Every instance re-reads the account within a minute.
    now = start + 61_000;
    expect(await signedIn(anna.headers)).toBe(401);
    const again = await login({ login: "anna", password: "anna second password", remember: true });
    expect(await signedIn(again.headers)).toBe(200);
  });
});
