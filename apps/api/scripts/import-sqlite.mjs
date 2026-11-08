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

const destinationUrl = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!destinationUrl) {
  throw new Error("DATABASE_URL_UNPOOLED or DATABASE_URL is required for the PostgreSQL destination");
}

const sqlite = new SqliteClient({
  datasources: { db: { url: `file:${sourcePath}` } },
});
const postgres = new PostgresClient({
  datasources: { db: { url: destinationUrl } },
});

const modelOrder = [
  // Vehicles reference their dispatcher, so accounts come first.
  "dispatcher",
  // Trucks and tours reference a customer line, lines reference their customer.
  "customer",
  "customerLine",
  "dispatcherLine",
  "pushSubscription",
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
  "vehicleIntegration",
  "pendingAppointment",
  "addressRule",
  "vehicleTelemetry",
  "integrationSyncState",
  "integrationReceipt",
  "assistantConversation",
  "assistantMessage",
  "assistantProposal",
  "assistantUsage",
  "vehicleIssue",
  "auditLog",
  // Rows reference their list and (optionally) the truck.
  "dailyStatusReport",
  "dailyStatusRow",
  "knownAddress",
  // The Auftrag file references its tour; corrections reference the document.
  "orderDocument",
  "importCorrection",
  "importRule",
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
  const conversationIds = ids("assistantConversation");
  const dispatcherIds = ids("dispatcher");
  const problems = [];
  const requireId = (condition, message) => {
    if (!condition) problems.push(message);
  };

  const customerIds = ids("customer");
  const lineIds = ids("customerLine");
  for (const row of data.customerLine) {
    requireId(customerIds.has(row.customerId), `CustomerLine ${row.id} has missing customer ${row.customerId}`);
  }
  for (const row of data.dispatcherLine) {
    requireId(dispatcherIds.has(row.dispatcherId), `DispatcherLine has missing dispatcher ${row.dispatcherId}`);
    requireId(lineIds.has(row.lineId), `DispatcherLine has missing line ${row.lineId}`);
  }
  for (const row of data.vehicle) {
    if (row.customerLineId) requireId(lineIds.has(row.customerLineId), `Vehicle ${row.id} has missing customer line ${row.customerLineId}`);
    if (row.assignedDispatcherId) {
      requireId(dispatcherIds.has(row.assignedDispatcherId), `Vehicle ${row.id} has missing dispatcher ${row.assignedDispatcherId}`);
    }
  }
  for (const row of data.tour) {
    if (row.customerId) requireId(customerIds.has(row.customerId), `Tour ${row.id} has missing customer ${row.customerId}`);
    if (row.customerLineId) requireId(lineIds.has(row.customerLineId), `Tour ${row.id} has missing customer line ${row.customerLineId}`);
    requireId(vehicleIds.has(row.vehicleId), `Tour ${row.id} has missing vehicle ${row.vehicleId}`);
    if (row.previousTourId) {
      requireId(tourIds.has(row.previousTourId), `Tour ${row.id} has missing previous tour ${row.previousTourId}`);
    }
  }
  const documentIds = ids("orderDocument");
  for (const row of data.orderDocument) {
    if (row.tourId) requireId(tourIds.has(row.tourId), `OrderDocument ${row.id} has missing tour ${row.tourId}`);
  }
  for (const row of data.importCorrection) {
    requireId(documentIds.has(row.documentId), `ImportCorrection ${row.id} has missing document ${row.documentId}`);
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
  for (const model of ["vehicleIntegration", "vehicleTelemetry", "vehicleIssue"]) {
    for (const row of data[model]) {
      requireId(vehicleIds.has(row.vehicleId), `${model} ${row.id} has missing vehicle ${row.vehicleId}`);
    }
  }
  const reportIds = ids("dailyStatusReport");
  for (const row of data.dailyStatusRow) {
    requireId(reportIds.has(row.reportId), `DailyStatusRow ${row.id} has missing report ${row.reportId}`);
    if (row.vehicleId) requireId(vehicleIds.has(row.vehicleId), `DailyStatusRow ${row.id} has missing vehicle ${row.vehicleId}`);
  }
  for (const model of ["assistantMessage", "assistantProposal"]) {
    for (const row of data[model]) {
      requireId(
        conversationIds.has(row.conversationId),
        `${model} ${row.id} has missing conversation ${row.conversationId}`,
      );
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
