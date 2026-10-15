import { PrismaClient } from "@prisma/client";
import { config } from "dotenv";
import { resolve } from "node:path";

for (const path of [
  resolve(process.cwd(), ".env.local"),
  resolve(process.cwd(), "../../.env.local"),
  resolve(process.cwd(), ".env")
]) config({ path, override: false });

const connectionUrl = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;

if (!connectionUrl) {
  console.error("DATABASE_URL_UNPOOLED or DATABASE_URL must be configured.");
  process.exit(1);
}

const database = new PrismaClient({
  datasources: { db: { url: connectionUrl } }
});

try {
  const [server] = await database.$queryRaw`
    SELECT
      current_database() AS database_name,
      current_user AS database_user,
      current_setting('server_version') AS server_version,
      inet_server_addr()::text AS server_address
  `;
  const migrations = await database.$queryRaw`
    SELECT migration_name, finished_at, rolled_back_at
    FROM "_prisma_migrations"
    ORDER BY started_at ASC
  `.catch(() => []);

  console.log(JSON.stringify({
    ok: true,
    server,
    appliedMigrations: migrations.filter(migration => migration.finished_at && !migration.rolled_back_at).length,
    pendingOrFailedMigrations: migrations.filter(migration => !migration.finished_at || migration.rolled_back_at).length
  }, null, 2));
} catch (error) {
  console.error("Database readiness check failed.");
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await database.$disconnect();
}
