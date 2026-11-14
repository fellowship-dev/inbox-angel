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
import type { Carrier } from '../dmarc/reporter-auth';
import { loadTenant } from '../tenancy/load';
import { handleDmarcReport, StorageFailure, type ReportResult } from '../email/dmarc-report';
import { handleTlsRptReport } from '../email/tls-rpt';
import { track } from '../telemetry';
import { carrierFromHeaders } from '../dmarc/reporter-auth';
import { readAuthHeaders, trustedResults } from '../email/sender-proof';
import { hostedConfig, hostedEnabled, intakeLimits } from './config';
import { hashToken, isTokenShaped, parseRecipient } from './tokens';
import { handleCanaryEmail } from './canary';
import { logAuthservDiscovery, logIntake, type IntakeKind } from './intake-log';
import { OWNER_VISIBLE, rawTooLarge, REASONS, type Outcome, type ReasonCode } from './reasons';

const today = () => new Date().toISOString().slice(0, 10);

/** What the log line is built from, filled in as the message is understood. */
interface Seen { kind: IntakeKind; ws: string | null; dom: number | null; tier: 'counted' | 'unknown' | 'unauthenticated' | null; reporter: string | null; dkim_org: string | null; from_org: string | null; email_matched: boolean | null; dedup: 'new' | 'duplicate' | 'superseded' | null; records: number | null }
interface Verdict { outcome: Outcome; reason: ReasonCode }

export async function handleHostedEmail(message: ForwardableEmailMessage, env: BoundEnv): Promise<void> {
  const started = Date.now();
  const seen: Seen = { kind: 'other', ws: null, dom: null, tier: null, reporter: null, dkim_org: null, from_org: null, email_matched: null, dedup: null, records: null };
  const line = (v: Verdict) => logIntake({ ...seen, ...v, size: message.rawSize ?? 0, ms: Date.now() - started });
  try {
    line(await intake(message, env, seen));
  } catch (e) {
    if (e instanceof StorageFailure) Object.assign(seen, { records: e.known.records ?? null, reporter: e.known.reporter ?? null, tier: e.known.tier ?? null, dkim_org: e.known.dkimOrg ?? null, from_org: e.known.fromOrg ?? null });
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

  // ORDER OF WORK (cheap and unforgeable first, expensive last):
  //   (a) recipient, token, rawSize (above)   (b) classify the CARRIER from the topmost authentication header (below)
  //   (c) charge the instance/address/tier caps BEFORE decompressing anything   (d) decompress with a hard cap by carrier class
  //       (src/email/dmarc-report.ts: 1 MiB unless the carrier matches a registry entry)   (e) parse; decide the tier from the report's metadata.
  // Tiers: counted (authenticated AND a registry reporter), received-not-counted authenticated (stored, small caps), received-not-counted
  // unauthenticated (stored, tightest caps, 30 days, no IP lookups). Not stored: malformed, over a cap, domain not owned.
  const [forHeaders, rest] = message.raw.tee();
  const headers = await readAuthHeaders(forHeaders);
  const trusted = !!(env.AUTHSERV_ID && env.AUTHSERV_HEADER && trustedResults(headers, env.AUTHSERV_ID, env.AUTHSERV_HEADER));
  logAuthservDiscovery(headers, env, trusted);
  const carrier: Carrier = carrierFromHeaders(headers, env);
  seen.dkim_org = carrier.dkimOrg;
  seen.from_org = carrier.fromOrg;
  const globals = globalQueries(env.DB);
  // What inbound mail carries, instance-wide (a counter, no address): the instance owner is told when nothing can be authenticated.
  await globals.authObservations.note(carrier.authenticated ? 'ok' : carrier.presence, day).catch(() => undefined);

  const registryId = carrier.candidates[0]?.id ?? null;
  /** A registry reporter over a cap is accepted and dropped, not refused: whether Google/Microsoft stop sending after a 5xx is unverified. */
  const overCap = async (reason: ReasonCode): Promise<Verdict> => {
    if (carrier.class !== 'registry') return refuseAndMark(reason);
    await q.markFailure(target.domain_id, day, 'over_cap_accepted_dropped', now()).catch(() => 0);
    seen.reporter = registryId;
    return { outcome: 'accepted', reason: 'over_cap_accepted_dropped' };
  };

  const quota = await q.consumeQuota(target.domain_id, day, message.rawSize, carrier.class, {
    address: limits.addressMessagesPerDay, workspace: limits.workspaceMessagesPerDay, instance: limits.instanceMessagesPerDay, unknownTotal: limits.unknownReportsPerDay, unauthTotal: limits.unauthTotalReportsPerDay,
  });
  if (!quota.ok) {
    return overCap(({ address: 'cap_address_day', unknown: 'cap_unknown_day', unauth: 'cap_unauth_total_day', workspace: 'cap_workspace_day', instance: 'cap_instance_day' } as const)[quota.refusedBy!]);
  }
  // The sending organisation's own allowance: a registry reporter by its id, an authenticated unknown by its DKIM organisation, an
  // unauthenticated sender by the (forgeable) envelope-sender domain it claims.
  const claimed = '~' + (message.from?.split('@').pop()?.trim().toLowerCase() || '');
  const bucket = carrier.class === 'registry' ? registryId! : carrier.class === 'authenticated' ? carrier.dkimOrg! : claimed;
  const perReports = carrier.class === 'registry' ? limits.reportsPerDay : carrier.class === 'authenticated' ? limits.unknownReportsPerReporterPerDay : limits.unauthReportsPerDay;
  const perBytes = carrier.class === 'unauthenticated' ? limits.unauthBytesPerDay : limits.bytesPerDay;
  const ok = await q.consumeReporter(target.domain_id, day, bucket, message.rawSize, perReports, perBytes);
  if (!ok) {
    await q.releaseQuota(target.domain_id, day, message.rawSize, [`a:${target.domain_id}`, `k:${target.domain_id}`, `u:${target.domain_id}`, `w:${target.workspace_id}`, '*']);
    return overCap(carrier.class === 'authenticated' ? 'cap_unknown_reporter_day' : carrier.class === 'unauthenticated' ? 'cap_unauth_day' : 'cap_address_day');
  }

  const body = new Proxy(message, { get: (t, p) => (p === 'raw' ? rest : Reflect.get(t, p, t) instanceof Function ? (Reflect.get(t, p, t) as Function).bind(t) : Reflect.get(t, p, t)) });
  const tenant = await loadTenant(env, { workspaceId: target.workspace_id });

  let result: ReportResult;
  if (kind === 'rua') {
    result = await handleDmarcReport(body, tenant, {
      authHeaders: headers,
      carrier,
      dropOverCap: carrier.class === 'registry',
      maxRecords: limits.recordsPerReport,
      maxNewIps: limits.newIpsPerReport,
      token: { id: target.domain_id, domain: target.domain },
      admit: (n) =>
        quota.addressRecordsToday + n > limits.addressRecordsPerDay ? 'cap_address_records'
        : quota.workspaceRecords + n > limits.workspaceRecords ? 'cap_workspace_storage'
        : quota.instanceRecords + n > limits.instanceRecords ? 'cap_instance_storage' : null,
    });
    Object.assign(seen, { records: result.records, tier: result.tier, reporter: result.identity ?? result.reporter, dedup: result.dedup ?? null, email_matched: result.emailMatched ?? null });
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
