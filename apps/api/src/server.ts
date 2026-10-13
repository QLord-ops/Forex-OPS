import "./env.js";
import { buildApp } from "./app.js";
import { prisma } from "./lib/prisma.js";

const port = Number(process.env.API_PORT ?? 3001);
const host = process.env.API_HOST ?? "127.0.0.1";
const app = await buildApp();

try {
  await prisma.$connect();
  await app.listen({ port, host });
  app.log.info(`OPS Disponent API listening on http://${host}:${port}`);
} catch (error) {
  app.log.error(error);
  await prisma.$disconnect();
  process.exit(1);
}

const shutdown = async () => {
  await app.close();
  await prisma.$disconnect();
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
