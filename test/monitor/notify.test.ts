import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { sendChangeNotification } from '../../src/monitor/notify';
import { makeTenant } from '../helpers/tenant';
import type { DomainChange } from '../../src/monitor/check';

const degraded: DomainChange = { field: 'DMARC policy', was: 'reject', now: 'none', severity: 'degraded' };
const improved: DomainChange = { field: 'DMARC policy', was: 'none', now: 'reject', severity: 'improved' };

function makeSendEmail() {
  return { send: vi.fn().mockResolvedValue(undefined) };
}

function makeEnv(sendEmail?: { send: ReturnType<typeof vi.fn> }) {
  return makeTenant({
    env: { SEND_EMAIL: sendEmail as any },
    settings: { reportsDomain: 'reports.inboxangel.io', fromEmail: 'check@reports.inboxangel.io' },
  });
}

describe('sendChangeNotification', () => {
  it('calls SEND_EMAIL.send when binding is configured', async () => {
    const sendEmail = makeSendEmail();
    const env = makeEnv(sendEmail);
    await sendChangeNotification('user@example.com', 'acme.com', [improved], env);
    expect(sendEmail.send).toHaveBeenCalledOnce();
  });

  it('sends correct from/to fields', async () => {
    const sendEmail = makeSendEmail();
    const env = makeEnv(sendEmail);
    await sendChangeNotification('user@example.com', 'acme.com', [improved], env);
    const arg = sendEmail.send.mock.calls[0][0];
    expect(arg.from.email).toBe('check@reports.inboxangel.io');
    expect(arg.to).toContain('user@example.com');
  });

  it('uses degraded subject line when change is degraded', async () => {
    const sendEmail = makeSendEmail();
    const env = makeEnv(sendEmail);
    await sendChangeNotification('user@example.com', 'acme.com', [degraded], env);
    const arg = sendEmail.send.mock.calls[0][0];
    expect(arg.subject).toContain('degraded');
  });

  it('uses neutral subject line when all changes are improved', async () => {
    const sendEmail = makeSendEmail();
    const env = makeEnv(sendEmail);
    await sendChangeNotification('user@example.com', 'acme.com', [improved], env);
    const arg = sendEmail.send.mock.calls[0][0];
    expect(arg.subject).not.toContain('degraded');
  });

  it('includes domain name in email body', async () => {
    const sendEmail = makeSendEmail();
    const env = makeEnv(sendEmail);
    await sendChangeNotification('user@example.com', 'acme.com', [degraded], env);
    const arg = sendEmail.send.mock.calls[0][0];
    expect(arg.text).toContain('acme.com');
  });

  it('includes fix CTA when changes are degraded', async () => {
    const sendEmail = makeSendEmail();
    const env = makeEnv(sendEmail);
    await sendChangeNotification('user@example.com', 'acme.com', [degraded], env);
    const arg = sendEmail.send.mock.calls[0][0];
    expect(arg.text).toContain('inboxangel.io');
  });

  it('does not call SEND_EMAIL when binding is absent', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const env = makeEnv(undefined);
    await sendChangeNotification('user@example.com', 'acme.com', [improved], env);
    consoleSpy.mockRestore();
    // No throw, just logs
  });

  it('does not throw when SEND_EMAIL.send fails', async () => {
    const sendEmail = { send: vi.fn().mockRejectedValue(new Error('send failed')) };
    const env = makeEnv(sendEmail);
    await expect(
      sendChangeNotification('user@example.com', 'acme.com', [degraded], env)
    ).resolves.toBeUndefined();
  });
});
