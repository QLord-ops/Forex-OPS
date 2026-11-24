import { describe, expect, it } from "vitest";
import { TimeLimitError, withTimeLimit } from "../src/lib/time-limit.js";

describe("withTimeLimit (24.11: a background step that never answers no longer stops the 15 s check)", () => {
  it("gives the answer of work that finishes in time", async () => {
    await expect(withTimeLimit(Promise.resolve(7), 50)).resolves.toBe(7);
  });

  it("stops waiting for work that never answers", async () => {
    await expect(withTimeLimit(new Promise(() => undefined), 20)).rejects.toBeInstanceOf(TimeLimitError);
  });

  it("passes the work's own error through", async () => {
    await expect(withTimeLimit(Promise.reject(new Error("boom")), 50)).rejects.toThrow("boom");
  });
});
