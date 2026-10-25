import { inspect } from 'node:util';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createMigratedD1 } from '@inbox-angel/db/testing';
import { sendPasswordResetEmail, sendVerificationEmail } from '../../src/auth/mail';
import type { AuthEnv } from '../../src/auth/config';

// Synthetic credentials: none of these may ever reach a log line.
const RECIPIENT = 'leak-recipient@leak.example';
const TOKEN = 'SYNTHETIC-TOKEN-abc123';
const URL_ = `https://ia.example.com/#/reset/${TOKEN}`;
const user = { email: RECIPIENT, name: 'Leak Check' };

const senders = [
  ['reset', sendPasswordResetEmail],
  ['verification', sendVerificationEmail],
] as const;

function spies() {
  return (['log', 'info', 'warn', 'error', 'debug'] as const).map(m => vi.spyOn(console, m).mockImplementation(() => {}));
}
// inspect, not JSON: an Error argument serialises to {} in JSON and would hide its message.
const logged = (all: ReturnType<typeof spies>) => all.flatMap(s => s.mock.calls).map(args => args.map(a => inspect(a, { depth: 5 })).join(' ')).join('\n');
const expectClean = (out: string) => {
  for (const secret of [RECIPIENT, TOKEN, URL_, 'leak.example']) expect(out).not.toContain(secret);
};
function envFor(opts: { sender: boolean; send?: unknown }): AuthEnv {
  const db = createMigratedD1();
  if (opts.sender) db.sqlite.prepare("INSERT OR IGNORE INTO settings (workspace_id, key, value) VALUES ('ws_default', 'from_email', 'noreply@reports.example.com')").run();
  return { DB: db as unknown as D1Database, SEND_EMAIL: opts.send } as unknown as AuthEnv;
}

afterEach(() => vi.restoreAllMocks());

describe.each(senders)('%s email logging', (op, sendMail) => {
  it('without SEND_EMAIL: sends nothing, logs a static reason only', async () => {
    const all = spies();
    await sendMail(envFor({ sender: true }), user, URL_);
    const out = logged(all);
    expect(out).toContain(`[auth] ${op} email not sent: SEND_EMAIL binding not configured`);
    expectClean(out);
  });

  it('without a sender address: does not call the transport, logs a static reason only', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const all = spies();
    await sendMail(envFor({ sender: false, send: { send } }), user, URL_);
    const out = logged(all);
    expect(send).not.toHaveBeenCalled();
    expect(out).toContain(`[auth] ${op} email not sent: no sender address`);
    expectClean(out);
  });

  it('a provider error that embeds the URL, token and recipient is swallowed and not logged', async () => {
    const send = vi.fn().mockRejectedValue(new Error(`rejected ${RECIPIENT} body=${URL_} token=${TOKEN}`));
    const all = spies();
    await expect(sendMail(envFor({ sender: true, send: { send } }), user, URL_)).resolves.toBeUndefined();
    const out = logged(all);
    expect(out).toContain(`[auth] ${op} email send failed`);
    expectClean(out);
  });

  it('delivers the link to the recipient when transport and sender exist', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const all = spies();
    await sendMail(envFor({ sender: true, send: { send } }), user, URL_);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].to).toEqual([RECIPIENT]);
    expect(send.mock.calls[0][0].text).toContain(URL_);
    expect(logged(all)).toBe('');
  });
});
