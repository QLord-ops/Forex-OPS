import { spawn } from "node:child_process";

if (process.env.VERCEL_ENV !== "production") {
  process.exit(0);
}

if (!process.env.DATABASE_URL_UNPOOLED && !process.env.DATABASE_URL) {
  console.error("Production database URL is missing; refusing to build the API.");
  process.exit(1);
}

const child = spawn(process.execPath, ["scripts/migrate.mjs"], {
  stdio: "inherit",
  env: process.env
});

child.on("error", error => {
  console.error(error);
  process.exit(1);
});

child.on("exit", code => process.exit(code ?? 1));
