import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Routes that change nothing durable (previews, lookups, login) or record their own audit trail elsewhere.
const NOT_AUDITED = new Set([
  'POST /imports/excel/preview', 'POST /imports/pdf/preview', 'POST /imports/image/preview',
  'POST /tours/preview', 'POST /stops/:id/appointment/preview', 'POST /tours/:id/replan/preview',
  'POST /geocode/resolve'
]);

describe('CLAUDE.md rule 7: every mutating route writes the audit log', () => {
  it('has an audit call in each mutating handler of app.ts', () => {
    const source = readFileSync(new URL('../src/app.ts', import.meta.url), 'utf8');
    const starts = [...source.matchAll(/app\.(post|put|patch|delete)\(\s*['"]([^'"]+)['"]/g)];
    const missing: string[] = [];
    starts.forEach((match, index) => {
      const route = `${match[1].toUpperCase()} ${match[2]}`;
      const body = source.slice(match.index, starts[index + 1]?.index ?? source.length).split(/\n\s*app\.(get|register|addHook|setErrorHandler)\(/)[0];
      if (NOT_AUDITED.has(route)) return;
      if (!/\baudit\(|writeAuditLog\(|auditActor\(request\)/.test(body)) missing.push(route);
    });
    expect(missing).toEqual([]);
  });
});
