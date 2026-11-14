// Central intake for the hosted service (MODE=saas, SAAS_ENABLED=1).
//
//   rua+<token>@rua.inboxangel.io       DMARC aggregate report, token → workspace + domain
//   tls-rpt+<token>@rua.inboxangel.io   TLS-RPT report
//   check+<token>@canary.inboxangel.io  anonymous free check (src/hosted/canary.ts)
//
// Subdomains can't have a catch-all, so one Email Routing rule per base address (`rua@`, `tls-rpt@`,
// `check@`) delivers every `+token` variant here. The token picks the workspace; the report's own
// domain must then belong to that workspace (anti-spoof). There is no default-workspace fallback.
//
// What the sender is told (reason codes: src/hosted/reasons.ts):
//   refused   message.setReject → a permanent 5xx in the SMTP session (no backscatter): bad input, over a cap.
//   deferred  the handler throws → used only for a deployment problem (not configured, schema not migrated) or a D1 failure while
//             storing a valid report. Never accept-and-drop: a report that could not be stored is counted for the owner.
// Every message leaves one JSON log line (src/hosted/intake-log.ts).

import type { BoundEnv } from '../index';
import { forWorkspace, globalQueries, intakeLookups } from '@inbox-angel/db';
import { loadTenant } from '../tenancy/load';
import { handleDmarcReport, StorageFailure, type ReportResult } from '../email/dmarc-report';
import { handleTlsRptReport } from '../email/tls-rpt';
import { track } from '../telemetry';
import { classifySender } from '../dmarc/reporter-auth';
import { readAuthHeaders, trustedResults } from '../email/sender-proof';
import { hostedConfig, hostedEnabled, intakeLimits } from './config';
import { hashToken, isTokenShaped, parseRecipient } from './tokens';
import { handleCanaryEmail } from './canary';
import { logAuthservDiscovery, logIntake, type IntakeKind } from './intake-log';
import { OWNER_VISIBLE, rawTooLarge, REASONS, type Outcome, type ReasonCode } from './reasons';

const today = () => new Date().toISOString().slice(0, 10);

/** What the log line is built from, filled in as the message is understood. */
interface Seen { kind: IntakeKind; ws: string | null; dom: number | null; tier: 'counted' | 'unknown' | 'unauthenticated' | null; reporter: string | null; records: number | null }
interface Verdict { outcome: Outcome; reason: ReasonCode }

export async function handleHostedEmail(message: ForwardableEmailMessage, env: BoundEnv): Promise<void> {
  const started = Date.now();
  const seen: Seen = { kind: 'other', ws: null, dom: null, tier: null, reporter: null, records: null };
  const line = (v: Verdict) => logIntake({ ...seen, ...v, size: message.rawSize ?? 0, ms: Date.now() - started });
  try {
    line(await intake(message, env, seen));
  } catch (e) {
    if (e instanceof StorageFailure) Object.assign(seen, { records: e.known.records ?? null, reporter: e.known.reporter ?? null, tier: e.known.tier ?? null });
    line({ outcome: 'deferred', reason: e instanceof StorageFailure ? 'storage_failed' : (e as { reason?: ReasonCode }).reason ?? 'internal_error' });
    throw e;
  }
}

