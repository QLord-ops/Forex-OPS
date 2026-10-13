import "../env.js";
import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as typeof globalThis & { opsPrisma?: PrismaClient };

export const prisma = globalForPrisma.opsPrisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.opsPrisma = prisma;
