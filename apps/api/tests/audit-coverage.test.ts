import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Routes that change nothing durable (previews, lookups, login) or record their own audit trail elsewhere.
const NOT_AUDITED = new Set([
  'POST /imports/excel/preview', 'POST /imports/pdf/preview', 'POST /imports/image/preview',
  'POST /tours/preview', 'POST /stops/:id/appointment/preview', 'POST /tours/:id/replan/preview',
  'POST /geocode/resolve',
  // Ranking counter only; the address book sync audits inside its service.
  'POST /addresses/:id/used'
]);

// Route files outside app.ts that mutate data; each handler must audit too.
const SOURCES = ['../src/app.ts', '../src/routes/vehicle-status-settings.ts', '../src/routes/daily-status.ts', '../src/routes/address-book.ts'];

describe('CLAUDE.md rule 7: every mutating route writes the audit log', () => {
  it.each(SOURCES)('has an audit call in each mutating handler of %s', (file) => {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    const starts = [...source.matchAll(/app\.(post|put|patch|delete)\(\s*['"]([^'"]+)['"]/g)];
    const missing: string[] = [];
    starts.forEach((match, index) => {
      const route = `${match[1].toUpperCase()} ${match[2]}`;
      const body = source.slice(match.index, starts[index + 1]?.index ?? source.length).split(/\n\s*app\.(get|register|addHook|setErrorHandler)\(/)[0];
      if (NOT_AUDITED.has(route)) return;
      // The daily list audits inside its service: generate() and editRow() write the entry.
      if (!/\baudit\(|writeAuditLog\(|auditActor\(request\)|\.generate\(|\.editRow\(|\.runNow\(/.test(body)) missing.push(route);
    });
    expect(missing).toEqual([]);
  });
});
