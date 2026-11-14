import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/telemetry', () => ({ track: vi.fn() }));

import { createMigratedD1 } from '@inbox-angel/db/testing';
import { helpUrl } from '../../src/funnel/config';
import { call, makeEnv } from './helpers';

const status = async (extra: Record<string, unknown>) => (await (await call(makeEnv(createMigratedD1(), extra), 'GET', '/api/auth/status')).json()) as { help_url: string | null; mode: string };

describe('helpUrl: the "Talk to Max" link', () => {
  it('accepts an https URL, trimmed', () => {
    expect(helpUrl({ BOOKING_URL: '  https://cal.example.com/max/30min  ' })).toBe('https://cal.example.com/max/30min');
  });

  it('rejects unset, empty, http, javascript: and malformed values', () => {
    for (const BOOKING_URL of [undefined, '', '   ', 'http://cal.example.com/max', 'javascript:alert(1)', 'https://', 'https:// spaced.example.com', 'cal.example.com/max', 'https://cal.example.com/a b']) {
      expect(helpUrl({ BOOKING_URL }), String(BOOKING_URL)).toBeNull();
    }
  });
});

describe('GET /api/auth/status help_url', () => {
  it('hosted: carries the https booking link', async () => {
    const s = await status({ MODE: 'saas', SAAS_ENABLED: '1', BOOKING_URL: 'https://cal.example.com/max' });
    expect(s.mode).toBe('saas');
    expect(s.help_url).toBe('https://cal.example.com/max');
  });

  it('hosted: null when BOOKING_URL is unset or not https', async () => {
    expect((await status({ MODE: 'saas', SAAS_ENABLED: '1' })).help_url).toBeNull();
    expect((await status({ MODE: 'saas', SAAS_ENABLED: '1', BOOKING_URL: 'http://cal.example.com/max' })).help_url).toBeNull();
  });

  it('self-host: never exposes BOOKING_URL (it belongs to the funnel mail)', async () => {
    const s = await status({ BOOKING_URL: 'https://cal.example.com/max' });
    expect(s.mode).toBe('self-host');
    expect(s.help_url).toBeNull();
  });
});
