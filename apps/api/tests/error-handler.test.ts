import { expect, it } from "vitest";
import { buildApp } from "../src/app.js";

it("maps Prisma P2025 (record not found) to 404 with a Russian message", async () => {
  const app = await buildApp({ auth: { disabled: true } });
  app.get("/__test/missing-record", async () => {
    throw Object.assign(new Error("No Vehicle found"), { name: "PrismaClientKnownRequestError", code: "P2025" });
  });

  const response = await app.inject({ method: "GET", url: "/__test/missing-record" });

  expect(response.statusCode).toBe(404);
  expect(response.json()).toEqual({ error: "Запись не найдена." });
  await app.close();
});
