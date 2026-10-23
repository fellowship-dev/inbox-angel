import { describe, it, expect } from 'vitest';
import { createMigratedD1 } from '@inbox-angel/db/testing';
import { forWorkspace, IMPLICIT_WORKSPACE_ID } from '@inbox-angel/db';

const NOW = Math.floor(Date.now() / 1000);

async function seed() {
  const db = createMigratedD1();
  const q = forWorkspace(db, IMPLICIT_WORKSPACE_ID);
  const { meta } = await q.domains.insert({ domain: 'example.com', rua_address: 'rua@r.test' });
  const id = Number(meta.last_row_id);
  await q.domains.updateDmarcPolicy(id, 'reject');
  db.sqlite.prepare("UPDATE domains SET spf_record = 'v=spf1 ~all' WHERE id = ?").run(id);
  const rep = await q.reports.insertAggregate({
    domain_id: id, org_name: 'google', report_id: 'r1', date_begin: NOW - 86400, date_end: NOW,
    total_count: 1000, pass_count: 980, fail_count: 20, raw_xml: null,
  });
  await q.reports.insertRecords([
    { report_id: Number(rep.meta.last_row_id), source_ip: '1.1.1.1', count: 950, disposition: 'none', dkim_result: 'pass', spf_result: 'pass', dkim_domain: null, spf_domain: null, header_from: 'example.com' },
    { report_id: Number(rep.meta.last_row_id), source_ip: '2.2.2.2', count: 50, disposition: 'reject', dkim_result: 'fail', spf_result: 'fail', dkim_domain: null, spf_domain: null, header_from: 'example.com' },
  ]);
  return { db, q, id };
}

describe('reports.checkSummary', () => {
  it('summarises DMARC pass/fail and DKIM/SPF rates for the window', async () => {
    const { q, id } = await seed();
    // NOTE: carried over unchanged from the original query. The report totals are SUMmed over a join
    // with report_records, so they are multiplied by the number of records in each report (2 here).
    // Fixing that is a behaviour change, deliberately out of scope for the db lane.
    expect(await q.reports.checkSummary(id, NOW - 30 * 86400)).toEqual({
      domain_id: id, domain: 'example.com', dmarc_policy: 'reject', spf_record: 'v=spf1 ~all',
      total_messages: 2000, pass_messages: 1960, fail_messages: 40,
      dkim_total: 1000, dkim_pass: 950, spf_total: 1000, spf_pass: 950,
      mta_sts_enabled: 0, mta_sts_mode: null,
    });
  });

  it('ignores reports older than `since`', async () => {
    const { q, id } = await seed();
    expect(await q.reports.checkSummary(id, NOW + 1)).toMatchObject({ total_messages: 0, dkim_total: 0 });
  });

  it('includes MTA-STS state', async () => {
    const { q, id } = await seed();
    await q.mtaSts.insert({ domain_id: id, mode: 'enforce', mx_hosts: '[]', policy_id: 'p', mta_sts_record_id: null, tls_rpt_record_id: null, cname_record_id: null });
    expect(await q.reports.checkSummary(id, 0)).toMatchObject({ mta_sts_enabled: 1, mta_sts_mode: 'enforce' });
  });

  it('returns null when the domain does not exist', async () => {
    const { q } = await seed();
    expect(await q.reports.checkSummary(999, 0)).toBeNull();
  });

  it('returns null for a domain owned by another workspace', async () => {
    const { db, id } = await seed();
    db.sqlite.exec("INSERT INTO workspaces (id, name) VALUES ('ws_b', 'B')");
    expect(await forWorkspace(db, 'ws_b').reports.checkSummary(id, 0)).toBeNull();
  });
});
