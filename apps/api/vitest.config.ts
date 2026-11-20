import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "../web/tests/**/*.test.ts", "../driver/tests/**/*.test.ts"]
  }
});
