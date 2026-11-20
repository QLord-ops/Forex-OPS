import { describe, expect, it } from 'vitest';
import { isLocalDatabase } from '../src/cli/driver-code.js';

describe('local driver code command', () => {
  it('runs only against a database on this computer', () => {
    expect(isLocalDatabase('postgresql://ops@127.0.0.1:5432/ops')).toBe(true);
    expect(isLocalDatabase('postgres://ops:pw@localhost/ops')).toBe(true);
    expect(isLocalDatabase('postgresql://doadmin:pw@ops-disponent-prod-do-user-1.db.ondigitalocean.com:25060/defaultdb?sslmode=require')).toBe(false);
    expect(isLocalDatabase('postgresql://ops@127.0.0.1.example.com/ops')).toBe(false);
    expect(isLocalDatabase('file:./dev.db')).toBe(false);
    expect(isLocalDatabase(undefined)).toBe(false);
    expect(isLocalDatabase('not a url')).toBe(false);
  });
});
