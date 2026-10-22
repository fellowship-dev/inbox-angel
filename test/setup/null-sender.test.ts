import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ensureNullSenderRecords } from '../../src/setup/email-routing';
import { makeTenant } from '../helpers/tenant';
import { skipZoneLookups } from '../helpers/cf-fake';

const TOKEN = 'test-token';
const ZONE = 'zone-123';
const REPORTS = 'reports.example.com';

let fetchMock: ReturnType<typeof vi.fn>;

// The reports domain's zone is already known to the tenant, so no zone lookup hits the mock.
const tenant = () => makeTenant({ cfToken: TOKEN, fetch: skipZoneLookups((...a) => fetchMock(...a)), settings: { zoneId: ZONE, zoneName: 'example.com' } });

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function cfOk<T>(result: T) {
  return new Response(JSON.stringify({ success: true, result }), { status: 200 });
}

describe('ensureNullSenderRecords', () => {
  it('creates both records when none exist', async () => {
    fetchMock
      // Search SPF TXT records — none found
      .mockResolvedValueOnce(cfOk([]))
      // Create SPF record
      .mockResolvedValueOnce(cfOk({ id: 'rec-spf' }))
      // Search DMARC TXT records — none found
      .mockResolvedValueOnce(cfOk([]))
      // Create DMARC record
      .mockResolvedValueOnce(cfOk({ id: 'rec-dmarc' }));

    const actions = await ensureNullSenderRecords(tenant(), REPORTS);

    expect(actions).toHaveLength(2);
    expect(actions[0]).toContain('created');
    expect(actions[1]).toContain('created');

    // Verify SPF creation call
    const spfCreate = fetchMock.mock.calls[1];
    const spfBody = JSON.parse(spfCreate[1].body);
    expect(spfBody.content).toBe('"v=spf1 -all"');
    expect(spfBody.name).toBe(REPORTS);

    // Verify DMARC creation call
    const dmarcCreate = fetchMock.mock.calls[3];
    const dmarcBody = JSON.parse(dmarcCreate[1].body);
    expect(dmarcBody.content).toBe('"v=DMARC1; p=reject;"');
    expect(dmarcBody.name).toBe(`_dmarc.${REPORTS}`);
  });

  it('skips creation when matching records already exist', async () => {
    fetchMock
      // Search SPF — exact match found
      .mockResolvedValueOnce(cfOk([{ id: 'existing-spf', content: 'v=spf1 -all' }]))
      // Search DMARC — exact match found
      .mockResolvedValueOnce(cfOk([{ id: 'existing-dmarc', content: 'v=DMARC1; p=reject;' }]));

    const actions = await ensureNullSenderRecords(tenant(), REPORTS);

    expect(actions).toHaveLength(2);
    expect(actions[0]).toContain('exists');
    expect(actions[1]).toContain('exists');
    // Only 2 fetch calls (searches), no creates
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('flags conflict when SPF record exists but differs', async () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    fetchMock
      // Search SPF — different record found
      .mockResolvedValueOnce(cfOk([{ id: 'existing-spf', content: 'v=spf1 include:something.com ~all' }]))
      // Search DMARC — none found
      .mockResolvedValueOnce(cfOk([]))
      // Create DMARC
      .mockResolvedValueOnce(cfOk({ id: 'rec-dmarc' }));

    const actions = await ensureNullSenderRecords(tenant(), REPORTS);

    expect(actions[0]).toContain('conflict');
    expect(actions[1]).toContain('created');
    // No create call for SPF (conflict = don't overwrite)
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('null-sender conflict'),
    );
    consoleSpy.mockRestore();
  });

  it('flags conflict when DMARC record exists but differs', async () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    fetchMock
      // Search SPF — exact match
      .mockResolvedValueOnce(cfOk([{ id: 'existing-spf', content: 'v=spf1 -all' }]))
      // Search DMARC — different policy
      .mockResolvedValueOnce(cfOk([{ id: 'existing-dmarc', content: 'v=DMARC1; p=none;' }]));

    const actions = await ensureNullSenderRecords(tenant(), REPORTS);

    expect(actions[0]).toContain('exists');
    expect(actions[1]).toContain('conflict');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    consoleSpy.mockRestore();
  });

  it('handles CF-quoted TXT records (strips wrapping quotes)', async () => {
    fetchMock
      // CF returns quoted content
      .mockResolvedValueOnce(cfOk([{ id: 'spf-1', content: '"v=spf1 -all"' }]))
      .mockResolvedValueOnce(cfOk([{ id: 'dmarc-1', content: '"v=DMARC1; p=reject;"' }]));

    const actions = await ensureNullSenderRecords(tenant(), REPORTS);

    expect(actions[0]).toContain('exists');
    expect(actions[1]).toContain('exists');
  });

  it('ignores non-SPF TXT records at same name', async () => {
    fetchMock
      // Search returns a non-SPF TXT record (e.g. verification)
      .mockResolvedValueOnce(cfOk([{ id: 'verify-1', content: 'google-site-verification=abc123' }]))
      // Create SPF (no match found)
      .mockResolvedValueOnce(cfOk({ id: 'new-spf' }))
      // Search DMARC — none
      .mockResolvedValueOnce(cfOk([]))
      // Create DMARC
      .mockResolvedValueOnce(cfOk({ id: 'new-dmarc' }));

    const actions = await ensureNullSenderRecords(tenant(), REPORTS);

    expect(actions[0]).toContain('created');
    expect(actions[1]).toContain('created');
  });
});
