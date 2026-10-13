import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient as PostgresClient } from "@prisma/client";
import dotenv from "dotenv";
import { PrismaClient as SqliteClient } from "../src/generated/sqlite-client/index.js";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const apiDir = resolve(scriptDir, "..");
const workspaceDir = resolve(apiDir, "../..");
const defaultSource = resolve(apiDir, "prisma/dev.db");
const sourcePath = resolve(process.env.SQLITE_SOURCE_PATH ?? defaultSource);
const apply = process.argv.includes("--apply");

dotenv.config({ path: resolve(workspaceDir, ".env.local"), override: true });
dotenv.config({ path: resolve(apiDir, ".env"), override: false });

if (!existsSync(sourcePath)) {
  throw new Error(`SQLite source does not exist: ${sourcePath}`);
}

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required for the PostgreSQL destination");
}

const sqlite = new SqliteClient({
  datasources: { db: { url: `file:${sourcePath}` } },
});
const postgres = new PostgresClient();

const modelOrder = [
  "vehicle",
  "tour",
  "stop",
  "leg",
  "event",
  "alert",
  "apiQuota",
  "operationEvent",
  "notification",
  "routeRevision",
  "routePreview",
];

async function readAll(client) {
  return Object.fromEntries(
    await Promise.all(modelOrder.map(async (model) => [model, await client[model].findMany()])),
  );
}

function counts(data) {
  return Object.fromEntries(modelOrder.map((model) => [model, data[model].length]));
}

function assertRelations(data) {
  const ids = (model) => new Set(data[model].map((row) => row.id));
  const vehicleIds = ids("vehicle");
  const tourIds = ids("tour");
  const stopIds = ids("stop");
  const problems = [];
  const requireId = (condition, message) => {
    if (!condition) problems.push(message);
  };

  for (const row of data.tour) {
    requireId(vehicleIds.has(row.vehicleId), `Tour ${row.id} has missing vehicle ${row.vehicleId}`);
    if (row.previousTourId) {
      requireId(tourIds.has(row.previousTourId), `Tour ${row.id} has missing previous tour ${row.previousTourId}`);
    }
  }
  for (const row of data.stop) {
    requireId(tourIds.has(row.tourId), `Stop ${row.id} has missing tour ${row.tourId}`);
  }
  for (const row of data.leg) {
    requireId(tourIds.has(row.tourId), `Leg ${row.id} has missing tour ${row.tourId}`);
    requireId(stopIds.has(row.fromStopId), `Leg ${row.id} has missing origin stop ${row.fromStopId}`);
    requireId(stopIds.has(row.toStopId), `Leg ${row.id} has missing destination stop ${row.toStopId}`);
  }
  for (const model of ["event", "alert"]) {
    for (const row of data[model]) {
      requireId(vehicleIds.has(row.vehicleId), `${model} ${row.id} has missing vehicle ${row.vehicleId}`);
      requireId(tourIds.has(row.tourId), `${model} ${row.id} has missing tour ${row.tourId}`);
      requireId(stopIds.has(row.stopId), `${model} ${row.id} has missing stop ${row.stopId}`);
    }
  }

  if (problems.length) {
    throw new Error(`SQLite relation validation failed:\n${problems.join("\n")}`);
  }
}

async function main() {
  const source = await readAll(sqlite);
  assertRelations(source);
  const sourceCounts = counts(source);
  const destinationBefore = await readAll(postgres);
  const destinationCounts = counts(destinationBefore);

  console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", sourcePath, sourceCounts, destinationCounts }, null, 2));

  if (!apply) {
    console.log("Dry run complete. Re-run with --apply after creating a Neon backup branch.");
    return;
  }

  const nonEmpty = Object.entries(destinationCounts).filter(([, count]) => count > 0);
  if (nonEmpty.length) {
    throw new Error(`Destination is not empty: ${nonEmpty.map(([name, count]) => `${name}=${count}`).join(", ")}`);
  }

  await postgres.$transaction(async (tx) => {
    if (source.vehicle.length) await tx.vehicle.createMany({ data: source.vehicle });

    const toursWithoutChain = source.tour.map(({ previousTourId: _previousTourId, ...tour }) => ({
      ...tour,
      previousTourId: null,
    }));
    if (toursWithoutChain.length) await tx.tour.createMany({ data: toursWithoutChain });
    for (const tour of source.tour) {
      if (tour.previousTourId) {
        await tx.tour.update({ where: { id: tour.id }, data: { previousTourId: tour.previousTourId } });
      }
    }

    for (const model of modelOrder.slice(2)) {
      if (source[model].length) await tx[model].createMany({ data: source[model] });
    }
  }, { timeout: 60_000 });

  const destinationAfter = counts(await readAll(postgres));
  if (JSON.stringify(destinationAfter) !== JSON.stringify(sourceCounts)) {
    throw new Error(`Count verification failed: ${JSON.stringify({ sourceCounts, destinationAfter })}`);
  }

  console.log(JSON.stringify({ imported: true, destinationAfter }, null, 2));
}

try {
  await main();
} finally {
  await Promise.allSettled([sqlite.$disconnect(), postgres.$disconnect()]);
}
