import "../env.js";
import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as typeof globalThis & { opsPrisma?: PrismaClient };

/**
 * Prisma sizes its pool from the CPU count: three connections on the one-vCPU server. Five dispatchers with open
 * screens plus the background sync then queue for a connection and time out. An explicit limit in the URL wins.
 */
export function pooledDatabaseUrl(url: string | undefined, size = process.env.DATABASE_POOL_SIZE): string | undefined {
  if (!url || !/^postgres(?:ql)?:\/\//.test(url) || /[?&]connection_limit=/.test(url)) return undefined;
  const limit = size && /^\d+$/.test(size) && Number(size) > 0 ? Math.min(Number(size), 20) : 8;
  return `${url}${url.includes("?") ? "&" : "?"}connection_limit=${limit}&pool_timeout=20`;
}

const datasourceUrl = pooledDatabaseUrl(process.env.DATABASE_URL);

export const prisma = globalForPrisma.opsPrisma ?? new PrismaClient(datasourceUrl ? { datasourceUrl } : undefined);

if (process.env.NODE_ENV !== "production") globalForPrisma.opsPrisma = prisma;
