import { describe, it, expect } from 'vitest';
import { createMigratedD1 } from '@inbox-angel/db/testing';
import { storeReport } from '../../src/dmarc/store-report';
import { makeTenant } from '../helpers/tenant';
import type { AggregateReport, ReportRecord } from '../../src/dmarc/types';

// ── Fixtures ──────────────────────────────────────────────────

function makeRecord(overrides: Partial<{
  ip: string;
  count: number;
  dkimResult: string;
  dkimDomain: string;
  spfResult: string;
  spfDomain: string;
  disposition: string;
  headerFrom: string;
}> = {}): ReportRecord {
  return {
    source: {
      ip: overrides.ip ?? '1.2.3.4',
      reverse_dns: null,
      base_domain: null,
      country_code: null,
      country_name: null,
      subdivision: null,
      city: null,
    },
    count: overrides.count ?? 1,
    alignment: { spf: true, dkim: true, dmarc: true },
    policy_evaluated: {
      disposition: (overrides.disposition ?? 'none') as any,
      dkim: (overrides.dkimResult ?? 'pass') as any,
      spf: (overrides.spfResult ?? 'pass') as any,
      policy_override_reasons: [],
    },
    identifiers: {
      header_from: overrides.headerFrom ?? 'example.com',
      envelope_from: null,
      envelope_to: null,
    },
    auth_results: {
      dkim: [{
        domain: overrides.dkimDomain ?? 'example.com',
        selector: 'sel',
        result: (overrides.dkimResult ?? 'pass') as any,
      }],
      spf: [{
        domain: overrides.spfDomain ?? 'example.com',
        scope: 'mfrom',
        result: (overrides.spfResult ?? 'pass') as any,
      }],
    },
  };
}

function makeReport(overrides: Partial<{
  orgName: string;
  reportId: string;
  beginDate: string;
  endDate: string;
  records: ReportRecord[];
}> = {}): AggregateReport {
  return {
    xml_schema: 'draft',
    report_metadata: {
      org_name: overrides.orgName ?? 'google.com',
      org_email: 'noreply@google.com',
      org_extra_contact_info: null,
      report_id: overrides.reportId ?? 'report-001',
      begin_date: overrides.beginDate ?? '2024-06-13T00:00:00Z',
      end_date: overrides.endDate ?? '2024-06-13T23:59:59Z',
      errors: [],
    },
    policy_published: {
      domain: 'example.com',
      adkim: 'r',
      aspf: 'r',
      p: 'reject',
      sp: 'reject',
      pct: 100,
      fo: '0',
    },
    records: overrides.records ?? [makeRecord()],
  };
}

// ── Real in-memory D1 ─────────────────────────────────────────

function makeDb() {
  const db = createMigratedD1();
  db.sqlite
    .prepare("INSERT INTO domains (id, domain, rua_address) VALUES (1, 'example.com', 'rua@reports.inboxangel.io')")
    .run();
  const reports = () => db.sqlite.prepare('SELECT * FROM aggregate_reports ORDER BY id').all() as Record<string, any>[];
  const records = () => db.sqlite.prepare('SELECT * FROM report_records ORDER BY id').all() as Record<string, any>[];
  return { db: db as unknown as D1Database, reports, records };
}

// ── Tests ─────────────────────────────────────────────────────

