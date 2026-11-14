// D1 limits (https://developers.cloudflare.com/d1/platform/limits/, read 2026-11-13): max string/BLOB/row 2,000,000 bytes, max SQL
// statement 100,000 bytes, max bound parameters 100 per query. Batched report storage must stay inside all three for the largest
// report an operator can allow.
import { describe, it, expect } from 'vitest';
import { SQLiteAsyncDialect } from 'drizzle-orm/sqlite-core';
import { byteLength, chunkJson, JSON_PARAM_MAX_BYTES, storeStatements, type RecordTuple, SQL_MAX_BYTES } from '@ready-set-mail/db';

const dialect = new SQLiteAsyncDialect();
const D1_MAX_VALUE_BYTES = 2_000_000;
const D1_MAX_PARAMS = 100;

/** The widest row the parser lets through: every stored string at its cap (domains 253, selectors/reasons 512), multi-byte text. */
const wide = (i: number): RecordTuple => {
  const euro = (n: number) => '€'.repeat(n); // 3 bytes each in UTF-8
  return [`2001:db8::${i.toString(16)}`.padEnd(45, '1'), 2_147_483_647, 'quarantine', 'fail', euro(253), 'fail', euro(253), euro(253), euro(253), euro(253), 'ZZ', euro(512)];
};
const narrow = (i: number): RecordTuple => [`203.0.${(i >> 8) & 255}.${i & 255}`, 1, 'none', 'pass', 'a.example', 'pass', 'a.example', 'a.example', null, null, null, null];

const report = { org_name: 'google.com', report_id: 'r', date_begin: 1, date_end: 2, total_count: 1, pass_count: 1, fail_count: 0, raw_xml: null, reporter_auth: 'pass', reporter_auth_domain: 'google.com', reporter_auth_reason: null };

describe('storing a report stays inside D1 limits', () => {
  it.each([
    ['20,000 typical records (the largest count an operator can allow)', 20_000, narrow],
    ['5,000 widest-possible records (the default cap, every field at its limit, multi-byte)', 5_000, wide],
    ['20,000 widest-possible records (far more than the decompressed cap would let through)', 20_000, wide],
  ])('%s: every bound JSON text < 1 MB (limit 2 MB), every statement < 100 KB with ≤ 100 parameters', (_n, count, row) => {
    const records = Array.from({ length: count }, (_, i) => row(i));
    const stmts = storeStatements({ workspaceId: 'ws_a', domainId: 1, report, records, ingestToken: 'tok', day: '2026-11-14' }).map((s) => dialect.sqlToQuery(s));
    let jsonChunks = 0;
    let rows = 0;
    for (const { sql, params } of stmts) {
      expect(byteLength(sql), 'SQL text').toBeLessThan(SQL_MAX_BYTES);
      expect(byteLength(sql), 'SQL text is short and fixed').toBeLessThan(5_000);
      expect(params.length).toBeLessThanOrEqual(D1_MAX_PARAMS);
      for (const p of params) if (typeof p === 'string') {
        expect(byteLength(p), 'one bound value').toBeLessThanOrEqual(JSON_PARAM_MAX_BYTES);
        expect(byteLength(p)).toBeLessThan(D1_MAX_VALUE_BYTES);
        if (p.startsWith('[[')) { jsonChunks++; rows += (JSON.parse(p) as unknown[]).length; }
      }
    }
    expect(rows).toBe(count); // every record is in exactly one chunk
    expect(jsonChunks).toBeGreaterThanOrEqual(Math.ceil(JSON.stringify(records).length / D1_MAX_VALUE_BYTES));
    expect(stmts.length).toBeLessThan(1000); // a single batch() of at most this many statements; the budget test pins the real one
    // eslint-disable-next-line no-console
    console.info(`[G4 chunks] ${_n}: ${stmts.length} statements, ${jsonChunks} JSON chunks`);
  });

  it('chunkJson: text sizes are counted in UTF-8 bytes, not characters, and nothing is lost or reordered', () => {
    const rows = Array.from({ length: 1000 }, (_, i) => [i, '€'.repeat(100)]);
    const chunks = chunkJson(rows, 10_000);
    expect(chunks.length).toBeGreaterThan(10);
    for (const c of chunks) expect(byteLength(c)).toBeLessThanOrEqual(10_000);
    expect(chunks.flatMap((c) => JSON.parse(c) as unknown[][]).map((r) => r[0])).toEqual(rows.map((r) => r[0]));
    expect(chunkJson([])).toEqual([]);
  });

  it('a duplicate report inserts no records: they are joined on this attempt\'s ingest token', () => {
    const [, first] = storeStatements({ workspaceId: 'ws_a', domainId: 1, report, records: [narrow(1)], ingestToken: 'tok', day: '2026-11-14' }).map((s) => dialect.sqlToQuery(s));
    expect(first.sql).toMatch(/JOIN \(SELECT id FROM aggregate_reports WHERE workspace_id = \? AND domain_id = \? AND report_id = \? AND ingest_token = \?\)/);
    expect(first.params).toContain('tok');
  });
});
