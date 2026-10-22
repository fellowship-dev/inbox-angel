import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTestD1, createMigratedD1 } from '@inbox-angel/db/testing';
import { resetSchemaReadyCache } from '@inbox-angel/db';

const handleEmail = vi.fn().mockResolvedValue(undefined);
vi.mock('../src/email/handler', () => ({ handleEmail: (...a: unknown[]) => handleEmail(...a) }));

import worker from '../src/index';

const msg = { setReject: vi.fn() } as any;
const ctx = { waitUntil: vi.fn() } as any;

describe('email handler when the schema is not migrated', () => {
  beforeEach(() => { resetSchemaReadyCache(); handleEmail.mockClear(); msg.setReject.mockClear(); vi.spyOn(console, 'error').mockImplementation(() => {}); });

  it('throws so the sender retries, and does not process or drop the message', async () => {
    const env = { DB: createTestD1() } as any;
    await expect(worker.email(msg, env, ctx)).rejects.toThrow(/out of date.*npm run migrate/s);
    expect(handleEmail).not.toHaveBeenCalled();
    expect(msg.setReject).not.toHaveBeenCalled(); // permanent 5xx would make senders give up
  });

  it('processes normally once migrated', async () => {
    await worker.email(msg, { DB: createMigratedD1() } as any, ctx);
    expect(handleEmail).toHaveBeenCalledOnce();
  });
});
