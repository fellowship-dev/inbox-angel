import { useEffect, useState } from 'preact/hooks';
import { getDomains, getDomainStats, getDomainSources, checkDomainDns, updateDmarcPolicy, getSpfFlattenStatus, disableSpfFlatten, getMtaStsStatus, disableMtaSts, getWizardState, getRolloutNext, advanceRollout } from '../api';
import type { RolloutNext } from '../api';
import type { Domain, DomainStats, FailingSource, SpfFlatStatus, MtaStsStatus, WizardState } from '../types';
import { useIsMobile } from '../hooks';

interface Props {
  id: number;
  onUnauthorized: () => void;
}

const POLICY_COLOR: Record<string, string> = {
  reject: '#16a34a',
  quarantine: '#d97706',
  none: '#dc2626',
};

interface Guidance {
  color: string;
  title: string;
  body: string;
  action?: { label: string; dns: string; targetPolicy: string };
}

/**
 * Build a recommended DMARC record that preserves existing tags (other rua= addresses,
 * pct=, sp=, fo=, etc.) and just updates p= + appends our rua if not already present.
 */
function buildRecommendedRecord(currentRecord: string | null, targetPolicy: string, ruaAddress: string): string {
  if (!currentRecord) {
    return `v=DMARC1; p=${targetPolicy}; rua=mailto:${ruaAddress}`;
  }
  let record = /p=[a-z]+/.test(currentRecord)
    ? currentRecord.replace(/p=[a-z]+/, `p=${targetPolicy}`)
    : `${currentRecord}; p=${targetPolicy}`;
  if (!record.includes(ruaAddress)) {
    record = /rua=/.test(record)
      ? record.replace(/rua=([^;]+)/, `rua=$1,mailto:${ruaAddress}`)
      : `${record}; rua=mailto:${ruaAddress}`;
  }
  return record;
}

function getGuidance(domain: Domain, passRate: number | null, hasData: boolean, currentRecord: string | null): Guidance {
  const policy = domain.dmarc_policy ?? 'none';

  if (!hasData) return {
    color: '#6b7280',
    title: 'Waiting for first reports',
    body: 'No DMARC reports yet. Mail servers worldwide collect them throughout the day and send a batch once every 24 hours — so your first report usually arrives within a day of adding your DNS record. Nothing to do but wait.',
    action: { label: 'Double-check your DNS record includes this rua= address:', dns: `rua=mailto:${domain.rua_address}`, targetPolicy: '' },
  };

  if (policy === 'none') return {
    color: '#d97706',
    title: 'Monitoring only — not enforcing',
    body: `You're observing mail flows but DMARC is not protecting your domain yet. Once your pass rate stays above 95% for a few days, switch to quarantine.`,
    action: { label: 'Next step — update your DMARC record:', dns: buildRecommendedRecord(currentRecord, 'quarantine', domain.rua_address), targetPolicy: 'quarantine' },
  };

  if (policy === 'quarantine') {
    if (passRate !== null && passRate >= 90) return {
      color: '#2563eb',
      title: 'Ready to enforce',
      body: `Pass rate is ${passRate}% — your legitimate mail is well-aligned. You can safely move to reject to stop spoofed mail from reaching inboxes.`,
      action: { label: 'Next step — update your DMARC record:', dns: buildRecommendedRecord(currentRecord, 'reject', domain.rua_address), targetPolicy: 'reject' },
    };
    return {
      color: '#d97706',
      title: 'Not ready for reject yet',
      body: `Pass rate is ${passRate ?? '—'}% — some legitimate mail is failing DMARC. Investigate the failing sources below before tightening your policy.`,
    };
  }

  if (policy === 'reject') {
    if (passRate !== null && passRate < 70) return {
      color: '#dc2626',
      title: 'Legitimate mail may be blocked',
      body: `Pass rate is ${passRate}% under a reject policy — some of your own mail is likely being rejected by recipients. Check the failing sources below urgently.`,
    };
    return {
      color: '#16a34a',
      title: 'Fully protected',
      body: `DMARC is enforced at reject. Pass rate is ${passRate ?? '—'}%. Spoofed mail claiming to be from ${domain.domain} is rejected by receiving servers.`,
    };
  }

  return { color: '#6b7280', title: 'Unknown policy', body: 'Could not determine guidance for the current policy.' };
}

const CHART_WINDOWS = [
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
  { label: '60d', days: 60 },
];

