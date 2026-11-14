// Central intake for the hosted service (MODE=saas, SAAS_ENABLED=1).
//
//   rua@rua.readysetmail.com               DMARC aggregate report to the FIXED address (src/hosted/fixed-address.ts): the report's own
//                                          domain → the one workspace that proved it and connected its reports
//   rua+<token>@rua.readysetmail.com       DMARC aggregate report, token → workspace + domain (hosted records)
//   tls-rpt+<token>@rua.readysetmail.com   TLS-RPT report
//   check+<token>@canary.readysetmail.com  anonymous free check (src/hosted/canary.ts), only when CANARY_DOMAIN is set
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
import { forWorkspace, globalQueries, intakeLookups, type IntakeTarget } from '@ready-set-mail/db';
import type { Carrier } from '../dmarc/reporter-auth';
import { loadTenant } from '../tenancy/load';
import { handleDmarcReport, StorageFailure, type ReportResult } from '../email/dmarc-report';
import { handleTlsRptReport } from '../email/tls-rpt';
import { track } from '../telemetry';
import { carrierFromHeaders, guardEnvelope } from '../dmarc/reporter-auth';
import { readAuthHeaders, trustedResults, type AuthHeaders } from '../email/sender-proof';
import { attributeReport, chargeUnattributed, peekReportDomain, takePeek } from './fixed-address';
import { hostedConfig, hostedEnabled, intakeLimits } from './config';
import { hashToken, isTokenShaped, parseRecipient } from './tokens';
import { handleCanaryEmail } from './canary';
import { logAuthservDiscovery, logIntake, type IntakeKind } from './intake-log';
import { OWNER_VISIBLE, rawTooLarge, REASONS, type Outcome, type ReasonCode } from './reasons';

const today = () => new Date().toISOString().slice(0, 10);

/** What the log line is built from, filled in as the message is understood. */
interface Seen { kind: IntakeKind; ws: string | null; dom: number | null; tier: 'counted' | 'unknown' | 'unauthenticated' | null; reporter: string | null; dkim_org: string | null; from_org: string | null; email_matched: boolean | null; dedup: 'new' | 'duplicate' | 'superseded' | null; records: number | null }
interface Verdict { outcome: Outcome; reason: ReasonCode }

/** The caps the instance owner is told about: storage and daily limits at address, workspace and instance level. */
export const isSetupCap = (reason: ReasonCode): boolean =>
  /^cap_(address_day|workspace_day|instance_day|address_records|workspace_storage|instance_storage|uncounted_(workspace_day|instance_day|address_records|workspace_storage|instance_storage)|unattributed_(sender_day|total_day))$/.test(reason);

type IntakeQueries = ReturnType<typeof forWorkspace>['intake'];

/**
 * Charge the pre-decompression caps for one message, in order: instance, workspace, address and the carrier class's own total (one D1 batch,
 * `consumeQuota`), then the sending organisation's own allowance (`consumeReporter`: a registry reporter by its id, an authenticated unknown
 * by its DKIM organisation, an unauthenticated sender by the forgeable envelope-sender domain it claims). Call it AFTER `carrierFromHeaders` and
 * BEFORE decompressing or parsing anything. `reason` is null when the message may proceed, else the reason code of the cap that refused it (what is
 * counted is given back, so a refused message uses nothing). `quota` carries the stored-records counters for the later per-report checks. What to do with the reason is the caller's: hosted intake accepts-and-drops a registry
 * reporter and answers 5xx to anyone else.
 */