describe('storeReport', () => {
  it('returns stored=true and reportId on first insert', async () => {
    const { db, reports } = makeDb();
    const result = await storeReport(makeTenant({ db }), 1, makeReport());

    expect(result.stored).toBe(true);
    expect(result.reportId).toBe(reports()[0].id);
    expect(reports()).toHaveLength(1);
  });

  it('returns stored=false when INSERT OR IGNORE skips (duplicate report_id)', async () => {
    const { db, reports } = makeDb();
    await storeReport(makeTenant({ db }), 1, makeReport());
    const result = await storeReport(makeTenant({ db }), 1, makeReport());

    expect(result.stored).toBe(false);
    expect(result.reportId).toBeUndefined();
    expect(reports()).toHaveLength(1);
  });

  it('does not insert records when report was a duplicate', async () => {
    const { db, records } = makeDb();
    await storeReport(makeTenant({ db }), 1, makeReport());
    expect(records()).toHaveLength(1);
    await storeReport(makeTenant({ db }), 1, makeReport());

    expect(records()).toHaveLength(1);
  });

  it('inserts records batch when report is new', async () => {
    const report = makeReport({
      records: [makeRecord({ ip: '10.0.0.1' }), makeRecord({ ip: '10.0.0.2' })],
    });
    const { db, records } = makeDb();

    const result = await storeReport(makeTenant({ db }), 1, report);
    // one row per record, all linked to the new report
    expect(records()).toHaveLength(2);
    expect(records().map(r => r.source_ip)).toEqual(['10.0.0.1', '10.0.0.2']);
    expect(records().every(r => r.report_id === result.reportId)).toBe(true);
  });

  it('skips batch insert entirely when report has no records', async () => {
    const { db, reports, records } = makeDb();

    const report = makeReport({ records: [] });
    const result = await storeReport(makeTenant({ db }), 1, report);

    expect(result.stored).toBe(true);
    expect(reports()).toHaveLength(1);
    expect(records()).toHaveLength(0);
  });

  // ── count arithmetic ─────────────────────────────────────────

  it('computes total_count as sum of all record.count values', async () => {
    const { db, reports } = makeDb();
    const report = makeReport({
      records: [
        makeRecord({ count: 10 }),
        makeRecord({ count: 5 }),
        makeRecord({ count: 3 }),
      ],
    });
    await storeReport(makeTenant({ db }), 1, report);

    expect(reports()[0].total_count).toBe(18); // 10+5+3
  });

  it('counts pass_count weighted by message count (dkim pass)', async () => {
    const { db, reports } = makeDb();
    const report = makeReport({
      records: [
        makeRecord({ count: 10, dkimResult: 'pass', spfResult: 'fail' }), // passes
        makeRecord({ count: 5,  dkimResult: 'fail', spfResult: 'fail' }), // fails
        makeRecord({ count: 3,  dkimResult: 'fail', spfResult: 'pass' }), // passes (via SPF)
      ],
    });
    await storeReport(makeTenant({ db }), 1, report);

    const row = reports()[0];
    expect(row.total_count).toBe(18);
    expect(row.pass_count).toBe(13);  // pass: 10+3
    expect(row.fail_count).toBe(5);   // fail: 5
  });

  it('converts ISO date strings to unix timestamps', async () => {
    const { db, reports } = makeDb();
    const report = makeReport({
      beginDate: '2024-06-13T00:00:00Z',
      endDate:   '2024-06-13T23:59:59Z',
    });
    await storeReport(makeTenant({ db }), 1, report);

    expect(reports()[0].date_begin).toBe(1718236800); // 2024-06-13 00:00:00 UTC
    expect(reports()[0].date_end).toBe(1718323199);   // 2024-06-13 23:59:59 UTC
  });

  it('passes rawXml to the insert', async () => {
    const { db, reports } = makeDb();
    await storeReport(makeTenant({ db }), 1, makeReport(), '<xml>raw</xml>');
    expect(reports()[0].raw_xml).toBe('<xml>raw</xml>');
  });

  it('passes null rawXml when not provided', async () => {
    const { db, reports } = makeDb();
    await storeReport(makeTenant({ db }), 1, makeReport());
    expect(reports()[0].raw_xml).toBeNull();
  });

  it('maps record source_ip from source.ip', async () => {
    const { db, records } = makeDb();
    const report = makeReport({ records: [makeRecord({ ip: '192.168.1.100' })] });
    await storeReport(makeTenant({ db }), 1, report);

    expect(records()[0].source_ip).toBe('192.168.1.100');
  });

  it('handles record with no DKIM auth result gracefully (null fields)', async () => {
    const { db, records } = makeDb();
    const rec: ReportRecord = {
      ...makeRecord(),
      auth_results: { dkim: [], spf: [] }, // empty auth results
    };
    const report = makeReport({ records: [rec] });
    await storeReport(makeTenant({ db }), 1, report);

    // dkim_result and spf_result should be null (not crash)
    expect(records()[0].dkim_result).toBeNull();
    expect(records()[0].spf_result).toBeNull();
  });
});
