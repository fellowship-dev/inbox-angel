import { Button, Card, CardContent, FieldError } from '@inbox-angel/ui';
import { useQuery } from '@tanstack/react-query';
import { Section } from '../../components/states';
import { api, errorMessage } from '../../lib/api';
import { useWorkspaceId } from '../../lib/session';
interface PlanStep {
    n: number;
    action: string;
    type: string;
    name: string;
    newValue: string;
    placeholders: string[];
    expectedCurrent: string[];
}
interface DnsReport {
    generatedAt: string;
    findings: Array<{
        id: string;
        title: string;
        status: string;
        severity: string;
        evidence: string[];
        recommendation: string;
    }>;
    unchecked: string[];
    lookupFailed: Array<{
        check: string;
        message: string;
    }>;
}
interface Observation {
    id: number;
    source_report_id?: string | null;
    reporter: string;
    date_begin: number;
    date_end: number;
    received_at: number;
    receipt_age_seconds: number;
    total_count: number;
    pass_count: number;
    fail_count: number;
}
interface Provenance {
    report_count: number;
    truncated: boolean;
    observations: Observation[];
    coverage: {
        observed_dates: string[];
        missing_dates: string[];
        complete_mail_population: false;
    };
    freshness: {
        period_end_age_seconds: number | null;
        receipt_age_seconds: number | null;
    };
}
interface Evidence<T> {
    status: string;
    reason?: string;
    source: string;
    population: string;
    window: {
        since: number;
        until: number;
    };
    data: T | null;
    evidence?: Provenance;
}
interface GoogleObservation {
    sourceId: string;
    metric: string;
    definition: string;
    value: string | number;
    unit: string;
    denominator: number | null;
    periodStart: string;
    periodEnd: string;
    fetchedAt: number;
    population: string;
    filter: string | null;
}
interface Remediation {
    finding: string;
    observation: string[];
    impact: string;
    steps: string[];
    prerequisites: string[];
    changes: PlanStep[];
    verification: string[];
}
/** Projection of the shared HTTP/MCP health report; findings and fixes remain server-owned. */
export interface HealthReport {
    generatedAt: string;
    coverage: {
        detail: string;
    };
    dns: DnsReport;
    remediation: Remediation[];
    sections: {
        dmarc: Evidence<{
            messages: number;
            passed: number;
            failed: number;
            unit: string;
            denominator: number;
        }>;
        tls: Evidence<{
            total_success: number;
            total_failure: number;
            report_count: number;
            unit: string;
        }>;
        google: Evidence<{
            observations: GoogleObservation[];
            stale: boolean;
            connectionStatus: string;
            lastSuccessAt: number | null;
        }>;
        inbox_placement: Evidence<null>;
    };
}
const date = (n: number) => new Date(n * 1000).toLocaleString(undefined, { timeZone: 'America/Santiago' });
const age = (n: number | null) => n === null ? 'unavailable' : `${Math.max(0, Math.floor(n / 60))} minutes`;
function Source<T>({ title, section, children }: {
    title: string;
    section: Evidence<T>;
    children?: React.ReactNode;
}) {
    return <div className="space-y-2 min-w-0 break-words"><h4 className="font-semibold">{title}</h4><p className="text-sm">{section.status}{section.reason ? ` · ${section.reason.replaceAll('_', ' ')}` : ''}</p><p className="text-sm text-ink-2">Source: {section.source} · Requested window {date(section.window.since)} – {date(section.window.until)}</p><p className="text-sm text-ink-2">{section.population}</p>{children}{section.evidence && <><p className="text-sm text-ink-2">{section.evidence.report_count} received reports · {section.evidence.coverage.observed_dates.length} observed dates · {section.evidence.coverage.missing_dates.length} dates without report-start evidence. Coverage does not represent all mail.{section.evidence.truncated ? ' Observation list truncated.' : ''}</p><p className="text-sm text-ink-2">Latest source-period age: {age(section.evidence.freshness.period_end_age_seconds)} · Receipt age: {age(section.evidence.freshness.receipt_age_seconds)}</p>{section.evidence.observations.length > 0 && <details><summary className="cursor-pointer text-sm">Original source periods and counts</summary><ul className="space-y-2 text-sm mt-2">{section.evidence.observations.map(o => <li key={o.id}>{o.reporter}{o.source_report_id ? ` · ${o.source_report_id}` : ''}: {date(o.date_begin)} – {date(o.date_end)}; received {date(o.received_at)} ({age(o.receipt_age_seconds)} ago); {o.total_count} total, {o.pass_count} passed, {o.fail_count} failed.</li>)}</ul></details>}</>}</div>;
}
export function HealthReportSection({ domainId }: {
    domainId: number;
}) {
    const workspace = useWorkspaceId();
    const q = useQuery({ queryKey: ['health-report', workspace, domainId], queryFn: () => api<HealthReport>(`/api/domains/${domainId}/health-report`), retry: false, staleTime: 60000 });
    return <Section title="Email health report" description="The same evidence and proposed fixes available to your authorized agent.">
  {q.isPending ? <p>Checking live DNS and collected evidence…</p> : q.isError ? <div className="space-y-2"><FieldError>{errorMessage(q.error)}</FieldError><Button variant="secondary" onClick={() => void q.refetch()}>Retry health report</Button></div> : <Card><CardContent className="p-5 space-y-6 min-w-0">
   <div className="space-y-2"><p className="text-sm text-ink-2">DNS checked {new Date(q.data.dns.generatedAt).toLocaleString(undefined, { timeZone: 'America/Santiago' })} · Report generated {new Date(q.data.generatedAt).toLocaleString(undefined, { timeZone: 'America/Santiago' })}</p><p className="text-sm text-ink-2">{q.data.coverage.detail}</p><Button variant="secondary" loading={q.isFetching} onClick={() => void q.refetch()}>Refresh live report</Button></div>
   <div className="grid gap-6 lg:grid-cols-[repeat(2,minmax(0,1fr))]">
    <Source title="DMARC aggregate history" section={q.data.sections.dmarc}>{q.data.sections.dmarc.data && <p className="text-sm">{q.data.sections.dmarc.data.messages} observed messages · {q.data.sections.dmarc.data.passed} passed · {q.data.sections.dmarc.data.failed} failed · Denominator {q.data.sections.dmarc.data.denominator}</p>}</Source>
    <Source title="TLS report history" section={q.data.sections.tls}>{q.data.sections.tls.data && <p className="text-sm">{q.data.sections.tls.data.total_success} successful sessions · {q.data.sections.tls.data.total_failure} failed sessions</p>}</Source>
    <Source title="Google Postmaster" section={q.data.sections.google}>{q.data.sections.google.data && <><p className="text-sm">Connection: {q.data.sections.google.data.connectionStatus} · {q.data.sections.google.data.stale ? 'Stale cached evidence' : 'Cached provider evidence'} · Last successful fetch {q.data.sections.google.data.lastSuccessAt ? date(q.data.sections.google.data.lastSuccessAt) : 'unavailable'}</p>{q.data.sections.google.data.observations.map((o, i) => <div key={`${o.sourceId}-${i}`} className="border-t border-line pt-2 text-sm space-y-1"><p>{o.metric}: {o.value} {o.unit} · Denominator {o.denominator ?? 'unavailable'}</p><p>{o.definition} · Source observation {o.sourceId}</p><p>{o.population}{o.filter ? ` · ${o.filter}` : ''}</p><p>{o.periodStart} – {o.periodEnd} · Fetched {date(o.fetchedAt)} · Fetch age {age(Math.floor(Date.now() / 1000) - o.fetchedAt)}</p></div>)}</>}</Source>
    <Source title="Inbox placement" section={q.data.sections.inbox_placement}/>
   </div>
   <div className="space-y-4"><h3 className="font-semibold">Live configuration findings</h3>{!q.data.dns.findings.length && <p>No configuration findings returned. Unchecked areas remain listed below.</p>}{q.data.dns.findings.map(f => <article key={f.id} className="border-t border-line pt-4 space-y-2 break-words"><h4 className="font-medium">{f.title} · {f.status} · {f.severity}</h4><ul className="text-sm list-disc pl-5">{f.evidence.map((e, i) => <li key={i}>{e}</li>)}</ul><p className="text-sm">{f.recommendation}</p></article>)}{q.data.dns.unchecked.length > 0 && <p className="text-sm">Unchecked: {q.data.dns.unchecked.join(', ')}</p>}{q.data.dns.lookupFailed.map((f, i) => <p className="text-sm" key={i}>DNS lookup unavailable: {f.check} · {f.message}</p>)}</div>
   <div className="space-y-4"><h3 className="font-semibold">Proposed fixes</h3><p className="text-sm text-ink-2">These proposals do not change DNS, send mail or tighten enforcement. Verify fresh preconditions and obtain any required account-specific values before authorizing a change.</p>{q.data.remediation.map((r, i) => <article key={`${r.finding}-${i}`} className="space-y-3 border-t border-line pt-4 break-words"><h4 className="font-medium">{q.data.dns.findings.find(f => f.id === r.finding)?.title ?? r.finding}</h4><p className="text-sm">{r.impact}</p><ul className="text-sm list-disc pl-5">{r.observation.map((o, j) => <li key={j}>{o}</li>)}</ul>{r.prerequisites.length > 0 && <div><h5 className="font-medium text-sm">Prerequisites</h5><ul className="text-sm list-disc pl-5">{r.prerequisites.map((p, j) => <li key={j}>{p}</li>)}</ul></div>}<ol className="text-sm list-decimal pl-5">{r.steps.map((s, j) => <li key={j}>{s}</li>)}</ol>{r.changes.map(s => <div key={s.n} className="space-y-1 text-sm"><p>{s.action} {s.type} {s.name}</p><pre className="whitespace-pre-wrap break-all rounded bg-surface-1 p-3">{s.newValue}</pre>{s.placeholders.length > 0 && <p>Unresolved values: {s.placeholders.join(', ')}</p>}<p>Expected current: {s.expectedCurrent.join('; ') || 'No existing record'}</p></div>)}<div><h5 className="font-medium text-sm">Verification</h5><ul className="text-sm list-disc pl-5">{r.verification.map((v, j) => <li key={j}>{v}</li>)}</ul></div></article>)}</div>
  </CardContent></Card>}
 </Section>;
}