export async function chargeIntakeCaps(
  q: IntakeQueries,
  m: { domainId: number; workspaceId: string; day: string; rawSize: number; envelopeFrom?: string | null; carrier: Carrier },
  limits: ReturnType<typeof intakeLimits>,
): Promise<{ reason: ReasonCode | null; quota: Awaited<ReturnType<IntakeQueries['consumeQuota']>> }> {
  const { carrier } = m;
  const quota = await q.consumeQuota(m.domainId, m.day, m.rawSize, carrier.class, {
    address: limits.addressMessagesPerDay, workspace: limits.workspaceMessagesPerDay, instance: limits.instanceMessagesPerDay, unknownTotal: limits.unknownReportsPerDay, unauthTotal: limits.unauthTotalReportsPerDay,
    uncountedWorkspace: limits.uncountedWorkspaceMessagesPerDay, uncountedInstance: limits.uncountedInstanceMessagesPerDay,
  });
  const refuse = (reason: ReasonCode) => ({ reason, quota });
  if (!quota.ok) return refuse(({ address: 'cap_address_day', unknown: 'cap_unknown_day', unauth: 'cap_unauth_total_day', workspace: 'cap_workspace_day', instance: 'cap_instance_day', uncounted_workspace: 'cap_uncounted_workspace_day', uncounted_instance: 'cap_uncounted_instance_day' } as const)[quota.refusedBy!]);
  const claimed = '~' + (m.envelopeFrom?.split('@').pop()?.trim().toLowerCase() || '');
  const bucket = carrier.class === 'registry' ? carrier.candidates[0].id : carrier.class === 'authenticated' ? (carrier.dkimOrg ?? carrier.fromOrg!) : claimed;
  const perReports = carrier.class === 'registry' ? limits.reportsPerDay : carrier.class === 'authenticated' ? limits.unknownReportsPerReporterPerDay : limits.unauthReportsPerDay;
  const perBytes = carrier.class === 'unauthenticated' ? limits.unauthBytesPerDay : limits.bytesPerDay;
  if (await q.consumeReporter(m.domainId, m.day, bucket, m.rawSize, perReports, perBytes)) return { reason: null, quota };
  await q.releaseQuota(m.domainId, m.day, m.rawSize);
  return refuse(carrier.class === 'authenticated' ? 'cap_unknown_reporter_day' : carrier.class === 'unauthenticated' ? 'cap_unauth_day' : 'cap_address_day');
}

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
  if (!hostedEnabled(env)) {
    // A deployment problem, not the sender's: fail the delivery so it is retried once fixed.
    throw Object.assign(new Error('Hosted intake is not configured: MODE=saas needs SAAS_ENABLED=1'), { reason: 'not_configured' as ReasonCode });
  }
  const refuse = (reason: ReasonCode, text: string = REASONS[reason]): Verdict => { message.setReject(text); return { outcome: 'refused', reason }; };

  const rcpt = parseRecipient(message.to);
  if (!rcpt) return refuse('bad_recipient');

  // The free check and report intake are independent: each needs only its own domain (CANARY_DOMAIN, INTAKE_DOMAIN).
  if (cfg.canaryDomain && rcpt.host === cfg.canaryDomain) {
    seen.kind = 'canary';
    let rejected = false;
    const watched = new Proxy(message, { get: (t, p) => (p === 'setReject' ? (r: string) => { rejected = true; t.setReject(r); } : (() => { const v = Reflect.get(t, p, t); return typeof v === 'function' ? v.bind(t) : v; })()) });
    await handleCanaryEmail(watched, env, rcpt);
    return rejected ? { outcome: 'refused', reason: 'unknown_token' } : { outcome: 'accepted', reason: 'ok' };
  }

  // Anything else is report intake. Without INTAKE_DOMAIN that is a deployment problem: fail so the sender retries.
  if (!cfg.intakeDomain) throw Object.assign(new Error('Hosted report intake is not configured: MODE=saas needs INTAKE_DOMAIN'), { reason: 'not_configured' as ReasonCode });
  if (rcpt.host !== cfg.intakeDomain) return refuse('wrong_host');
  if (rcpt.base !== 'rua' && rcpt.base !== 'tls-rpt') return refuse('bad_recipient');
  const kind = rcpt.base;
  seen.kind = kind;

  const limits = intakeLimits(env);
  if (message.rawSize > limits.maxRawBytes) return refuse('raw_too_large', rawTooLarge(limits.maxRawBytes));

  // The FIXED address (rua@, no token) has no workspace until the report names its domain. Its order of work:
  //   (1) the carrier's authentication result   (2) one peek against the instance-wide per-minute ceiling (deferred past it)
  //   (3) a capped peek at the report's policy domain (at most the first 64 KiB inflated)   (4) attribution to the verified, connected
  //   owner; when there is none the mail is charged to the UNATTRIBUTED budget and refused (no workspace's or instance budget is
  //   touched, and mail for a connected domain never pays for mail for unconnected ones)   then, like a token address: (5) the
  //   attributed caps (chargeIntakeCaps) before the full, capped decompression, (6) the tier decision, (7) the atomic store; the full
  //   parse must name the domain the peek read.
  let raw = message.raw;
  let early: { headers: AuthHeaders; carrier: Carrier } | null = null;
  let peeked: string | null = null;
  let target: IntakeTarget | null;
  if (kind === 'rua' && !rcpt.tag) {
    const [forHeaders, afterHeaders] = raw.tee();
    raw = afterHeaders;
    const headers = await readAuthHeaders(forHeaders);
    early = { headers, carrier: guardEnvelope(carrierFromHeaders(headers, env), message.from) };
    if (!(await takePeek(env, early.carrier, Date.now()))) {
      await globalQueries(env.DB).capObservations.note('fixed_address_busy', today()).catch(() => undefined);
      // Unauthenticated mail can never count: refuse it for good (a retry would only hold the ceiling, and nothing depends on what a
      // thrown handler tells the sender). Only authenticated non-registry mail is deferred, so its sender retries later.
      if (!early.carrier.authenticated) return refuse('fixed_address_busy_unauthenticated');
      throw Object.assign(new Error('The shared report address is busy; the sender should retry'), { reason: 'fixed_address_busy' as ReasonCode });
    }
    const [forPeek, afterPeek] = raw.tee();
    raw = afterPeek;
    const peek = await peekReportDomain(forPeek);
    if (!peek.ok) return refuse(peek.reason);
    peeked = peek.domain;
    target = await attributeReport(env, cfg.intakeDomain, peeked);
    if (!target) {
      const over = await chargeUnattributed(env, early.carrier, message.from, today());
      if (over) {
        await globalQueries(env.DB).capObservations.note(over, today()).catch(() => undefined);
        return refuse(over);
      }
      return refuse('domain_not_connected');
    }
  } else {
    if (!rcpt.tag || !isTokenShaped(rcpt.tag)) return refuse('unknown_token');
    const hash = await hashToken(rcpt.tag);
    target = await intakeLookups(env.DB).resolveToken(hash, Math.floor(Date.now() / 1000));
    if (!target) return refuse('unknown_token');
  }
  const tgt: IntakeTarget = target;
  seen.ws = tgt.workspace_id;
  seen.dom = tgt.domain_id;

  const q = forWorkspace(env.DB, tgt.workspace_id).intake;
  const day = today();
  const now = () => Math.floor(Date.now() / 1000);
  /** Mail that reached the address and was not stored is counted where the owner can see it (best effort). */
  const refuseAndMark = async (reason: ReasonCode): Promise<Verdict> => {
    if (OWNER_VISIBLE.has(reason)) await q.markFailure(tgt.domain_id, day, reason, now()).catch(() => 0);
    return refuse(reason);
  };

  // ORDER OF WORK (cheap and unforgeable first, expensive last):
  //   (a) recipient, token, rawSize (above)   (b) classify the CARRIER from the topmost authentication header (below)
  //   (c) charge the instance/address/tier caps BEFORE decompressing anything   (d) decompress with a hard cap by carrier class
  //       (src/email/dmarc-report.ts: 1 MiB unless the carrier matches a registry entry)   (e) parse; decide the tier from the report's metadata.
  // Tiers: counted (authenticated AND a registry reporter), received-not-counted authenticated (stored, small caps), received-not-counted
  // unauthenticated (stored, tightest caps, 30 days, no IP lookups). Not stored: malformed, over a cap, domain not owned.
  let headers: AuthHeaders;
  let rest: ReadableStream<Uint8Array>;
  if (early) {
    headers = early.headers;
    rest = raw;
  } else {
    const [forHeaders, afterHeaders] = raw.tee();
    rest = afterHeaders;
    headers = await readAuthHeaders(forHeaders);
  }
  const trusted = !!(env.AUTHSERV_ID && env.AUTHSERV_HEADER && trustedResults(headers, env.AUTHSERV_ID, env.AUTHSERV_HEADER));
  logAuthservDiscovery(headers, env, trusted);
  const carrier: Carrier = early?.carrier ?? guardEnvelope(carrierFromHeaders(headers, env), message.from);
  seen.dkim_org = carrier.dkimOrg;
  seen.from_org = carrier.fromOrg;
  const globals = globalQueries(env.DB);
  // What inbound mail carries, instance-wide (a counter, no address): the instance owner is told when nothing can be authenticated.
  await globals.authObservations.note(carrier.authenticated ? 'ok' : carrier.presence, day).catch(() => undefined);

  const registryId = carrier.candidates[0]?.id ?? null;
  /** Instance-wide counter of the storage and daily caps that stopped mail (the owner's setup check reads it); best effort. */
  const noteCap = (reason: ReasonCode) => (isSetupCap(reason) ? globals.capObservations.note(reason, day).catch(() => undefined) : undefined);
  /** A registry reporter over a cap is accepted and dropped, not refused: whether Google/Microsoft stop sending after a 5xx is unverified. */
  const overCap = async (reason: ReasonCode): Promise<Verdict> => {
    await noteCap(reason);
    if (carrier.class !== 'registry') return refuseAndMark(reason);
    await q.markFailure(tgt.domain_id, day, 'over_cap_accepted_dropped', now()).catch(() => 0);
    seen.reporter = registryId;
    return { outcome: 'accepted', reason: 'over_cap_accepted_dropped' };
  };

  const { reason: capped, quota } = await chargeIntakeCaps(q, { domainId: tgt.domain_id, workspaceId: tgt.workspace_id, day, rawSize: message.rawSize, envelopeFrom: message.from, carrier }, limits);
  if (capped) return overCap(capped);

  const body = new Proxy(message, { get: (t, p) => (p === 'raw' ? rest : Reflect.get(t, p, t) instanceof Function ? (Reflect.get(t, p, t) as Function).bind(t) : Reflect.get(t, p, t)) });
  const tenant = await loadTenant(env, { workspaceId: tgt.workspace_id });

  let result: ReportResult;
  if (kind === 'rua') {
    result = await handleDmarcReport(body, tenant, {
      authHeaders: headers,
      carrier,
      dropOverCap: carrier.class === 'registry',
      maxRecords: limits.recordsPerReport,
      maxNewIps: limits.newIpsPerReport,
      token: { id: tgt.domain_id, domain: tgt.domain },
      // The fixed address was routed by the peek: the full parse must name the very same domain.
      ...(peeked ? { expectedDomain: peeked } : {}),
      // Two separate storage budgets (the report's tier is known once its metadata is): counted reports, and uncounted ones with their own, much smaller caps.
      admit: (n, tier) => tier === 'counted'
        ? (quota.addressRecordsToday + n > limits.addressRecordsPerDay ? 'cap_address_records'
          : quota.workspaceRecords + n > limits.workspaceRecords ? 'cap_workspace_storage'
          : quota.instanceRecords + n > limits.instanceRecords ? 'cap_instance_storage' : null)
        : (quota.uncountedAddressRecordsToday + n > limits.uncountedAddressRecordsPerDay ? 'cap_uncounted_address_records'
          : quota.uncountedWorkspaceRecords + n > limits.uncountedWorkspaceRecords ? 'cap_uncounted_workspace_storage'
          : quota.uncountedInstanceRecords + n > limits.uncountedInstanceRecords ? 'cap_uncounted_instance_storage' : null),
    });
    Object.assign(seen, { records: result.records, tier: result.tier, reporter: result.identity ?? result.reporter, dedup: result.dedup ?? null, email_matched: result.emailMatched ?? null });
    if (result.outcome === 'accepted' || result.outcome === 'duplicate') track(tenant, { event: 'report.received', failure_count: result.failure_count });
  } else {
    result = await handleTlsRptReport(body, tenant, { hosted: { maxBytes: limits.maxDecompressedBytes, token: { id: tgt.domain_id, domain: tgt.domain } } });
    if (result.outcome === 'accepted') track(tenant, { event: 'tls-rpt.received', failure_count: result.failure_count });
  }
  // Refused after the address was known (a cap on stored records, a report too big): tell the owner.
  if (result.outcome === 'refused' && OWNER_VISIBLE.has(result.reason) && !result.reason.startsWith('storage_failed')) {
    await q.markFailure(tgt.domain_id, day, result.reason, now()).catch(() => 0);
    await noteCap(result.reason);
  } else if (result.outcome === 'refused') {
    await noteCap(result.reason); // the uncounted storage caps: not shown per domain, but the owner's setup check names them
  }
  return { outcome: result.outcome, reason: result.reason };
}