export function DomainDetail({ id, onUnauthorized }: Props) {
  const [domain, setDomain] = useState<Domain | null>(null);
  const [allDomains, setAllDomains] = useState<Domain[]>([]);
  const [stats, setStats] = useState<DomainStats | null>(null);
  const [chartDays, setChartDays] = useState(7);
  const [sources, setSources] = useState<FailingSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [dnsOk, setDnsOk] = useState<boolean | null>(null);
  const [currentRecord, setCurrentRecord] = useState<string | null>(null);
  const [spfFlat, setSpfFlat] = useState<SpfFlatStatus | null>(null);
  const [spfFlatBusy, setSpfFlatBusy] = useState(false);
  const [spfFlatError, setSpfFlatError] = useState<string | null>(null);
  const [mtaSts, setMtaSts] = useState<MtaStsStatus | null>(null);
  const [mtaStsBusy, setMtaStsBusy] = useState(false);
  const [mtaStsError, setMtaStsError] = useState<string | null>(null);
  const [wizardState, setWizardState] = useState<WizardState | null>(null);
  const [rollout, setRollout] = useState<RolloutNext | null>(null);
  const [rolloutBusy, setRolloutBusy] = useState(false);
  const [rolloutError, setRolloutError] = useState<string | null>(null);
  const [showRolloutModal, setShowRolloutModal] = useState(false);
  const [cfManaged, setCfManaged] = useState(false);
  const mobile = useIsMobile();

  // Initial load: domain info + failing sources (don't depend on chartDays)
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [{ domains }, src, flat, mta, ws] = await Promise.all([
          getDomains(),
          getDomainSources(id, 7),
          getSpfFlattenStatus(id).catch(() => null),
          getMtaStsStatus(id).catch(() => null),
          getWizardState(id).catch(() => null),
        ]);
        if (cancelled) return;
        setDomain(domains.find((d) => d.id === id) ?? null);
        setAllDomains(domains);
        setSources(src.sources);
        if (flat) setSpfFlat(flat);
        if (mta) setMtaSts(mta);
        if (ws) setWizardState(ws);
      } catch (e: any) {
        if (cancelled) return;
        if (e.message === '401') { onUnauthorized(); return; }
        setError(e.message ?? 'Failed to load');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [id]);

  // Rollout state — fetch after initial load (stats must be loaded first)
  useEffect(() => {
    if (!stats) return;
    getRolloutNext(id).then(setRollout).catch(() => {});
  }, [id, stats]);

  // Chart stats — refetch when chartDays changes
  useEffect(() => {
    let cancelled = false;
    getDomainStats(id, chartDays)
      .then(st => { if (!cancelled) setStats(st); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [id, chartDays]);

  const total = stats ? stats.stats.reduce((n, r) => n + r.total, 0) : 0;

  // DNS check on load — detects current record for comparison + CF-managed flag
  useEffect(() => {
    if (!stats) return;
    checkDomainDns(id)
      .then(({ found, has_rua, current_record, cf_managed }) => {
        setDnsOk(found && has_rua);
        setCurrentRecord(current_record);
        setCfManaged(cf_managed);
      })
      .catch(() => {});
  }, [id, stats]);

  if (loading) return <p style={s.muted}>Loading…</p>;
  if (error) return <p style={{ color: '#dc2626' }}>Error: {error}</p>;
  if (!domain || !stats) return <p style={s.muted}>Domain not found.</p>;

  const passed = stats.stats.reduce((n, r) => n + r.passed, 0);
  const failed = stats.stats.reduce((n, r) => n + r.failed, 0);
  const passRate = total > 0 ? Math.round((passed / total) * 100) : null;
  const maxTotal = Math.max(...stats.stats.map((r) => r.total), 1);
  const policy = domain.dmarc_policy ?? 'none';
  const guidance = getGuidance(domain, passRate, total > 0, currentRecord);

  // Subdomain / parent context
  const subdomains = allDomains.filter((d) => d.parent_id === domain.id);
  const parentDomain = domain.parent_id ? allDomains.find((d) => d.id === domain.parent_id) : null;
  // Parse sp= from the raw DNS record (if available)
  const spTag = currentRecord ? (currentRecord.match(/\bsp=([a-z]+)/)?.[1] ?? null) : null;

  const copy = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  // Sidebar content — rendered inline on mobile (above main content) or as right column on desktop
  const showSpfSidebar = spfFlat && (spfFlat.available || spfFlat.config);
  const showMtaStsSidebar = mtaSts && (mtaSts.available || mtaSts.config);
  const hasSidebar = showSpfSidebar || showMtaStsSidebar;

  const sidebar = hasSidebar ? (
    <div style={{
      width: mobile ? '100%' : '280px',
      flexShrink: 0,
      display: 'flex',
      flexDirection: 'column' as const,
      gap: '0.75rem',
      ...(mobile ? { marginBottom: '1.5rem' } : {}),
    }}>
      <h3 style={{ ...s.sectionTitle, marginBottom: 0 }}>DNS Tools</h3>

      {showSpfSidebar && (() => {
        const config = spfFlat!.config;
        const lookupCount = spfFlat!.lookup_count ?? config?.lookup_count ?? null;
        const isActive = !!config?.enabled;
        const isOver = lookupCount !== null && lookupCount >= 10;
        const isHigh = lookupCount !== null && lookupCount >= 8;
        const countColor = isOver ? '#b91c1c' : isHigh ? '#92400e' : '#15803d';
        const countBg = isOver ? '#fee2e2' : isHigh ? '#fef3c7' : '#dcfce7';
        const borderColor = isActive ? '#16a34a' : isOver ? '#dc2626' : isHigh ? '#d97706' : '#e5e7eb';

        return (
          <div style={{
            border: '1px solid #e5e7eb', borderLeft: `3px solid ${borderColor}`,
            borderRadius: '6px', padding: '0.75rem',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap', marginBottom: '0.35rem' }}>
              <span style={{ fontWeight: 700, fontSize: '0.8rem' }}>SPF Flattening</span>
              {isActive ? (
                <span style={{ padding: '1px 6px', borderRadius: '9999px', fontSize: '0.68rem', fontWeight: 700, color: '#15803d', background: '#dcfce7' }}>
                  Active
                </span>
              ) : lookupCount !== null ? (
                <span style={{ padding: '1px 6px', borderRadius: '9999px', fontSize: '0.68rem', fontWeight: 700, color: countColor, background: countBg }}>
                  {lookupCount}/10 lookups
                </span>
              ) : (
                <span style={{ padding: '1px 6px', borderRadius: '9999px', fontSize: '0.68rem', fontWeight: 700, color: '#6b7280', background: '#f3f4f6' }}>
                  Available
                </span>
              )}
            </div>
            {isActive ? (
              <>
                <p style={{ margin: '0 0 0.4rem', fontSize: '0.75rem', color: '#6b7280', lineHeight: 1.4 }}>
                  {config!.ip_count ?? '?'} IPs — re-resolved daily.
                </p>
                <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                  <a href={`#/domains/${id}/spf-flatten`} style={s.sidebarLink}>Configure →</a>
                  <button
                    onClick={async () => {
                      setSpfFlatBusy(true); setSpfFlatError(null);
                      try {
                        await disableSpfFlatten(id);
                        setSpfFlat({ available: spfFlat!.available, config: null, lookup_count: spfFlat!.lookup_count ?? null });
                      } catch (e: any) { setSpfFlatError(e.message ?? 'Failed'); }
                      finally { setSpfFlatBusy(false); }
                    }}
                    disabled={spfFlatBusy}
                    style={s.sidebarDisableBtn}
                  >
                    {spfFlatBusy ? '…' : 'Disable'}
                  </button>
                </div>
              </>
            ) : (
              <>
                <p style={{ margin: '0 0 0.4rem', fontSize: '0.75rem', color: '#6b7280', lineHeight: 1.4 }}>
                  Resolve SPF includes to raw IPs to stay under the 10-lookup limit.
                </p>
                <a href={`#/domains/${id}/spf-flatten`} style={s.sidebarLink}>Configure →</a>
              </>
            )}
            {spfFlatError && <p style={{ margin: '0.3rem 0 0', fontSize: '0.72rem', color: '#dc2626' }}>{spfFlatError}</p>}
          </div>
        );
      })()}

      {showMtaStsSidebar && (() => {
        const config = mtaSts!.config;
        const isActive = !!config?.enabled;
        const mode = config?.mode ?? 'testing';
        const modeColor = mode === 'enforce' ? '#15803d' : '#1d4ed8';
        const modeBg = mode === 'enforce' ? '#dcfce7' : '#dbeafe';
        const borderColor = isActive ? (mode === 'enforce' ? '#16a34a' : '#2563eb') : '#e5e7eb';

        return (
          <div style={{
            border: '1px solid #e5e7eb', borderLeft: `3px solid ${borderColor}`,
            borderRadius: '6px', padding: '0.75rem',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap', marginBottom: '0.35rem' }}>
              <span style={{ fontWeight: 700, fontSize: '0.8rem' }}>MTA-STS</span>
              {isActive ? (
                <span style={{ padding: '1px 6px', borderRadius: '9999px', fontSize: '0.68rem', fontWeight: 700, color: modeColor, background: modeBg }}>
                  {mode}
                </span>
              ) : (
                <span style={{ padding: '1px 6px', borderRadius: '9999px', fontSize: '0.68rem', fontWeight: 700, color: '#6b7280', background: '#f3f4f6' }}>
                  Available
                </span>
              )}
            </div>
            {isActive ? (
              <>
                <p style={{ margin: '0 0 0.4rem', fontSize: '0.75rem', color: '#6b7280', lineHeight: 1.4 }}>
                  Enforcing TLS for inbound mail ({mode} mode).
                </p>
                <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                  <a href={`#/domains/${id}/mta-sts`} style={s.sidebarLink}>Configure →</a>
                  <button
                    onClick={async () => {
                      setMtaStsBusy(true); setMtaStsError(null);
                      try {
                        await disableMtaSts(id);
                        setMtaSts({ available: mtaSts!.available, config: null, summary: null });
                      } catch (e: any) { setMtaStsError(e.message ?? 'Failed'); }
                      finally { setMtaStsBusy(false); }
                    }}
                    disabled={mtaStsBusy}
                    style={s.sidebarDisableBtn}
                  >
                    {mtaStsBusy ? '…' : 'Disable'}
                  </button>
                </div>
              </>
            ) : (
              <>
                <p style={{ margin: '0 0 0.4rem', fontSize: '0.75rem', color: '#6b7280', lineHeight: 1.4 }}>
                  Enforce TLS and collect failure reports for inbound mail.
                </p>
                <a href={`#/domains/${id}/mta-sts`} style={s.sidebarLink}>Configure →</a>
              </>
            )}
            {mtaStsError && <p style={{ margin: '0.3rem 0 0', fontSize: '0.72rem', color: '#dc2626' }}>{mtaStsError}</p>}
          </div>
        );
      })()}
    </div>
  ) : null;

  const mainContent = (
    <div style={{ flex: 1, minWidth: 0 }}>
      {wizardState && Object.values(wizardState).some(v => v !== 'complete') && (() => {
        const done = Object.values(wizardState).filter(v => v === 'complete').length;
        const total_ = Object.values(wizardState).length;
        const stepKeys = ['domain', 'spf', 'dkim', 'dmarc', 'routing'] as const;
        const firstIncomplete = stepKeys.findIndex((k, i) => i > 0 && wizardState[k] !== 'complete');
        const targetStep = firstIncomplete > 0 ? firstIncomplete + 1 : 2;
        return (
          <a href={`#/domains/${id}/setup/${targetStep}`} style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            gap: '0.75rem', flexWrap: 'wrap',
            background: '#fffbeb', border: '1px solid #fde68a',
            borderRadius: '8px', padding: '0.6rem 1rem', marginBottom: '1rem',
            fontSize: '0.875rem', color: '#92400e', textDecoration: 'none',
          }}>
            <span>Setup incomplete — {done}/{total_} steps done</span>
            <span style={{ fontWeight: 600, flexShrink: 0 }}>Continue setup →</span>
          </a>
        );
      })()}

      {/* Summary numbers */}
      <div style={{ ...s.summaryRow, flexWrap: 'wrap', gap: mobile ? '1rem' : '2rem' }}>
        <Stat label="Pass rate" value={passRate !== null ? `${passRate}%` : '—'} accent mobile={mobile} />
        <Stat label="Total" value={total.toLocaleString()} mobile={mobile} />
        <Stat label="Passed" value={passed.toLocaleString()} mobile={mobile} />
        <Stat label="Failed" value={failed.toLocaleString()} mobile={mobile} />
      </div>

      {/* Guidance */}
      <div style={{ ...s.guidanceCard, borderLeftColor: guidance.color }}>
        <div style={{ ...s.guidanceTitle, color: guidance.color }}>{guidance.title}</div>
        <p style={s.guidanceBody}>{guidance.body}</p>
        {guidance.action && guidance.action.targetPolicy && (
          <div style={s.guidanceAction}>
            <a
              href={`#/domains/${id}/dmarc-wizard`}
              style={s.upgradeBtn}
            >
              Upgrade to {guidance.action.targetPolicy} →
            </a>
          </div>
        )}
        {total === 0 && dnsOk !== null && (
          <p style={{ ...s.guidanceBody, marginTop: '0.5rem', fontStyle: 'italic' }}>
            {dnsOk
              ? '✓ DNS record detected — reports will start arriving soon.'
              : '⚠️ DNS record not found yet. Make sure you\'ve added it, then wait a few minutes for propagation.'}
          </p>
        )}
      </div>

      {/* Rollout progress (T007+T008+T011+T012) */}
      {rollout && rollout.current_policy !== 'none' && rollout.current_policy !== null && (
        <div style={{ border: '1px solid #e5e7eb', borderRadius: '8px', padding: '0.75rem 1rem', marginBottom: '1rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '0.5rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 700, fontSize: '0.85rem' }}>Rollout progress</span>
              <span style={{ fontSize: '0.78rem', color: '#6b7280' }}>
                {rollout.current_policy === 'quarantine' ? 'Quarantine' : 'Reject'}{rollout.current_testing ? ' (testing, t=y)' : ''}
              </span>
              {rollout.behind_schedule && (
                <span style={{ padding: '1px 6px', borderRadius: '9999px', fontSize: '0.68rem', fontWeight: 700, color: '#92400e', background: '#fef3c7' }}>
                  Behind schedule
                </span>
              )}
            </div>
            {rollout.next_step && (
              <button
                style={{ ...s.copyBtn, background: rollout.blocked ? '#f3f4f6' : '#2563eb', color: rollout.blocked ? '#9ca3af' : '#fff', borderColor: rollout.blocked ? '#e5e7eb' : '#2563eb', cursor: rollout.blocked ? 'not-allowed' : 'pointer' }}
                onClick={() => { if (!rollout.blocked) setShowRolloutModal(true); }}
                disabled={rollout.blocked}
                title={rollout.block_reason ?? undefined}
              >
                Advance policy →
              </button>
            )}
            {!rollout.next_step && (
              <span style={{ padding: '1px 8px', borderRadius: '9999px', fontSize: '0.72rem', fontWeight: 700, color: '#15803d', background: '#dcfce7' }}>
                Fully graduated
              </span>
            )}
          </div>
          {/* Progress bar */}
          <div style={{ height: '6px', background: '#f3f4f6', borderRadius: '999px', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${Math.round(((rollout.current_step_index + 1) / rollout.total_steps) * 100)}%`, background: '#2563eb', borderRadius: '999px', transition: 'width 0.3s' }} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.68rem', color: '#9ca3af', marginTop: '0.2rem' }}>
            <span>Step {rollout.current_step_index + 1} of {rollout.total_steps}</span>
            <span>{rollout.current_step_index + 1 < rollout.total_steps ? `Next: ${rollout.next_step?.policy}${rollout.next_step?.testing ? ' (testing, t=y)' : ''}` : 'Complete'}</span>
          </div>
          {rollout.blocked && rollout.block_reason && (
            <p style={{ margin: '0.4rem 0 0', fontSize: '0.75rem', color: '#b45309', background: '#fef3c7', borderRadius: '4px', padding: '0.3rem 0.5rem' }}>
              ⚠ {rollout.block_reason}
            </p>
          )}
          {rollout.has_unknown_senders && !rollout.blocked && (
            <p style={{ margin: '0.4rem 0 0', fontSize: '0.75rem', color: '#6b7280' }}>
              Note: unknown senders still seen in the last 7 days — verify all legitimate senders are configured before advancing.
            </p>
          )}
          {rolloutError && <p style={{ margin: '0.3rem 0 0', fontSize: '0.72rem', color: '#dc2626' }}>{rolloutError}</p>}
        </div>
      )}

      {/* Rollout advance modal */}
      {showRolloutModal && rollout?.next_step && rollout.dns_preview && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem' }}
          onClick={(e) => { if (e.target === e.currentTarget) setShowRolloutModal(false); }}>
          <div style={{ background: '#fff', borderRadius: '10px', padding: '1.25rem', maxWidth: '520px', width: '100%', boxShadow: '0 10px 40px rgba(0,0,0,0.15)' }}>
            <h3 style={{ margin: '0 0 0.75rem', fontSize: '1rem', fontWeight: 700 }}>
              Advance to {rollout.next_step.policy}{rollout.next_step.testing ? ' (testing, t=y)' : ''}
            </h3>
            <p style={{ margin: '0 0 0.5rem', fontSize: '0.8rem', color: '#6b7280' }}>
              Update your <code>_dmarc.{domain.domain}</code> TXT record to:
            </p>
            <div style={{ ...s.dnsRow, flexWrap: 'wrap', marginBottom: '0.75rem' }}>
              <code style={{ ...s.dnsCode, flex: 1 }}>{rollout.dns_preview}</code>
              <button style={s.copyBtn} onClick={() => copy(rollout.dns_preview!)}>
                {copied ? 'Copied!' : 'Copy'}
              </button>
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
              <button style={{ ...s.copyBtn }} onClick={() => setShowRolloutModal(false)}>Cancel</button>
              <button
                style={{ ...s.copyBtn, background: '#2563eb', color: '#fff', borderColor: '#2563eb', opacity: rolloutBusy ? 0.6 : 1 }}
                disabled={rolloutBusy}
                onClick={async () => {
                  setRolloutBusy(true); setRolloutError(null);
                  try {
                    await advanceRollout(id, rollout!.next_step!.policy, rollout!.next_step!.testing);
                    const updated = await getRolloutNext(id);
                    setRollout(updated);
                    setShowRolloutModal(false);
                  } catch (e: any) {
                    setRolloutError(e.message ?? 'Failed');
                  } finally {
                    setRolloutBusy(false);
                  }
                }}
              >
                {rolloutBusy ? 'Saving…' : 'Mark as applied'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Daily bars */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem', flexWrap: 'wrap', gap: '0.5rem' }}>
        <h3 style={{ ...s.sectionTitle, marginBottom: 0 }}>Last {chartDays} days</h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <div style={{ display: 'flex', gap: '0.25rem' }}>
            {CHART_WINDOWS.map(w => (
              <button
                key={w.days}
                style={{ ...s.chartPill, ...(chartDays === w.days ? s.chartPillActive : {}) }}
                onClick={() => setChartDays(w.days)}
              >
                {w.label}
              </button>
            ))}
          </div>
          <a href={`#/domains/${id}/reports`} style={s.viewAll}>All reports →</a>
        </div>
      </div>
      {stats.stats.length === 0 && <p style={s.muted}>No data yet.</p>}
      <div style={{ ...s.bars, marginBottom: '2rem' }}>
        {stats.stats.map((row) => {
          const passW = (row.passed / maxTotal) * 100;
          const failW = (row.failed / maxTotal) * 100;
          const label = chartDays <= 7 ? row.day.slice(5) : row.day.slice(5).replace('-', '/');
          return (
            <a key={row.day} href={`#/domains/${id}/reports/${row.day}`} style={s.barRow}>
              <span style={{ ...s.dayLabel, fontSize: chartDays > 7 ? '0.65rem' : undefined }}>{label}</span>
              <div style={s.barTrack}>
                <div style={{ ...s.barPass, width: `${passW}%` }} />
                <div style={{ ...s.barFail, width: `${failW}%` }} />
              </div>
              {!mobile && <span style={s.barCount}>{row.total.toLocaleString()}</span>}
            </a>
          );
        })}
      </div>

      {/* RUA config */}
      <div style={s.ruaBox}>
        <div style={s.ruaLabel}>RUA reporting address</div>
        <div style={{ ...s.dnsRow, flexWrap: 'wrap' }}>
          <code style={s.dnsCode}>rua=mailto:{domain.rua_address}</code>
          <button style={s.copyBtn} onClick={() => copy(`rua=mailto:${domain.rua_address}`)}>
            {copied ? 'Copied!' : 'Copy'}
          </button>
        </div>
        <p style={s.ruaHint}>
          Add this to your <code style={s.inlineCode}>_dmarc.{domain.domain}</code> TXT record so receiving servers send DMARC reports here.
        </p>
      </div>

      {/* Subdomain inheritance badge (T016) — shown when viewing a subdomain */}
      {parentDomain && (
        <div style={{ ...s.inheritanceBanner, ...(dnsOk ? s.inheritanceOwn : s.inheritanceInherits) }}>
          {dnsOk
            ? <>Has own DMARC record (<strong>p={policy}</strong>) — overrides parent <a href={`#/domains/${parentDomain.id}`} style={{ color: 'inherit' }}>{parentDomain.domain}</a>.</>
            : <>Inherits DMARC from <a href={`#/domains/${parentDomain.id}`} style={{ color: 'inherit' }}>{parentDomain.domain}</a>
                {parentDomain.dmarc_policy && <> (p={parentDomain.dmarc_policy})</>}. SPF and DKIM are independent — not inherited.</>
          }
        </div>
      )}

      {/* Subdomains section (T015) — shown when viewing an apex domain */}
      {subdomains.length > 0 && (
        <div style={{ marginBottom: '2rem' }}>
          <div style={s.sectionHeader}>
            <h3 style={s.sectionTitle}>Subdomains</h3>
            <a href="#/add" style={s.viewAll}>+ Add subdomain →</a>
          </div>
          {spTag && (
            <div style={{ ...s.inheritanceBanner, ...(spTag === 'reject' ? s.inheritanceOwn : s.inheritanceInherits), marginBottom: '0.75rem' }}>
              {spTag === 'reject'
                ? <>Subdomain policy: <strong>sp=reject</strong> — all subdomains without their own record are protected.</>
                : <><strong>sp={spTag}</strong> — subdomains without their own DMARC record are NOT enforced. Consider adding sp=reject.</>
              }
            </div>
          )}
          {!spTag && currentRecord && (
            <div style={{ ...s.inheritanceBanner, ...s.inheritanceInherits, marginBottom: '0.75rem' }}>
              No sp= tag in your DMARC record. Subdomains without their own record inherit p={policy} — which may be too permissive.
            </div>
          )}
          {subdomains.map((sub) => (
            <a key={sub.id} href={`#/domains/${sub.id}`} style={s.subdomainRow}>
              <span style={{ flex: 1 }}>└ {sub.domain}</span>
              <span style={{ ...s.badge, color: POLICY_COLOR[sub.dmarc_policy ?? 'none'] ?? '#6b7280', marginRight: '0.5rem' }}>
                {sub.dmarc_policy ?? '—'}
              </span>
              <span style={s.muted}>→</span>
            </a>
          ))}
        </div>
      )}

      {/* Failing sources */}
      {sources.length > 0 && (
        <div>
          <div style={s.sectionHeader}>
            <h3 style={s.sectionTitle}>Top failing sources</h3>
            <a href={`#/domains/${id}/anomalies`} style={{ ...s.viewAll, marginRight: '0.75rem' }}>Anomalies →</a>
            <a href={`#/domains/${id}/explore`} style={s.viewAll}>Explore sources →</a>
          </div>
          {mobile ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {sources.map((src) => (
                <div key={src.source_ip} style={s.sourceCard}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    {(src.org || src.base_domain)
                      ? <span style={{ fontWeight: 600, fontSize: '0.875rem', color: '#111827' }}>{src.org ?? src.base_domain}</span>
                      : <code style={s.code}>{src.source_ip}</code>
                    }
                    <span style={s.muted}>{src.total.toLocaleString()} msg</span>
                  </div>
                  {(src.org || src.base_domain) && <code style={{ fontFamily: 'monospace', fontSize: '0.75rem', color: '#9ca3af' }}>{src.source_ip}</code>}
                  {src.header_from && <div style={{ fontSize: '0.8rem', color: '#6b7280', marginTop: '0.2rem' }}>{src.header_from}</div>}
                </div>
              ))}
            </div>
          ) : (
            <table style={s.table}>
              <thead>
                <tr>
                  {['Source', 'Sending as', 'Failed messages'].map((h) => (
                    <th key={h} style={s.th}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sources.map((src) => (
                  <tr key={src.source_ip}>
                    <td style={s.td}>
                      {(src.org || src.base_domain)
                        ? <span style={{ fontWeight: 600, color: '#111827' }}>{src.org ?? src.base_domain}</span>
                        : <code style={s.code}>{src.source_ip}</code>
                      }
                      {(src.org || src.base_domain) && <code style={{ fontFamily: 'monospace', fontSize: '0.72rem', color: '#9ca3af' }}>{src.source_ip}</code>}
                    </td>
                    <td style={s.td}>{src.header_from ?? <span style={s.muted}>—</span>}</td>
                    <td style={{ ...s.td, textAlign: 'right' }}>{src.total.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );

  return (
    <div>
      <a href="#/" style={s.back}>← All domains</a>

      <div style={s.header}>
        <h2 style={s.domainName}>{domain.domain}</h2>
        <span style={{ ...s.badge, color: POLICY_COLOR[policy] ?? '#6b7280' }}>{policy}</span>
        <a href={`#/domains/${id}/settings`} style={s.settingsLink}>Settings</a>
      </div>

      {mobile ? (
        <div>
          {sidebar}
          {mainContent}
        </div>
      ) : (
        <div style={{ display: 'flex', gap: '2rem' }}>
          {mainContent}
          {sidebar}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, accent, mobile }: { label: string; value: string; accent?: boolean; mobile?: boolean }) {
  return (
    <div style={{ ...s.stat, minWidth: mobile ? 'calc(50% - 0.5rem)' : 'auto' }}>
      <div style={{ ...s.statValue, color: accent ? '#111827' : '#374151' }}>{value}</div>
      <div style={s.statLabel}>{label}</div>
    </div>
  );
}

const s = {
  back: { fontSize: '0.875rem', color: '#6b7280', textDecoration: 'none', display: 'inline-block', marginBottom: '1.25rem' } as const,
  header: { display: 'flex', alignItems: 'baseline', gap: '0.75rem', marginBottom: '1.5rem', flexWrap: 'wrap' as const },
  domainName: { margin: 0, fontSize: '1.5rem', fontWeight: 700 },
  badge: { fontSize: '0.8rem', fontWeight: 600, textTransform: 'uppercase' as const, letterSpacing: '0.05em' },
  summaryRow: { display: 'flex', padding: '1.25rem 0', borderTop: '1px solid #e5e7eb', borderBottom: '1px solid #e5e7eb', marginBottom: '2rem' } as const,
  stat: { display: 'flex', flexDirection: 'column' as const, gap: '0.25rem' },
  statValue: { fontSize: '1.5rem', fontWeight: 700 },
  statLabel: { fontSize: '0.75rem', color: '#9ca3af', textTransform: 'uppercase' as const, letterSpacing: '0.05em' },
  guidanceCard: { borderLeft: '3px solid', padding: '1rem 1.25rem', background: '#f9fafb', borderRadius: '0 6px 6px 0', marginBottom: '2rem' } as const,
  guidanceTitle: { fontWeight: 600, marginBottom: '0.4rem', fontSize: '0.95rem' } as const,
  guidanceBody: { margin: '0 0 0.75rem', color: '#374151', fontSize: '0.9rem', lineHeight: 1.6 } as const,
  guidanceAction: { display: 'flex', flexDirection: 'column' as const, gap: '0.4rem' },
  guidanceActionLabel: { fontSize: '0.8rem', color: '#6b7280' } as const,
  upgradeBtn: { display: 'inline-block', padding: '0.4rem 1rem', background: '#111827', color: '#fff', borderRadius: '6px', fontSize: '0.875rem', fontWeight: 600, textDecoration: 'none', alignSelf: 'flex-start' as const } as const,
  dnsRow: { display: 'flex', alignItems: 'center', gap: '0.5rem' } as const,
  dnsCode: { flex: 1, minWidth: 0, padding: '0.4rem 0.6rem', background: '#fff', border: '1px solid #e5e7eb', borderRadius: '4px', fontSize: '0.8rem', fontFamily: 'monospace', overflowX: 'auto' as const, whiteSpace: 'nowrap' as const },
  copyBtn: { padding: '0.35rem 0.75rem', background: '#111827', color: '#fff', border: 'none', borderRadius: '4px', fontSize: '0.8rem', cursor: 'pointer', flexShrink: 0, whiteSpace: 'nowrap' as const },
  sectionHeader: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: '1rem' } as const,
  sectionTitle: { fontSize: '0.875rem', fontWeight: 600, color: '#6b7280', textTransform: 'uppercase' as const, letterSpacing: '0.05em', margin: 0 },
  viewAll: { fontSize: '0.8rem', color: '#6b7280', textDecoration: 'none' } as const,
  chartPill: { padding: '0.15rem 0.5rem', border: '1px solid #e5e7eb', borderRadius: '20px', fontSize: '0.75rem', cursor: 'pointer', background: '#fff', color: '#6b7280', fontFamily: 'inherit' } as const,
  chartPillActive: { background: '#111827', color: '#fff', borderColor: '#111827' } as const,
  bars: { display: 'flex', flexDirection: 'column' as const, gap: '0.5rem' },
  barRow: { display: 'flex', alignItems: 'center', gap: '0.75rem', textDecoration: 'none', color: 'inherit', borderRadius: '4px', padding: '2px 4px', margin: '0 -4px' } as const,
  dayLabel: { width: '3rem', fontSize: '0.8rem', color: '#6b7280', flexShrink: 0 } as const,
  barTrack: { flex: 1, height: '8px', borderRadius: '4px', background: '#f3f4f6', overflow: 'hidden', display: 'flex' } as const,
  barPass: { height: '100%', background: '#16a34a', transition: 'width 0.3s' } as const,
  barFail: { height: '100%', background: '#dc2626', transition: 'width 0.3s' } as const,
  barCount: { width: '4rem', fontSize: '0.8rem', color: '#9ca3af', textAlign: 'right' as const, flexShrink: 0 },
  ruaBox: { padding: '1rem 1.25rem', border: '1px solid #e5e7eb', borderRadius: '6px', marginBottom: '2rem' } as const,
  ruaLabel: { fontSize: '0.75rem', fontWeight: 600, color: '#6b7280', textTransform: 'uppercase' as const, letterSpacing: '0.05em', marginBottom: '0.5rem' },
  ruaHint: { margin: '0.5rem 0 0', fontSize: '0.8rem', color: '#9ca3af', lineHeight: 1.5 } as const,
  inlineCode: { fontFamily: 'monospace', fontSize: '0.8rem', color: '#374151' } as const,
  muted: { color: '#9ca3af', fontSize: '0.875rem' } as const,
  table: { width: '100%', borderCollapse: 'collapse' as const, fontSize: '0.875rem' },
  th: { textAlign: 'left' as const, padding: '0.5rem 0.75rem', borderBottom: '1px solid #e5e7eb', fontSize: '0.75rem', color: '#6b7280', fontWeight: 600, textTransform: 'uppercase' as const, letterSpacing: '0.05em' },
  td: { padding: '0.6rem 0.75rem', borderBottom: '1px solid #f3f4f6', color: '#374151' } as const,
  code: { fontFamily: 'monospace', fontSize: '0.8rem', color: '#111827' } as const,
  settingsLink: { marginLeft: 'auto', fontSize: '0.8rem', color: '#6b7280', textDecoration: 'none' } as const,
  sourceCard: { padding: '0.75rem', border: '1px solid #f3f4f6', borderRadius: '6px', background: '#fff' } as const,
  sidebarLink: { fontSize: '0.75rem', color: '#2563eb', textDecoration: 'none', fontWeight: 600 } as const,
  sidebarDisableBtn: {
    padding: '0.15rem 0.5rem', fontSize: '0.72rem', cursor: 'pointer',
    background: '#fff', color: '#6b7280', border: '1px solid #d1d5db',
    borderRadius: '4px', fontFamily: 'inherit',
  } as const,
  inheritanceBanner: {
    fontSize: '0.85rem', lineHeight: 1.5,
    padding: '0.6rem 0.85rem', borderRadius: '6px', marginBottom: '2rem',
  } as const,
  inheritanceInherits: { background: '#fffbeb', color: '#92400e' } as const,
  inheritanceOwn: { background: '#f0fdf4', color: '#15803d' } as const,
  subdomainRow: {
    display: 'flex', alignItems: 'center', gap: '0.5rem',
    padding: '0.5rem 0.75rem', borderBottom: '1px solid #f3f4f6',
    textDecoration: 'none', color: '#374151', fontSize: '0.875rem',
    borderRadius: '4px',
  } as const,
};
