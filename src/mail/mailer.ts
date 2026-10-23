// Outbound mail, by purpose.
//
//   funnel mail         the onboarding sequence (marketing), from MAIL_FROM: Resend only (RESEND_API_KEY).
//                       Cloudflare Email Service is transactional-only per its FAQ, so it is never used for this.
//   owner-facing mail   change alerts, weekly digests, resets, invites: the Worker's `send_email` binding, as before.
//                       It reaches verified destinations (self-host), or any recipient once a sending domain is onboarded.
//   confirmations       the double opt-in email (transactional, to an arbitrary address): the binding if present, else Resend.
//
// See docs/email-funnel.md.

export interface MailMessage {
  from: { name?: string; email: string };
  to: string;
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
  headers?: Record<string, string>;
  /** Stable per logical email, so a retried send cannot deliver twice (Resend honours it). */
  idempotencyKey?: string;
}

/**
 * recipient: the provider explicitly refused this address (the only kind that bounces a lead).
 * transient: possibly sent, outcome unknown (network error, 5xx).
 * config: not sent and not provably the recipient's fault (bad key, unverified or malformed `from`, quota, rate limit, any
 * unrecognised error): a human has to look, so callers put the step back and stop.
 */
export type SendResult = { ok: true; id?: string } | { ok: false; kind: 'recipient' | 'transient' | 'config'; error: string };

export interface Mailer {
  readonly provider: 'resend' | 'binding';
  /** True when the provider can deliver to addresses nobody verified in advance (Resend). The binding may or may not, depending on the account. */
  readonly arbitraryRecipients: boolean;
  send(message: MailMessage): Promise<SendResult>;
}

export interface MailEnv {
  SEND_EMAIL?: SendEmail;
  RESEND_API_KEY?: string;
}

// Cloudflare Email Service error codes that mean "this recipient will not work" (as opposed to our configuration).
const CF_RECIPIENT_CODES: readonly string[] = ['E_RECIPIENT_NOT_ALLOWED', 'E_RECIPIENT_SUPPRESSED', 'E_RECIPIENT_INVALID'];

function errorText(e: unknown): string {
  return e instanceof Error ? `${(e as { code?: string }).code ?? e.name}: ${e.message}` : 'unknown error';
}

function bindingMailer(binding: SendEmail): Mailer {
  return {
    provider: 'binding',
    arbitraryRecipients: false,
    async send(m) {
      try {
        const res = await (binding as unknown as { send(msg: unknown): Promise<{ messageId?: string } | void> }).send({
          from: m.from.name ? { name: m.from.name, email: m.from.email } : m.from.email,
          to: [m.to],
          subject: m.subject,
          text: m.text,
          ...(m.html ? { html: m.html } : {}),
          ...(m.replyTo ? { replyTo: m.replyTo } : {}),
          ...(m.headers ? { headers: m.headers } : {}),
        });
        return { ok: true, id: res && 'messageId' in res ? res.messageId : undefined };
      } catch (e) {
        const code = (e as { code?: string })?.code ?? '';
        return { ok: false, kind: CF_RECIPIENT_CODES.includes(code) ? 'recipient' : code.startsWith('E_HEADER') ? 'config' : 'transient', error: errorText(e) };
      }
    },
  };
}

function resendMailer(apiKey: string, fetchFn: typeof fetch = fetch): Mailer {
  return {
    provider: 'resend',
    arbitraryRecipients: true,
    async send(m) {
      let res: Response;
      try {
        res = await fetchFn('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            ...(m.idempotencyKey ? { 'Idempotency-Key': m.idempotencyKey } : {}),
          },
          body: JSON.stringify({
            from: m.from.name ? `${m.from.name.replace(/[<>",]/g, '')} <${m.from.email}>` : m.from.email,
            to: [m.to],
            subject: m.subject,
            text: m.text,
            ...(m.html ? { html: m.html } : {}),
            ...(m.replyTo ? { reply_to: m.replyTo } : {}),
            ...(m.headers ? { headers: m.headers } : {}),
          }),
        });
      } catch (e) {
        return { ok: false, kind: 'transient', error: errorText(e) };
      }
      if (res.ok) {
        const body = (await res.json().catch(() => ({}))) as { id?: string };
        return { ok: true, id: body.id };
      }
      const body = (await res.json().catch(() => ({}))) as { message?: string; name?: string };
      const error = `resend ${res.status} ${body.name ?? ''}: ${body.message ?? 'error'}`.replace('  ', ' ');
      // Resend's errors (https://resend.com/docs/api-reference/errors) name no recipient-specific error: an invalid `to`, a bad
      // `from` or an unverified domain all come back as `validation_error`, told apart only by the message. So nothing from
      // Resend is classified as a recipient error (a bad MAIL_FROM must never bounce and suppress leads). The only
      // ambiguous outcome is a server fault, where the mail may or may not have been accepted; everything else was refused.
      if (res.status >= 500) return { ok: false, kind: 'transient', error };
      return { ok: false, kind: 'config', error };
    },
  };
}

/** Funnel (marketing) mail: Resend, or null when RESEND_API_KEY is not set. */
export function funnelMailer(env: MailEnv, fetchFn?: typeof fetch): Mailer | null {
  return env.RESEND_API_KEY ? resendMailer(env.RESEND_API_KEY, fetchFn) : null;
}

/** Owner-facing mail (alerts, digests): the send_email binding, or null. Never Resend: workspace sender domains are not verified there. */
export function ownerMailer(env: MailEnv): Mailer | null {
  return env.SEND_EMAIL ? bindingMailer(env.SEND_EMAIL) : null;
}

/** Transactional mail to an arbitrary address (the monitor confirmation): the binding if present, else Resend. */
export function transactionalMailer(env: MailEnv, fetchFn?: typeof fetch): Mailer | null {
  return ownerMailer(env) ?? funnelMailer(env, fetchFn);
}

/** Why the sequence cannot send right now because of the provider, in words for the dashboard. */
export function providerProblem(env: MailEnv): string | null {
  return env.RESEND_API_KEY ? null : 'No mail provider is configured: set RESEND_API_KEY (the sequence is sent with Resend; Cloudflare Email Service is transactional-only)';
}
