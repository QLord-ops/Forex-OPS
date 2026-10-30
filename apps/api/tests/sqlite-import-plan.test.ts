import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const apiRoot = resolve(import.meta.dirname, "..");

describe("SQLite to Postgres import plan", () => {
  it("includes every Prisma model in the verified transfer", () => {
    const schema = readFileSync(resolve(apiRoot, "prisma/sqlite/schema.prisma"), "utf8");
    const importer = readFileSync(resolve(apiRoot, "scripts/import-sqlite.mjs"), "utf8");
    const modelNames = [...schema.matchAll(/^model\s+(\w+)\s+\{/gm)].map(([, name]) =>
      `${name[0].toLowerCase()}${name.slice(1)}`,
    );

    for (const modelName of modelNames) {
      expect(importer, `missing ${modelName}`).toContain(`"${modelName}"`);
    }
  });
});
