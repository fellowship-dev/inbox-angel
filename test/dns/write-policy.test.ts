import { describe, it, expect } from 'vitest';
import { assertDnsWriteAllowed, assertHostedDnsWrite, type DnsWrite } from '../../src/dns/write-policy';
import { CfRecordNotAllowedError } from '../../src/tenancy/cf-client';

const Z = 'acme.com';
const w = (o: Partial<DnsWrite>): DnsWrite => ({ method: 'POST', zoneName: Z, mode: 'saas', ...o });

describe('assertDnsWriteAllowed', () => {
  const allowed: [string, Partial<DnsWrite>][] = [
    ['DMARC TXT', { type: 'TXT', name: '_dmarc.acme.com', content: 'v=DMARC1; p=none' }],
    ['DMARC TXT on a subdomain', { type: 'TXT', name: '_dmarc.mail.acme.com', content: '"v=DMARC1; p=none"' }],
    ['MTA-STS TXT', { type: 'TXT', name: '_mta-sts.acme.com', content: 'v=STSv1; id=1' }],
    ['TLS-RPT TXT', { type: 'TXT', name: '_smtp._tls.acme.com', content: 'v=TLSRPTv1; rua=mailto:a@b.c' }],
    ['SPF at apex, quoted', { type: 'TXT', name: 'acme.com', content: '"v=spf1 include:x.test -all"' }],
    ['SPF on a subdomain', { type: 'TXT', name: 'mail.acme.com', content: 'v=spf1 -all' }],
    ['mta-sts CNAME to the policy host (case, trailing dot)', { type: 'CNAME', name: 'mta-sts.acme.com', content: 'W.workers.dev.', cnameTargets: ['w.workers.dev'] }],
    ['SPF at a listed apex', { type: 'TXT', name: 'acme.com', content: 'v=spf1 -all', allowedApexes: ['acme.com'] }],
    ['report authorization', { type: 'TXT', name: 'acme.org._report._dmarc.acme.com', content: 'v=DMARC1;' }],
    ['PATCH of content only', { method: 'PATCH', patchKeys: ['content'] }],
    ['PATCH keeping a managed name', { method: 'PATCH', patchKeys: ['name', 'type', 'content'], type: 'TXT', name: '_dmarc.acme.com', content: 'v=DMARC1; p=reject' }],
    ['DELETE', { method: 'DELETE' }],
    ['MX for email routing, self-host, relative name', { mode: 'selfhost', type: 'MX', name: 'reports', content: 'route1.mx.cloudflare.net' }],
  ];
  it.each(allowed)('allows %s', (_t, o) => {
    expect(() => assertDnsWriteAllowed(w(o))).not.toThrow();
  });

  const refused: [string, Partial<DnsWrite>][] = [
    ['A at the apex', { type: 'A', name: 'acme.com', content: '1.2.3.4' }],
    ['AAAA', { type: 'AAAA', name: 'mta-sts.acme.com', content: '100::' }],
    ['MX in saas', { type: 'MX', name: 'acme.com', content: 'route1.mx.cloudflare.net' }],
    ['MX to a foreign host in self-host', { mode: 'selfhost', type: 'MX', name: 'reports.acme.com', content: 'mail.evil.test' }],
    ['MX at the apex in self-host', { mode: 'selfhost', type: 'MX', name: 'acme.com', content: 'route1.mx.cloudflare.net' }],
    ['NS', { type: 'NS', name: 'sub.acme.com', content: 'ns.evil.test' }],
    ['DKIM CNAME to an attacker host', { type: 'CNAME', name: 's1._domainkey.acme.com', content: 'evil.example' }],
    ['DKIM CNAME even with targets given', { type: 'CNAME', name: 's1._domainkey.acme.com', content: 'w.workers.dev', cnameTargets: ['w.workers.dev'] }],
    ['BIMI TXT', { type: 'TXT', name: 'default._bimi.acme.com', content: 'v=BIMI1; l=https://x/y.svg' }],
    ['mta-sts CNAME to an attacker host', { type: 'CNAME', name: 'mta-sts.acme.com', content: 'attacker.example', cnameTargets: ['w.workers.dev'] }],
    ['mta-sts CNAME with no expected target', { type: 'CNAME', name: 'mta-sts.acme.com', content: 'w.workers.dev' }],
    ['hosted pointer CNAME', { type: 'CNAME', name: '_dmarc.acme.com', content: 'x._dmarc.h.example.io', cnameTargets: ['x._dmarc.h.example.io'] }],
    ['SPF at an underscore name', { type: 'TXT', name: '_x.acme.com', content: 'v=spf1 -all' }],
    ['SPF under _dmarc', { type: 'TXT', name: '_dmarc.acme.com', content: 'v=spf1 -all' }],
    ['SPF at a name not in allowedApexes', { type: 'TXT', name: 'random.acme.com', content: 'v=spf1 -all', allowedApexes: ['acme.com'] }],
    ['CNAME at the apex', { type: 'CNAME', name: 'acme.com', content: 'evil.test' }],
    ['CNAME at www', { type: 'CNAME', name: 'www.acme.com', content: 'evil.test' }],
    ['TXT at a random name', { type: 'TXT', name: 'random.acme.com', content: 'hello' }],
    ['TXT at the apex, not SPF', { type: 'TXT', name: 'acme.com', content: 'google-site-verification=abc' }],
    ['TXT at the apex, spf lookalike', { type: 'TXT', name: 'acme.com', content: 'v=spf10 -all' }],
    ['name outside the zone', { type: 'TXT', name: '_dmarc.evil.com', content: 'v=DMARC1;' }],
    ['relative name outside the zone (saas)', { type: 'TXT', name: '_dmarc', content: 'v=DMARC1;' }],
    ['wildcard name', { type: 'TXT', name: '*.acme.com', content: 'v=spf1 -all' }],
    ['path tricks in the name', { type: 'TXT', name: '_dmarc.acme.com/../..', content: 'v=DMARC1;' }],
    ['dot-dot label', { type: 'TXT', name: '..acme.com', content: 'v=spf1 -all' }],
    ['report authorization with other content', { type: 'TXT', name: 'acme.org._report._dmarc.acme.com', content: 'hello' }],
    ['no type', { name: '_dmarc.acme.com', content: 'v=DMARC1;' }],
    ['no content', { type: 'TXT', name: '_dmarc.acme.com' }],
    ['PATCH that renames to an unmanaged name', { method: 'PATCH', patchKeys: ['name', 'type', 'content'], type: 'TXT', name: 'www.acme.com', content: 'x' }],
    ['PATCH that renames without a type', { method: 'PATCH', patchKeys: ['name'], name: '_dmarc.acme.com' }],
    ['PATCH that retypes to A', { method: 'PATCH', patchKeys: ['type', 'name', 'content'], type: 'A', name: '_dmarc.acme.com', content: '1.1.1.1' }],
    ['PATCH with an unknown key', { method: 'PATCH', patchKeys: ['content', 'zone_id'] }],
    ['unknown method', { method: 'TRACE', type: 'TXT', name: '_dmarc.acme.com', content: 'v=DMARC1;' }],
  ];
  it.each(refused)('refuses %s', (_t, o) => {
    expect(() => assertDnsWriteAllowed(w(o))).toThrow(CfRecordNotAllowedError);
  });
});

