import { spawn } from "node:child_process";

const databaseUrl = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error("DATABASE_URL_UNPOOLED or DATABASE_URL must be configured.");
  process.exit(1);
}

const child = spawn("prisma", ["migrate", "deploy"], {
  stdio: "inherit",
  env: { ...process.env, DATABASE_URL: databaseUrl },
  shell: process.platform === "win32"
});

child.on("error", error => {
  console.error(error);
  process.exit(1);
});

child.on("exit", code => process.exit(code ?? 1));
