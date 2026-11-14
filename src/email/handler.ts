import type { TenantContext } from '../tenancy/context';
import { handleFreeCheck } from './free-check';
import { handleDmarcReport, StorageFailure, type ReportResult } from './dmarc-report';
import { logIntake, type IntakeKind } from '../hosted/intake-log';
import type { ReasonCode } from '../hosted/reasons';
import { handleTlsRptReport } from './tls-rpt';
import { track } from '../telemetry';
import { globalQueries } from '@ready-set-mail/db';
import { hashToken, isTokenShaped, parseRecipient } from '../hosted/tokens';

// Routes inbound email by recipient address local part:
//   rua@reports.yourdomain.com          → DMARC RUA aggregate report (routed by XML content)
//   tls-rpt@reports.yourdomain.com      → TLS-RPT JSON report (RFC 8460)
//   check+<token>@reports.yourdomain.com → free SPF/DKIM/DMARC check; the token was issued by POST /api/check-sessions
// Anything else (a mistyped address, a `ruf=` pointed here, a spammer guessing local parts) is dropped with a log line:
// it must not store the sender or get an automatic reply.
export async function handleEmail(
  message: ForwardableEmailMessage,
  tenant: TenantContext,
  _ctx: ExecutionContext
): Promise<void> {
  const to = message.to.toLowerCase();
  const localPart = to.split('@')[0];

  if (localPart === 'rua' || localPart === 'tls-rpt') {
    const kind: IntakeKind = localPart;
    const started = Date.now();
    const line = (outcome: ReportResult['outcome'], reason: ReasonCode, r: Partial<ReportResult> = {}) =>
      logIntake({ kind, outcome, reason, tier: r.tier ?? null, reporter: r.reporter ?? null, dkim_org: r.dkimOrg ?? null, from_org: r.fromOrg ?? null, email_matched: r.emailMatched ?? null, dedup: r.dedup ?? null, size: message.rawSize ?? 0, records: r.records ?? null, ms: Date.now() - started, ws: tenant.workspaceId });
    let r: ReportResult;
    try {
      r = kind === 'rua' ? await handleDmarcReport(message, tenant) : await handleTlsRptReport(message, tenant);
    } catch (e) {
      line('deferred', e instanceof StorageFailure ? 'storage_failed' : 'internal_error', e instanceof StorageFailure ? e.known : {});
      throw e; // the sender retries
    }
    line(r.outcome, r.reason, r);
    if (r.outcome === 'accepted' || r.outcome === 'duplicate') track(tenant, kind === 'rua' ? { event: 'report.received', failure_count: r.failure_count } : { event: 'tls-rpt.received', failure_count: r.failure_count }); // fire-and-forget
  } else {
    const rcpt = parseRecipient(to);
    const token = rcpt?.base === 'check' && rcpt.tag && isTokenShaped(rcpt.tag) ? rcpt.tag : null;
    // Single use and expiring, like the hosted canary: a token nobody issued (or already used) is not a check.
    if (!token || !(await globalQueries(tenant.db).canary.consume(await hashToken(token), Math.floor(Date.now() / 1000)))) {
      console.warn('[email] dropped: unknown recipient', JSON.stringify({ local: token ? 'check+<unknown token>' : localPart.slice(0, 16) }));
      message.setReject('Unknown recipient');
      return;
    }
    const { result } = await handleFreeCheck(message, tenant, token);
    track(tenant, { event: 'check.received', result }); // fire-and-forget
  }
}