describe('assertHostedDnsWrite', () => {
  const cfg = { recordsZone: 'inboxangel.io', recordsLabel: 'h' };
  const h = (o: Partial<DnsWrite>) => ({ method: 'POST', zoneName: 'inboxangel.io', ...o });
  it.each([
    ['TXT', { type: 'TXT', name: 'abc._dmarc.h.inboxangel.io' }],
    ['AAAA', { type: 'AAAA', name: 'mta-sts.abc.h.inboxangel.io' }],
    ['CNAME', { type: 'CNAME', name: 'abc._dmarc.h.inboxangel.io' }],
    ['PATCH content', { method: 'PATCH', patchKeys: ['content'] }],
    ['DELETE', { method: 'DELETE' }],
  ])('allows %s', (_t, o) => expect(() => assertHostedDnsWrite(h(o), cfg)).not.toThrow());
  it.each([
    ['the label apex', { type: 'TXT', name: 'h.inboxangel.io' }],
    ['the zone apex', { type: 'TXT', name: 'inboxangel.io' }],
    ['another name in the zone', { type: 'TXT', name: 'www.inboxangel.io' }],
    ['a lookalike label', { type: 'TXT', name: 'x.hh.inboxangel.io' }],
    ['A', { type: 'A', name: 'x.h.inboxangel.io' }],
    ['MX', { type: 'MX', name: 'x.h.inboxangel.io' }],
    ['NS', { type: 'NS', name: 'x.h.inboxangel.io' }],
    ['another zone', { type: 'TXT', name: 'x.h.inboxangel.io', zoneName: 'evil.com' }],
    ['an unknown zone', { type: 'TXT', name: 'x.h.inboxangel.io', zoneName: undefined }],
    ['a PATCH that renames out', { method: 'PATCH', patchKeys: ['name', 'type'], type: 'TXT', name: 'www.inboxangel.io' }],
  ])('refuses %s', (_t, o) => expect(() => assertHostedDnsWrite(h(o as Partial<DnsWrite>), cfg)).toThrow(CfRecordNotAllowedError));
  it('refuses everything when no zone is configured', () => {
    expect(() => assertHostedDnsWrite(h({ type: 'TXT', name: 'x.h.inboxangel.io' }), { recordsLabel: 'h' })).toThrow(CfRecordNotAllowedError);
  });
});
