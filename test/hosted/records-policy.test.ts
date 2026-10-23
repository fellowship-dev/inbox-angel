import { describe, it, expect, vi } from 'vitest';
import { openHostedZone } from '../../src/hosted/records';
import { CfRecordNotAllowedError } from '../../src/tenancy/cf-client';

const ENV = { HOSTED_RECORDS_TOKEN: 'tok', HOSTED_RECORDS_ZONE: 'inboxangel.io' } as any;

async function open() {
  const calls: { method: string; url: string }[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ method: init?.method ?? 'GET', url });
    const result = url.includes('/zones?name=')
      ? [{ id: 'z1', name: 'inboxangel.io' }]
      : { id: 'rec1', name: 'x._dmarc.h.inboxangel.io', type: 'TXT', content: 'v=DMARC1;' };
    return new Response(JSON.stringify({ success: true, result }), { status: 200 });
  });
  const w = await openHostedZone(ENV, 'inboxangel.io', { fetch: fetch as unknown as typeof globalThis.fetch });
  calls.length = 0;
  return { w, calls };
}

describe('hosted-records writer: DNS writes are limited at the client', () => {
  it('writes TXT and AAAA below *.h.<zone>', async () => {
    const { w, calls } = await open();
    await w.create({ type: 'TXT', name: 'x._dmarc.h.inboxangel.io', content: 'v=DMARC1;' });
    await w.create({ type: 'AAAA', name: 'mta-sts.x.h.inboxangel.io', content: '100::', proxied: true });
    expect(calls.map(c => c.method)).toEqual(['POST', 'POST']);
  });

  it.each([
    ['apex', { type: 'TXT', name: 'inboxangel.io', content: 'x' }],
    ['the label itself', { type: 'TXT', name: 'h.inboxangel.io', content: 'x' }],
    ['another name', { type: 'TXT', name: 'www.inboxangel.io', content: 'x' }],
    ['another zone', { type: 'TXT', name: 'x.h.evil.com', content: 'x' }],
    ['A', { type: 'A', name: 'x.h.inboxangel.io', content: '1.2.3.4' }],
    ['MX', { type: 'MX', name: 'x.h.inboxangel.io', content: 'm.test' }],
    ['NS', { type: 'NS', name: 'x.h.inboxangel.io', content: 'ns.test' }],
  ])('refuses %s without sending anything', async (_t, rec) => {
    const { w, calls } = await open();
    await expect(w.create(rec)).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it('the client itself refuses even when the writer is bypassed', async () => {
    // A writer for another zone name cannot be opened with this token's policy: writes there are refused by the client.
    const calls: string[] = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      return new Response(JSON.stringify({ success: true, result: url.includes('/zones?name=') ? [{ id: 'z2', name: 'other.com' }] : {} }), { status: 200 });
    });
    const w = await openHostedZone(ENV, 'other.com', { fetch: fetch as unknown as typeof globalThis.fetch });
    calls.length = 0;
    await expect(w.create({ type: 'TXT', name: 'x.h.inboxangel.io', content: 'x' })).rejects.toBeInstanceOf(CfRecordNotAllowedError);
    expect(calls).toEqual([]);
  });
});
