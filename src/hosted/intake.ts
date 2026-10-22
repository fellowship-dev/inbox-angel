// Central intake for the hosted service (MODE=saas, SAAS_ENABLED=1).
//
//   rua+<token>@rua.inboxangel.io       DMARC aggregate report, token → account + domain
//   tls-rpt+<token>@rua.inboxangel.io   TLS-RPT report
//   check+<token>@canary.inboxangel.io  anonymous free check (src/hosted/canary.ts)
//
// Subdomains can't have a catch-all, so one Email Routing rule per base address (`rua@`, `tls-rpt@`,
// `check@`) delivers every `+token` variant here. The token picks the account; the report's own
// domain must then belong to that account (anti-spoof). There is no default-account fallback.
//
// Rejections are permanent (message.setReject → 5xx, the sender stops retrying) and logged with a reason.
// A database that isn't migrated yet throws instead (index.ts), so the sender retries later.

import type { BoundEnv } from '../index';
import { intakeLookups } from '@inbox-angel/db';
import { loadTenant } from '../tenancy/load';
import { handleDmarcReport } from '../email/dmarc-report';
import { handleTlsRptReport } from '../email/tls-rpt';
import { track } from '../telemetry';
import { hostedConfig, hostedEnabled, MAX_REPORT_BYTES } from './config';
import { hashToken, isTokenShaped, parseRecipient } from './tokens';
import { handleCanaryEmail } from './canary';

/** A message whose setReject also logs why, so every rejection leaves a reason in the logs. */
export function withRejectLog(message: ForwardableEmailMessage, fields: Record<string, unknown>): ForwardableEmailMessage {
  return new Proxy(message, {
    get(target, prop) {
      if (prop === 'setReject') {
        return (reason: string) => {
          console.warn('[intake] rejected', JSON.stringify({ ...fields, reason }));
          target.setReject(reason);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function reject(message: ForwardableEmailMessage, fields: Record<string, unknown>, reason: string): void {
  console.warn('[intake] rejected', JSON.stringify({ ...fields, reason }));
  message.setReject(reason);
}

export async function handleHostedEmail(message: ForwardableEmailMessage, env: BoundEnv): Promise<void> {
  const cfg = hostedConfig(env);
  if (!hostedEnabled(env) || !cfg.intakeDomain || !cfg.canaryDomain) {
    // A deployment problem, not the sender's: fail the delivery so it is retried once fixed.
    throw new Error('Hosted intake is not configured: MODE=saas needs SAAS_ENABLED=1, INTAKE_DOMAIN and CANARY_DOMAIN');
  }

  const rcpt = parseRecipient(message.to);
  const base = { to_host: rcpt?.host ?? null };
  if (!rcpt) return reject(message, base, 'Unknown recipient');

  if (rcpt.host === cfg.canaryDomain) return handleCanaryEmail(message, env, rcpt);

  if (rcpt.host !== cfg.intakeDomain) return reject(message, base, 'Unknown recipient');
  if (rcpt.base !== 'rua' && rcpt.base !== 'tls-rpt') return reject(message, base, 'Unknown recipient');
  const kind = rcpt.base;

  if (message.rawSize > MAX_REPORT_BYTES) return reject(message, { ...base, kind }, 'Report is larger than 25 MiB');
  if (!rcpt.tag || !isTokenShaped(rcpt.tag)) return reject(message, { ...base, kind }, 'Unknown intake token');

  const hash = await hashToken(rcpt.tag);
  const target = await intakeLookups(env.DB).resolveToken(hash, Math.floor(Date.now() / 1000));
  if (!target) return reject(message, { ...base, kind, token: hash.slice(0, 8) }, 'Unknown intake token');

  const fields = { ...base, kind, account: target.account_id, domain_id: target.domain_id };
  const guarded = withRejectLog(message, fields);
  const tenant = await loadTenant(env, { accountId: target.account_id });

  if (kind === 'rua') {
    const { failure_count } = await handleDmarcReport(guarded, tenant, { maxBytes: MAX_REPORT_BYTES });
    track(tenant, { event: 'report.received', failure_count });
  } else {
    const { failure_count } = await handleTlsRptReport(guarded, tenant, { hosted: { maxBytes: MAX_REPORT_BYTES } });
    track(tenant, { event: 'tls-rpt.received', failure_count });
  }
}
