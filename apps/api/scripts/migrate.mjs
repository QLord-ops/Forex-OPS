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

// The runtime role gets data access to every application table, but never DDL
// and never write access to Prisma's migration history.
async function grantRuntimeAccess() {
  const adminUrl = process.env.DATABASE_URL_UNPOOLED;
  const runtimeUrl = process.env.DATABASE_URL;
  if (!adminUrl || !runtimeUrl) return;

  const runtimeRole = decodeURIComponent(new URL(runtimeUrl).username);
  const adminRole = decodeURIComponent(new URL(adminUrl).username);
  if (!runtimeRole) throw new Error("DATABASE_URL must contain a PostgreSQL role.");
  if (runtimeRole === adminRole) return;

  const admin = new PrismaClient({ datasources: { db: { url: adminUrl } } });
  try {
    const role = quoteIdentifier(runtimeRole);
    await admin.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${role}`);
    const tables = await admin.$queryRaw`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
    `;
    for (const { tablename } of tables) {
      await admin.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.${quoteIdentifier(tablename)} TO ${role}`);
    }
    await admin.$executeRawUnsafe(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
    console.log(`Runtime database privileges verified for ${tables.length} tables.`);
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
