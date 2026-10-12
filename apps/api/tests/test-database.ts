import { readdir, readFile } from 'node:fs/promises';
import type { PrismaClient } from '@prisma/client';

/** Fresh isolated test DB only. Never point this helper at the workspace DB. */
export async function migrateTestDatabase(db: PrismaClient) {
  const root = new URL('../prisma/migrations/', import.meta.url);
  const folders = (await readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  for (const folder of folders) {
    const sql = await readFile(new URL(`${folder}/migration.sql`, root), 'utf8');
    const statements = sql
      .replace(/--[^\n]*/g, '')
      .split(';')
      .map(statement => statement.trim())
      .filter(statement => statement && !/^(?:BEGIN|COMMIT|PRAGMA\s+foreign_keys)/i.test(statement));

    // Prisma may otherwise dispatch adjacent statements to different pooled
    // SQLite connections. Table-copy migrations must stay on one connection.
    await db.$transaction(async transaction => {
      for (const statement of statements) {
        await transaction.$executeRawUnsafe(statement);
      }
    });
  }
}
