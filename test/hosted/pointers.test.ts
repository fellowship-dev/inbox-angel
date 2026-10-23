import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { levelInputs, mergePointerReport, verifyPointers } from '../../src/hosted/pointers';
import { verifyAllPointers } from '../../src/hosted/cron';
import { hostedNames } from '../../src/hosted/records';
import { verifyDomainPointers } from '../../src/hosted/service';
import { makeTenant } from '../helpers/tenant';
import { dnsFrom, type DnsName } from './dns';
import { HOSTED_ENV, NOW, quiet, twoWorkspaces } from './world';

const ID = 'abcdefghijklmnop';
const APEX = 'h.inboxangel.io';
const N = hostedNames(ID, APEX);

const inPlace = (): Record<string, DnsName> => ({
  '_dmarc.a-corp.com': { CNAME: N.dmarc },
  'a-corp.com': { TXT: [`v=spf1 include:_spf.google.com include:${N.spf} -all`] },
  '_mta-sts.a-corp.com': { CNAME: N.mtaSts },
  '_smtp._tls.a-corp.com': { CNAME: N.tlsRpt },
});

beforeEach(() => quiet());
afterEach(() => vi.restoreAllMocks());

describe('pointer verification', () => {
  it('ok when the CNAMEs and the SPF include are in place', async () => {
    expect(await verifyPointers('a-corp.com', ID, APEX, dnsFrom(inPlace()))).toEqual({ dmarc: 'ok', spf: 'ok', mta_sts: 'ok', tls_rpt: 'ok' });
  });

  it('is case- and trailing-dot-insensitive', async () => {
    const t = inPlace();
    t['_dmarc.a-corp.com'] = { CNAME: N.dmarc.toUpperCase() };
    expect((await verifyPointers('A-Corp.com.', ID, APEX, dnsFrom(t))).dmarc).toBe('ok');
  });

  it('missing when nothing is published (NXDOMAIN, or the name exists with nothing relevant)', async () => {
    const r = await verifyPointers('a-corp.com', ID, APEX, dnsFrom({ 'a-corp.com': { TXT: ['google-site-verification=x'] }, '_smtp._tls.a-corp.com': {} }));
    expect(r).toEqual({ dmarc: 'missing', spf: 'missing', mta_sts: 'missing', tls_rpt: 'missing' });
  });

  it('wrong when something else is there', async () => {
    const r = await verifyPointers('a-corp.com', ID, APEX, dnsFrom({
      '_dmarc.a-corp.com': { CNAME: 'otherid._dmarc.h.inboxangel.io' },        // someone else's hosted id
      'a-corp.com': { TXT: ['v=spf1 include:_spf.google.com -all'] },            // SPF without our include
      '_mta-sts.a-corp.com': { TXT: ['v=STSv1; id=1'] },                          // a TXT where the CNAME should be
      '_smtp._tls.a-corp.com': { CNAME: 'tls.elsewhere.example' },
    }));
    expect(r).toEqual({ dmarc: 'wrong', spf: 'wrong', mta_sts: 'wrong', tls_rpt: 'wrong' });
  });

  it('an own DMARC TXT where the CNAME should be is wrong, not missing', async () => {
    const r = await verifyPointers('a-corp.com', ID, APEX, dnsFrom({ ...inPlace(), '_dmarc.a-corp.com': { TXT: ['v=DMARC1; p=none'] } }));
    expect(r.dmarc).toBe('wrong');
  });

  it('error (not missing) when the DNS cannot be read', async () => {
    const r = await verifyPointers('a-corp.com', ID, APEX, dnsFrom({ ...inPlace(), '_dmarc.a-corp.com': { error: true }, 'a-corp.com': { error: true } }));
    expect(r).toMatchObject({ dmarc: 'error', spf: 'error', mta_sts: 'ok' });
  });

  it('a failed lookup keeps the last known status', () => {
    const prev = { dmarc_pointer: 'ok', spf_pointer: 'missing', mta_sts_pointer: null, tls_rpt_pointer: null };
    expect(mergePointerReport(prev, { dmarc: 'error', spf: 'ok', mta_sts: 'error', tls_rpt: 'wrong' }))
      .toEqual({ dmarc_pointer: 'ok', spf_pointer: 'ok', mta_sts_pointer: 'error', tls_rpt_pointer: 'wrong' });
  });

  it('feeds the Level: a hosted record counts as published only once its pointer is ok', () => {
    expect(levelInputs({ dmarc: 'ok', spf: 'wrong', mta_sts: null })).toEqual({ dmarc_published: true, spf_published: false, mta_sts_published: false });
  });
});

describe('stored status', () => {
  async function seed() {
    const w = await twoWorkspaces();
    w.db.sqlite.prepare("INSERT INTO hosted_domains (domain_id, workspace_id, hosted_id, zone_key) VALUES (1, 'ws_a', ?, 'z1'), (2, 'ws_b', 'bbbbbbbbbbbbbbbb', 'z1')").run(ID);
    return w;
  }

  it('verifyDomainPointers stores the answers and the time, for that domain only', async () => {
    const w = await seed();
    const tenant = makeTenant({ db: w.db, workspaceId: 'ws_a', env: HOSTED_ENV as any });
    const domain = (await tenant.scope.domains.getById(1))!;
    const view = await verifyDomainPointers(tenant, domain, { resolver: dnsFrom(inPlace()), now: () => NOW * 1000 });
    expect(view.pointer_status).toEqual({ dmarc: 'ok', spf: 'ok', mta_sts: 'ok', tls_rpt: 'ok', checked_at: NOW });
    expect(view.level_inputs).toEqual({ dmarc_published: true, spf_published: true, mta_sts_published: true });
    expect(w.rows('SELECT domain_id, dmarc_pointer, pointers_checked_at FROM hosted_domains ORDER BY 1')).toEqual([
      { domain_id: 1, dmarc_pointer: 'ok', pointers_checked_at: NOW },
      { domain_id: 2, dmarc_pointer: null, pointers_checked_at: null },
    ]);
  });

  it('the daily job checks every hosted domain in every workspace', async () => {
    const w = await seed();
    const resolver = dnsFrom({ ...inPlace(), '_dmarc.b-corp.org': { CNAME: hostedNames('bbbbbbbbbbbbbbbb', APEX).dmarc } });
    expect(await verifyAllPointers(w.env, { resolver, now: () => NOW * 1000 })).toBe(2);
    expect(w.rows('SELECT domain_id, dmarc_pointer, spf_pointer FROM hosted_domains ORDER BY 1')).toEqual([
      { domain_id: 1, dmarc_pointer: 'ok', spf_pointer: 'ok' },
      { domain_id: 2, dmarc_pointer: 'ok', spf_pointer: 'missing' },
    ]);
  });
});
