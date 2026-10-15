import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

describe("API root route", () => {
  afterEach(() => {
    delete process.env.VERCEL;
  });

  it("redirects people who open the API domain to the web application", async () => {
    process.env.VERCEL = "1";
    const app = await buildApp();

    const response = await app.inject({ method: "GET", url: "/" });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("https://ops-disponent-web.vercel.app/");
    await app.close();
  });
});
