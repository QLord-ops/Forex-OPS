import { readFile } from 'node:fs/promises';
import type { PrismaClient } from '../src/generated/sqlite-client/index.js';
import type { PrismaClient as AppPrismaClient } from '@prisma/client';

/** Both generated clients expose the same models; only provider transaction options differ. */
export function asAppDatabase(db: PrismaClient): AppPrismaClient {
  return db as unknown as AppPrismaClient;
}

/** Fresh isolated test DB only. Never point this helper at the workspace DB. */
export async function migrateTestDatabase(db: PrismaClient) {
  const sql = await readFile(new URL('../prisma/sqlite/init.sql', import.meta.url), 'utf8');
  const statements = sql
    .replace(/--[^\n]*/g, '')
    .split(';')
    .map(statement => statement.trim())
    .filter(Boolean);

  await db.$transaction(async transaction => {
    for (const statement of statements) {
      await transaction.$executeRawUnsafe(statement);
    }
  });
}