async function intake(message: ForwardableEmailMessage, env: BoundEnv, seen: Seen): Promise<Verdict> {
  const cfg = hostedConfig(env);
  if (!hostedEnabled(env) || !cfg.intakeDomain || !cfg.canaryDomain) {
    // A deployment problem, not the sender's: fail the delivery so it is retried once fixed.
    throw Object.assign(new Error('Hosted intake is not configured: MODE=saas needs SAAS_ENABLED=1, INTAKE_DOMAIN and CANARY_DOMAIN'), { reason: 'not_configured' as ReasonCode });
  }
  const refuse = (reason: ReasonCode, text: string = REASONS[reason]): Verdict => { message.setReject(text); return { outcome: 'refused', reason }; };

  const rcpt = parseRecipient(message.to);
  if (!rcpt) return refuse('bad_recipient');

  if (rcpt.host === cfg.canaryDomain) {
    seen.kind = 'canary';
    let rejected = false;
    const watched = new Proxy(message, { get: (t, p) => (p === 'setReject' ? (r: string) => { rejected = true; t.setReject(r); } : (() => { const v = Reflect.get(t, p, t); return typeof v === 'function' ? v.bind(t) : v; })()) });
    await handleCanaryEmail(watched, env, rcpt);
    return rejected ? { outcome: 'refused', reason: 'unknown_token' } : { outcome: 'accepted', reason: 'ok' };
  }

  if (rcpt.host !== cfg.intakeDomain) return refuse('wrong_host');
  if (rcpt.base !== 'rua' && rcpt.base !== 'tls-rpt') return refuse('bad_recipient');
  const kind = rcpt.base;
  seen.kind = kind;

  const limits = intakeLimits(env);
  if (message.rawSize > limits.maxRawBytes) return refuse('raw_too_large', rawTooLarge(limits.maxRawBytes));
  if (!rcpt.tag || !isTokenShaped(rcpt.tag)) return refuse('unknown_token');

  const hash = await hashToken(rcpt.tag);
  const target = await intakeLookups(env.DB).resolveToken(hash, Math.floor(Date.now() / 1000));
  if (!target) return refuse('unknown_token');
  seen.ws = target.workspace_id;
  seen.dom = target.domain_id;

  const q = forWorkspace(env.DB, target.workspace_id).intake;
  const day = today();
  const now = () => Math.floor(Date.now() / 1000);
  /** Mail that reached the address and was not stored is counted where the owner can see it (best effort). */
  const refuseAndMark = async (reason: ReasonCode): Promise<Verdict> => {
    if (OWNER_VISIBLE.has(reason)) await q.markFailure(target.domain_id, day, reason, now()).catch(() => 0);
    return refuse(reason);
  };

  // Three tiers, decided from the MESSAGE before anything is parsed (src/dmarc/reporter-auth.ts):
  //   refused  not authenticated (aligned DKIM/SPF/DMARC in the trusted results header, for the From domain). Nothing is stored. While
  //            AUTHSERV_ID / AUTHSERV_HEADER are unset nothing can be authenticated, so all report mail is refused (authserv_unconfigured);
  //            the authserv discovery line below is still logged, so the operator can configure it before publishing addresses.
  //   unknown  authenticated, but the From identity is not a known reporter: stored, NOT counted, on a small allowance of its own.
  //   counted  authenticated AND a known reporter.
  const [forHeaders, rest] = message.raw.tee();
  const authHeaders = await readAuthHeaders(forHeaders);
  const trusted = !!(env.AUTHSERV_ID && env.AUTHSERV_HEADER && trustedResults(authHeaders, env.AUTHSERV_ID, env.AUTHSERV_HEADER));
  logAuthservDiscovery(authHeaders, env, trusted);
  const decision = classifySender(authHeaders, env);
  if (decision.action === 'refuse') return refuse(decision.reason);
  seen.tier = decision.tier;
  seen.reporter = decision.domain;
  const reporterDomain = decision.domain!;
  const unknown = decision.tier === 'unknown';
  // Authenticated senders we do not know: listed for the instance owner (domain, count, last seen) so the list can grow. Best effort.
  if (unknown && kind === 'rua') await globalQueries(env.DB).unknownReporters.note(reporterDomain, now()).catch(() => undefined);

  // Caps in one batch: this address, its workspace, the instance (and, for an unknown reporter, this address's unknown-reporter total),
  // then the sending organisation's own allowance. Unknown reporters get a small one: they are stored, never counted.
  const quota = await q.consumeQuota(target.domain_id, day, message.rawSize, unknown, {
    address: limits.addressMessagesPerDay, workspace: limits.workspaceMessagesPerDay, instance: limits.instanceMessagesPerDay, unknownTotal: limits.unknownReportsPerDay,
  });
  if (!quota.ok) {
    return refuseAndMark(({ address: 'cap_address_day', unknown: 'cap_unknown_day', workspace: 'cap_workspace_day', instance: 'cap_instance_day' } as const)[quota.refusedBy!]);
  }
  const ok = await q.consumeReporter(target.domain_id, day, reporterDomain, message.rawSize, unknown ? limits.unknownReportsPerReporterPerDay : limits.reportsPerDay, limits.bytesPerDay);
  if (!ok) {
    await q.releaseQuota(target.domain_id, day, message.rawSize, [`a:${target.domain_id}`, ...(unknown ? [`k:${target.domain_id}`] : []), `w:${target.workspace_id}`, '*']);
    return refuseAndMark(unknown ? 'cap_unknown_reporter_day' : 'cap_address_day');
  }

  const body = new Proxy(message, { get: (t, p) => (p === 'raw' ? rest : Reflect.get(t, p, t) instanceof Function ? (Reflect.get(t, p, t) as Function).bind(t) : Reflect.get(t, p, t)) });
  const tenant = await loadTenant(env, { workspaceId: target.workspace_id });

  let result: ReportResult;
  if (kind === 'rua') {
    result = await handleDmarcReport(body, tenant, {
      authHeaders,
      reporter: { tier: decision.tier, domain: decision.domain, knownAs: decision.knownAs, auth: decision.auth, reason: decision.reason },
      maxBytes: limits.maxDecompressedBytes,
      maxRecords: unknown ? Math.min(limits.recordsPerReport, limits.unknownRecordsPerReport) : limits.recordsPerReport,
      maxNewIps: limits.newIpsPerReport,
      token: { id: target.domain_id, domain: target.domain },
      admit: (n) =>
        quota.addressRecordsToday + n > limits.addressRecordsPerDay ? 'cap_address_records'
        : quota.workspaceRecords + n > limits.workspaceRecords ? 'cap_workspace_storage'
        : quota.instanceRecords + n > limits.instanceRecords ? 'cap_instance_storage' : null,
    });
    seen.records = result.records;
    if (result.outcome === 'accepted' || result.outcome === 'duplicate') track(tenant, { event: 'report.received', failure_count: result.failure_count });
  } else {
    result = await handleTlsRptReport(body, tenant, { hosted: { maxBytes: limits.maxDecompressedBytes, token: { id: target.domain_id, domain: target.domain } } });
    if (result.outcome === 'accepted') track(tenant, { event: 'tls-rpt.received', failure_count: result.failure_count });
  }
  // Refused after the address was known (a cap on stored records, a report too big): tell the owner.
  if (result.outcome === 'refused' && OWNER_VISIBLE.has(result.reason) && !result.reason.startsWith('storage_failed')) {
    await q.markFailure(target.domain_id, day, result.reason, now()).catch(() => 0);
  }
  return { outcome: result.outcome, reason: result.reason };
}
