import { describe, it, expect } from 'vitest';
import { lookupMtaSts, parseMtaStsPolicy, validateMtaStsPolicy, detectExistingMtaStsMode, buildPolicyFile, generatePolicyId } from '../src/mta-sts';
import { lookupBimi } from '../src/bimi';
import { fakeResolver, resp } from './helpers';

const POLICY = 'version: STSv1\nmode: enforce\nmx: mail.x.com\nmx: *.x.net\nmax_age: 604800\n';
const URL_ = 'https://mta-sts.x.com/.well-known/mta-sts.txt';

describe('mta-sts', () => {
  it('parses and validates a policy', () => {
    const p = parseMtaStsPolicy(POLICY);
    expect(p).toEqual({ version: 'STSv1', mode: 'enforce', mx: ['mail.x.com', '*.x.net'], maxAge: 604800 });
    expect(validateMtaStsPolicy(p)).toEqual([]);
    expect(validateMtaStsPolicy(parseMtaStsPolicy('mode: enforce\n')).length).toBeGreaterThan(2);
  });
  it('valid when TXT and policy are fine', async () => {
    const l = await lookupMtaSts(fakeResolver({ 'TXT _mta-sts.x.com': ['v=STSv1; id=20240101'] }, [], { [URL_]: resp(200, POLICY, { 'content-type': 'text/plain' }) }), 'x.com');
    expect(l.status).toBe('valid');
    expect(l.txt?.id).toBe('20240101');
    expect(l.policy?.mode).toBe('enforce');
  });
  it('none only for an authoritative miss', async () => {
    expect((await lookupMtaSts(fakeResolver({}), 'x.com')).status).toBe('none');
    expect((await lookupMtaSts(fakeResolver({ 'TXT _mta-sts.x.com': 'SERVFAIL' }), 'x.com')).status).toBe('error');
  });
  it('multiple TXT and missing id are invalid', async () => {
    expect((await lookupMtaSts(fakeResolver({ 'TXT _mta-sts.x.com': ['v=STSv1; id=1', 'v=STSv1; id=2'] }), 'x.com')).status).toBe('invalid');
    expect((await lookupMtaSts(fakeResolver({ 'TXT _mta-sts.x.com': ['v=STSv1'] }), 'x.com')).status).toBe('invalid');
  });
  it('HTTP 404 and redirects on the policy are invalid; network failure is an error', async () => {
    const txt = { 'TXT _mta-sts.x.com': ['v=STSv1; id=1'] };
    expect((await lookupMtaSts(fakeResolver(txt), 'x.com')).status).toBe('invalid'); // default 404
    expect((await lookupMtaSts(fakeResolver(txt, [], { [URL_]: resp(301, '') }), 'x.com')).issues[0]).toMatch(/redirect/i);
    expect((await lookupMtaSts(fakeResolver(txt, [], { [URL_]: new Error('ECONNREFUSED') }), 'x.com')).status).toBe('error');
  });
  it('requests the policy without following redirects', async () => {
    let seen: string | undefined;
    const base = fakeResolver({ 'TXT _mta-sts.x.com': ['v=STSv1; id=1'] });
    const resolver = { ...base, fetch: async (_u: string, init?: { redirect?: string }) => { seen = init?.redirect; return resp(200, POLICY); } };
    await lookupMtaSts(resolver as never, 'x.com');
    expect(seen).toBe('manual');
  });
  it('detectExistingMtaStsMode returns mode / null and throws on DNS error', async () => {
    const txt = { 'TXT _mta-sts.x.com': ['v=STSv1; id=1'] };
    expect(await detectExistingMtaStsMode(fakeResolver(txt, [], { [URL_]: resp(200, POLICY.replace('enforce', 'testing')) }), 'x.com')).toBe('testing');
    expect(await detectExistingMtaStsMode(fakeResolver({}), 'x.com')).toBeNull();
    await expect(detectExistingMtaStsMode(fakeResolver({ 'TXT _mta-sts.x.com': 'TIMEOUT' }), 'x.com')).rejects.toThrow(/lookup failed/);
  });
  it('builds a policy file and ids', () => {
    expect(buildPolicyFile('testing', ['a.x.com'], 86400)).toBe('version: STSv1\nmode: testing\nmx: a.x.com\nmax_age: 86400\n');
    expect(generatePolicyId(new Date('2024-05-06T07:08:09Z'))).toBe('20240506070809');
  });
});

describe('bimi', () => {
  const SVG = '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" version="1.2"></svg>';
  const rec = 'v=BIMI1; l=https://x.com/logo.svg; a=https://x.com/vmc.pem';
  it('finds the record and checks SVG and VMC presence', async () => {
    const l = await lookupBimi(fakeResolver({ 'TXT default._bimi.x.com': [rec] }, [], {
      'https://x.com/logo.svg': resp(200, SVG, { 'content-type': 'image/svg+xml' }),
      'https://x.com/vmc.pem': resp(200, '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----'),
    }), 'x.com');
    expect(l).toMatchObject({ status: 'found', logo: { status: 'present' }, vmc: { status: 'present', validated: false } });
  });
  it('flags missing/invalid assets', async () => {
    const l = await lookupBimi(fakeResolver({ 'TXT default._bimi.x.com': [rec] }, [], { 'https://x.com/logo.svg': resp(200, '<html></html>', { 'content-type': 'text/html' }) }), 'x.com');
    expect(l.logo.status).toBe('invalid');
    expect(l.vmc.status).toBe('missing');
  });
  it('no VMC tag → not-declared', async () => {
    const l = await lookupBimi(fakeResolver({ 'TXT default._bimi.x.com': ['v=BIMI1; l=https://x.com/logo.svg'] }, [], { 'https://x.com/logo.svg': resp(200, SVG) }), 'x.com');
    expect(l.vmc.status).toBe('not-declared');
  });
  it('rejects non-https assets', async () => {
    const l = await lookupBimi(fakeResolver({ 'TXT default._bimi.x.com': ['v=BIMI1; l=http://x.com/logo.svg'] }), 'x.com');
    expect(l.logo.status).toBe('invalid');
  });
  it('declination record, none, error, org-domain fallback (PSL aware)', async () => {
    expect((await lookupBimi(fakeResolver({ 'TXT default._bimi.x.com': ['v=BIMI1; l=;'] }), 'x.com')).status).toBe('declined');
    expect((await lookupBimi(fakeResolver({}), 'x.com')).status).toBe('none');
    expect((await lookupBimi(fakeResolver({ 'TXT default._bimi.x.com': 'SERVFAIL' }), 'x.com')).status).toBe('error');
    const calls: string[] = [];
    const l = await lookupBimi(fakeResolver({ 'TXT default._bimi.x.co.uk': ['v=BIMI1; l=;'] }, calls), 'mail.x.co.uk');
    expect(l.status).toBe('declined');
    expect(calls).not.toContain('TXT default._bimi.co.uk');
  });
  it('unreachable assets are reported as such', async () => {
    const l = await lookupBimi(fakeResolver({ 'TXT default._bimi.x.com': [rec] }, [], { 'https://x.com/logo.svg': new Error('boom') }), 'x.com');
    expect(l.logo.status).toBe('unreachable');
  });
});
