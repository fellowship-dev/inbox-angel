import { screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { HealthReportSection } from '../src/pages/domains/HealthReportSection';
import { renderApp } from './render';
const window = { since: 1700000000, until: 1700100000 };
const source = { status: 'unavailable', reason: 'no_reports', source: 'dmarc-aggregate', window, population: 'Observed aggregate reports only', data: null, evidence: { report_count: 0, truncated: false, observations: [], coverage: { observed_dates: [], missing_dates: ['2023-11-14'], complete_mail_population: false }, freshness: { period_end_age_seconds: null, receipt_age_seconds: null } } };
it('renders fresh shared findings, absent history, exact provider units and unresolved fix prerequisites from one health model', async () => {
    renderApp(<HealthReportSection domainId={7}/>, { routes: { 'GET /api/domains/7/health-report': {
                generatedAt: '2023-11-15T00:00:00Z', coverage: { detail: 'Shared-domain observations cannot be attributed to one product.' },
                dns: { generatedAt: '2023-11-15T00:00:00Z', findings: [{ id: 'spf-missing', title: 'SPF missing', status: 'confirmed', severity: 'high', evidence: ['No SPF TXT record returned by either resolver.'], recommendation: 'Obtain the correct sender include.' }], unchecked: ['DKIM selectors unavailable'], lookupFailed: [] },
                sections: { dmarc: source, tls: { ...source, source: 'tls-rpt' }, google: { ...source, source: 'google-postmaster-v2', reason: undefined, status: 'available', data: { stale: true, connectionStatus: 'provider_error', lastSuccessAt: 1700000000, observations: [{ sourceId: 's1', metric: 'spamComplaintRate', value: 0.001, unit: 'provider-rate', denominator: null, definition: 'User-reported spam rate', population: 'Eligible Gmail traffic', periodStart: '2023-11-14', periodEnd: '2023-11-15', fetchedAt: 1700000000, filter: 'inbound' }] } }, inbox_placement: { ...source, source: 'none', reason: 'not_measured', evidence: undefined } },
                remediation: [{ finding: 'spf-missing', observation: ['No SPF TXT record returned by either resolver.'], impact: 'Senders lack an SPF policy.', steps: ['Obtain the provider value.'], prerequisites: ['Account-specific sender include is unresolved.'], changes: [{ n: 1, action: 'add', type: 'TXT', name: 'example.com', newValue: 'v=spf1 <provider> -all', placeholders: ['<provider>'], expectedCurrent: [] }], verification: ['Re-run the shared health report.'] }],
            } } });
    expect(await screen.findByRole('heading', { name: 'Live configuration findings' })).toBeInTheDocument();
    expect(screen.getAllByText('unavailable · no reports').length).toBe(2);
    expect(screen.getByText('unavailable · not measured')).toBeInTheDocument();
    expect(screen.getByText(/spamComplaintRate: 0.001 provider-rate/)).toBeInTheDocument();
    expect(screen.queryByText('0.1%')).not.toBeInTheDocument();
    expect(screen.getByText(/Stale cached evidence/)).toBeInTheDocument();
    expect(screen.getByText('Account-specific sender include is unresolved.')).toBeInTheDocument();
    expect(screen.getByText('v=spf1 <provider> -all')).toBeInTheDocument();
    expect(screen.getByText('Re-run the shared health report.')).toBeInTheDocument();
});
