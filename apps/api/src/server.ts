import "./env.js";
import { buildApp } from "./app.js";
import { prisma } from "./lib/prisma.js";

const port = Number(process.env.PORT ?? process.env.API_PORT ?? 3001);
const host = process.env.API_HOST ?? "127.0.0.1";
const SHUTDOWN_TIMEOUT_MS = 10_000;
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

let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "Остановка API");
  // A hung request or open event stream must not block a redeploy forever.
  const force = setTimeout(() => {
    app.log.error("Остановка заняла слишком долго, выход принудительно");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  force.unref();
  try {
    await app.close();
    await prisma.$disconnect();
    process.exit(0);
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("unhandledRejection", (reason) => {
  app.log.error({ err: reason }, "Необработанная ошибка в промисе");
});
