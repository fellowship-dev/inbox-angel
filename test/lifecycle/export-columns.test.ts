// A column added to an exported table must be decided on: exported, or excluded with a reason. Fails until it is.
import { describe, it, expect } from 'vitest';
import { createMigratedD1 } from '@inbox-angel/db/testing';
import { EXPORT_COLUMNS, EXPORT_EXCLUDED, EXPORT_SETTING_KEYS } from '@inbox-angel/db';

describe('export column coverage', () => {
  const db = createMigratedD1();
  for (const table of Object.keys(EXPORT_COLUMNS) as Array<keyof typeof EXPORT_COLUMNS>) {
    it(`${table}: every column is exported or deliberately excluded`, () => {
      const actual = (db.sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(c => c.name).sort();
      const decided = [...EXPORT_COLUMNS[table], ...EXPORT_EXCLUDED[table]].sort();
      expect(decided).toEqual(actual);
    });
  }

  it('no secret-looking column or setting key is exported', () => {
    for (const cols of Object.values(EXPORT_COLUMNS)) for (const c of cols) expect(c).not.toMatch(/password|secret|token|key_hash|envelope|raw_/);
    for (const k of EXPORT_SETTING_KEYS) expect(k).not.toMatch(/secret|token|private|api_key/);
  });
});
