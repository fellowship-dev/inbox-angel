// The registry data, its matching rules, the operator's extension and disable variables, and the carrier / tier decisions built on it.
import { describe, it, expect } from 'vitest';
import { KNOWN_REPORTERS, NAMED_BUT_UNVERIFIED, effectiveRegistry, parseOperatorEntries, registryCandidates, reportEmailAccepted } from '../../src/dmarc/known-reporters';
import { carrierFromHeaders, decideTier } from '../../src/dmarc/reporter-auth';
import { describeAuthStatus, AUTH_TEXT } from '../../src/reports/auth-status';

const ID = 'mx.cloudflare.net';
const env = { AUTHSERV_ID: ID, AUTHSERV_HEADER: 'ar' };
const hdr = (results: string, from: string | null) => ({ ar: `${ID}; ${results}`, arc: null, from });

describe('registry data', () => {
  it('ids are unique and lowercase; every entry has evidence, a verification date, a DKIM org, a From and a report email rule', () => {
    expect(new Set(KNOWN_REPORTERS.map((e) => e.id)).size).toBe(KNOWN_REPORTERS.length);
    for (const e of KNOWN_REPORTERS) {
      expect(e.id).toMatch(/^[a-z0-9-]+$/);
      expect(e.evidence.length, e.id).toBeGreaterThan(0);
      expect(e.verified, e.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(e.dkimOrgs.length && e.from.length, e.id).toBeTruthy();
      expect(e.reportEmails.length + (e.reportEmailDomains?.length ?? 0), e.id).toBeGreaterThan(0);
      for (const d of e.dkimOrgs) expect(d, e.id).toBe(d.toLowerCase());
    }
  });
  it('lists the verified reporters and none of the named-but-unverified ones', () => {
    expect(KNOWN_REPORTERS.map((e) => e.id).sort()).toEqual(['amazon-ses', 'fastmail', 'google', 'mailru', 'microsoft', 'mimecast', 'xs4all', 'yahoo']);
    for (const n of NAMED_BUT_UNVERIFIED) expect(KNOWN_REPORTERS.some((e) => e.label.toLowerCase().includes(n.org.toLowerCase().split(' ')[0])), n.org).toBe(false);
  });
  it('a shared sending domain (amazonses.com) matches only its exact From address', () => {
    expect(registryCandidates('amazonses.com', 'postmaster@amazonses.com', {}).map((e) => e.id)).toEqual(['amazon-ses']);
    expect(registryCandidates('amazonses.com', 'attacker@amazonses.com', {})).toEqual([]);
  });
});

describe('matching', () => {
  it('needs the DKIM organisation AND the From address of the same entry', () => {
    expect(registryCandidates('google.com', 'noreply-dmarc-support@google.com', {}).map((e) => e.id)).toEqual(['google']);
    expect(registryCandidates('google.com', 'noreply@dmarc.yahoo.com', {})).toEqual([]);
    expect(registryCandidates('yahoo.com', 'noreply-dmarc-support@google.com', {})).toEqual([]);
    expect(registryCandidates(null, 'noreply-dmarc-support@google.com', {})).toEqual([]);
  });
  it('wildcard From: one or more labels, never the bare domain, never another local part', () => {
    expect(registryCandidates('mimecastreport.com', 'no-reply@au-1.mimecastreport.com', {}).map((e) => e.id)).toEqual(['mimecast']);
    expect(registryCandidates('mimecastreport.com', 'no-reply@mimecastreport.com', {})).toEqual([]);
    expect(registryCandidates('mimecastreport.com', 'x@au-1.mimecastreport.com', {})).toEqual([]);
    expect(registryCandidates('mimecastreport.com', 'no-reply@au-1.mimecastreport.com.evil.example', {})).toEqual([]);
  });
  it('the report email must be in the accepted set (Yahoo accepted both of its addresses over time); org_name is never consulted', () => {
    const yahoo = KNOWN_REPORTERS.find((e) => e.id === 'yahoo')!;
    expect(reportEmailAccepted(yahoo, 'dmarchelp@yahooinc.com')).toBe(true);
    expect(reportEmailAccepted(yahoo, 'POSTMASTER@dmarc.yahoo.com')).toBe(true);
    expect(reportEmailAccepted(yahoo, 'someone@yahoo.com')).toBe(false);
    expect(reportEmailAccepted(yahoo, null)).toBe(false);
    const mc = KNOWN_REPORTERS.find((e) => e.id === 'mimecast')!;
    expect(reportEmailAccepted(mc, 'dmarc@us-1.mimecastreport.com')).toBe(true);
    expect(reportEmailAccepted(mc, 'dmarc@mimecastreport.com.evil.example')).toBe(false);
  });
});

describe('operator variables', () => {
  const line = 'acme|Acme Receiver|acme-mail.com|dmarc@acme-mail.com|dmarc@acme-mail.com';
  it('INTAKE_KNOWN_REPORTERS adds an entry; INTAKE_KNOWN_REPORTERS_DISABLE removes built-in ones', () => {
    expect(effectiveRegistry({ INTAKE_KNOWN_REPORTERS: line }).map((e) => e.id)).toContain('acme');
    const off = effectiveRegistry({ INTAKE_KNOWN_REPORTERS_DISABLE: 'Yahoo, fastmail' }).map((e) => e.id);
    expect(off).not.toContain('yahoo');
    expect(off).not.toContain('fastmail');
    expect(off).toContain('google');
    expect(registryCandidates('acme-mail.com', 'dmarc@acme-mail.com', { INTAKE_KNOWN_REPORTERS: line }).map((e) => e.id)).toEqual(['acme']);
    expect(registryCandidates('yahoo.com', 'noreply@dmarc.yahoo.com', { INTAKE_KNOWN_REPORTERS_DISABLE: 'yahoo' })).toEqual([]);
  });
  it('a malformed entry is ignored and named in `issues`; several entries may be separated by ; or newlines', () => {
    const p = parseOperatorEntries(`${line};broken|x;bad|B|not a domain|a@b.example|a@b.example\n${line.replace('acme', 'two')}`);
    expect(p.entries.map((e) => e.id)).toEqual(['acme', 'two']);
    expect(p.issues).toHaveLength(2);
    expect(parseOperatorEntries(undefined)).toEqual({ entries: [], issues: [] });
  });
});

describe('carrier and tier decisions', () => {
  const google = { email: 'noreply-dmarc-support@google.com' };
  it('an aligned DKIM pass from a registry sender, with the accepted report email, is counted', () => {
    const c = carrierFromHeaders(hdr('dkim=pass header.d=google.com', 'noreply-dmarc-support@google.com'), env);
    expect(c).toMatchObject({ class: 'registry', authenticated: true, via: 'dkim', dkimOrg: 'google.com' });
    expect(decideTier(c, google)).toMatchObject({ tier: 'counted', identity: 'google', knownAs: 'Google', emailMatched: true, auth: 'pass', reason: null });
  });
  it('alignment is relaxed: a subdomain signature and a subdomain From still align (Microsoft, Yahoo)', () => {
    const ms = carrierFromHeaders(hdr('dkim=pass header.d=notification.microsoft.com', 'dmarcreport@microsoft.com'), env);
    expect(decideTier(ms, { email: 'dmarcreport@microsoft.com' }).tier).toBe('counted');
    const y = carrierFromHeaders(hdr('dkim=pass header.d=yahoo.com', 'noreply@dmarc.yahoo.com'), env);
    expect(decideTier(y, { email: 'dmarchelp@yahooinc.com' }).tier).toBe('counted');
  });
  it('SPF alone never authenticates', () => {
    const c = carrierFromHeaders(hdr('spf=pass smtp.mailfrom=google.com', 'noreply-dmarc-support@google.com'), env);
    expect(c).toMatchObject({ class: 'unauthenticated', authenticated: false, reason: 'not_authenticated' });
    expect(decideTier(c, google)).toMatchObject({ tier: 'unauthenticated', identity: '~unauth', auth: 'fail' });
  });
  it('a DKIM pass for a domain other than the From organisation does not authenticate the From', () => {
    expect(carrierFromHeaders(hdr('dkim=pass header.d=evil.example', 'noreply-dmarc-support@google.com'), env).authenticated).toBe(false);
  });
  it('a dmarc=pass aligned with the From authenticates (but is not a registry match without the DKIM organisation)', () => {
    const c = carrierFromHeaders(hdr('dmarc=pass header.from=example.org', 'dmarc@example.org'), env);
    expect(c).toMatchObject({ class: 'authenticated', via: 'dmarc' });
    expect(decideTier(c, { email: 'dmarc@example.org' })).toMatchObject({ tier: 'unknown', identity: 'example.org', reason: 'not_in_registry' });
  });
  it('an authenticated stranger naming Google in the XML is not Google, and not unknown either: its identity is inconsistent', () => {
    const c = carrierFromHeaders(hdr('dkim=pass header.d=evil.example', 'x@evil.example'), env);
    expect(decideTier(c, google)).toMatchObject({ tier: 'unauthenticated', reason: 'inconsistent_identity', auth: 'fail' });
  });
  it('a registry sender whose report email is not accepted is stored as unknown (drift is never silently trusted)', () => {
    const c = carrierFromHeaders(hdr('dkim=pass header.d=google.com', 'noreply-dmarc-support@google.com'), env);
    expect(decideTier(c, { email: 'new-address@google.com' })).toMatchObject({ tier: 'unknown', identity: 'google', emailMatched: false, reason: 'registry_email_not_accepted' });
  });
  it('fails closed: AUTHSERV unset, no header, another authserv-id, the other header kind, no or several From addresses', () => {
    const r = 'dkim=pass header.d=google.com';
    const from = 'noreply-dmarc-support@google.com';
    expect(carrierFromHeaders(hdr(r, from), {})).toMatchObject({ authenticated: false, reason: 'authserv_unconfigured', presence: 'unconfigured' });
    expect(carrierFromHeaders({ ar: null, arc: null, from }, env)).toMatchObject({ reason: 'no_authentication_results', presence: 'absent' });
    expect(carrierFromHeaders({ ar: `other.example; ${r}`, arc: null, from }, env)).toMatchObject({ reason: 'authserv_id_not_found', presence: 'foreign' });
    expect(carrierFromHeaders({ ar: null, arc: `i=1; ${ID}; ${r}`, from }, env).authenticated).toBe(false); // AUTHSERV_HEADER=ar ignores ARC
    expect(carrierFromHeaders({ ar: null, arc: `i=1; ${ID}; ${r}`, from }, { ...env, AUTHSERV_HEADER: 'arc' }).authenticated).toBe(true);
    expect(carrierFromHeaders(hdr(r, null), env)).toMatchObject({ authenticated: false, reason: 'from_invalid' });
  });
});

describe('describeAuthStatus (the instance owner\'s "can anything be counted?")', () => {
  const o = (x: Partial<{ configured: boolean; ok: number; present: number; absent: number; foreign: number }>) => ({ configured: true, ok: 0, present: 0, absent: 0, foreign: 0, ...x });
  it('says why nothing can be counted, in plain words', () => {
    expect(describeAuthStatus(o({ configured: false })).text).toBe('No report can be counted until AUTHSERV_ID and AUTHSERV_HEADER are set.');
    expect(describeAuthStatus(o({ absent: 4 })).text).toBe('No report can be counted: inbound mail carries no authentication results.');
    expect(describeAuthStatus(o({ foreign: 4 })).text).toBe('No report can be counted: the authentication results on inbound mail do not name the configured AUTHSERV_ID.');
    expect(describeAuthStatus(o({ present: 3 })).text).toBe(AUTH_TEXT.unauthenticated_only);
  });
  it('is silent when something authenticated, or nothing has arrived', () => {
    expect(describeAuthStatus(o({ ok: 1, absent: 9 })).text).toBeNull();
    expect(describeAuthStatus(o({})).kind).toBe('no_traffic');
  });
});
