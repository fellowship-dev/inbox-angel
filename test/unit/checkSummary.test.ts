import { describe, it, expect } from 'vitest';
import { createMigratedD1 } from '@ready-set-mail/db/testing';
import { forWorkspace, IMPLICIT_WORKSPACE_ID } from '@ready-set-mail/db';

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
    total_count: 1000, pass_count: 980, fail_count: 20, raw_xml: null, reporter_auth: 'pass', reporter_tier: 'counted',
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
    // One report of 1,000 messages with two records: the totals are the report's, not multiplied by its records.
    expect(await q.reports.checkSummary(id, NOW - 30 * 86400)).toEqual({
      domain_id: id, domain: 'example.com', dmarc_policy: 'reject', spf_record: 'v=spf1 ~all', dns_checked_at: null, dns_check_attempted_at: null, dns_check_status: null, dmarc_issue: null, dmarc_inherited_from: null, dns_last_good_status: null,
      total_messages: 1000, pass_messages: 980, fail_messages: 20,
      dkim_total: 1000, dkim_pass: 950, spf_total: 1000, spf_pass: 950,
      mta_sts_enabled: 0, mta_sts_mode: null, spf_lookup_count: null, dmarc_pct: null, dmarc_sp: null,
    });
  });

  it('counts each report once however many records it has, and records once however many reports there are', async () => {
    const { q, id } = await seed();
    const rep = await q.reports.insertAggregate({
      domain_id: id, org_name: 'microsoft', report_id: 'r2', date_begin: NOW - 3600, date_end: NOW,
      total_count: 300, pass_count: 290, fail_count: 10, raw_xml: null,
    });
    await q.reports.insertRecords([
      { report_id: Number(rep.meta.last_row_id), source_ip: '3.3.3.3', count: 100, disposition: 'none', dkim_result: 'pass', spf_result: 'fail', dkim_domain: null, spf_domain: null, header_from: 'example.com' },
      { report_id: Number(rep.meta.last_row_id), source_ip: '4.4.4.4', count: 100, disposition: 'none', dkim_result: 'pass', spf_result: 'pass', dkim_domain: null, spf_domain: null, header_from: 'example.com' },
      { report_id: Number(rep.meta.last_row_id), source_ip: '5.5.5.5', count: 100, disposition: 'none', dkim_result: 'fail', spf_result: 'pass', dkim_domain: null, spf_domain: null, header_from: 'example.com' },
    ]);
    expect(await q.reports.checkSummary(id, NOW - 30 * 86400)).toMatchObject({
      total_messages: 1300, pass_messages: 1270, fail_messages: 30,
      dkim_total: 1300, dkim_pass: 1150, spf_total: 1300, spf_pass: 1150,
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

  it('carries the stored pct=, sp= and SPF lookup count the overview needs', async () => {
    const { db, q, id } = await seed();
    await q.domains.recordDnsCheck(id, { spf_record: 'v=spf1 ~all', dmarc: { policy: 'reject', issue: null, inherited_from: null, pct: 10, sp: 'none' }, at: NOW });
    db.sqlite.prepare('UPDATE domains SET spf_lookup_count = 12 WHERE id = ?').run(id);
    expect(await q.reports.checkSummary(id, 0)).toMatchObject({ dmarc_pct: 10, dmarc_sp: 'none', spf_lookup_count: 12 });
  });
});

describe('reports.checkSummaries (the overview batch)', () => {
  it('returns every live domain of the workspace in id order, a page at a time, with the same totals as checkSummary', async () => {
    const { db, q, id } = await seed();
    const ids = [id];
    for (const d of ['b.com', 'c.com', 'd.com']) ids.push(Number((await q.domains.insert({ domain: d, rua_address: 'rua@r.test' })).meta.last_row_id));
    db.sqlite.prepare("UPDATE domains SET evicted_at = 1 WHERE domain = 'c.com'").run();
    const since = NOW - 30 * 86400;
    const first = await q.reports.checkSummaries(since, { limit: 2 });
    expect(first.map((r) => r.domain)).toEqual(['example.com', 'b.com']);
    expect(first[0]).toEqual(await q.reports.checkSummary(id, since));
    const second = await q.reports.checkSummaries(since, { afterId: first.at(-1)!.domain_id, limit: 2 });
    expect(second.map((r) => r.domain)).toEqual(['d.com']);
    expect(second[0]).toMatchObject({ total_messages: 0, dkim_total: 0 });
  });

  it('never returns another workspace\'s domains', async () => {
    const { db } = await seed();
    db.sqlite.exec("INSERT INTO workspaces (id, name) VALUES ('ws_b', 'B')");
    expect(await forWorkspace(db, 'ws_b').reports.checkSummaries(0, { limit: 50 })).toEqual([]);
  });
});
