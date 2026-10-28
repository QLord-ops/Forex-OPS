import { spawn } from "node:child_process";
import { PrismaClient } from "@prisma/client";

const databaseUrl = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error("DATABASE_URL_UNPOOLED or DATABASE_URL must be configured.");
  process.exit(1);
}

const migrate = () => new Promise((resolve, reject) => {
  const child = spawn("prisma", ["migrate", "deploy"], {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: databaseUrl },
    shell: process.platform === "win32"
  });

  child.on("error", reject);
  child.on("exit", code => code === 0 ? resolve() : reject(new Error(`Prisma migrate exited with code ${code ?? 1}.`)));
});

const quoteIdentifier = value => `"${value.replaceAll('"', '""')}"`;
const runtimeTables = [
  "AssistantConversation",
  "AssistantMessage",
  "AssistantProposal",
  "AssistantUsage",
  "VehicleIssue"
];

async function grantRuntimeAccess() {
  const adminUrl = process.env.DATABASE_URL_UNPOOLED;
  const runtimeUrl = process.env.DATABASE_URL;
  if (!adminUrl || !runtimeUrl) return;

  const runtimeRole = decodeURIComponent(new URL(runtimeUrl).username);
  if (!runtimeRole) throw new Error("DATABASE_URL must contain a PostgreSQL role.");

  const admin = new PrismaClient({ datasources: { db: { url: adminUrl } } });
  try {
    const role = quoteIdentifier(runtimeRole);
    await admin.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${role}`);
    const tables = runtimeTables.map(quoteIdentifier).join(", ");
    await admin.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${tables} TO ${role}`);
    console.log("Runtime database privileges verified.");
  } finally {
    await admin.$disconnect();
  }
}

try {
  await migrate();
  await grantRuntimeAccess();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
