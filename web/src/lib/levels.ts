import type { Finding, Level } from '@inbox-angel/ui';
import { formatPercent } from './format';
import type { DomainCheckSummary } from './types';

/**
 * Where a domain stands, from what InboxAngel already knows (domain row + check summary).
 *
 *  - Level 0 Delivering:    mail goes out, but SPF or DMARC is missing, so receivers cannot verify it.
 *  - Level 1 Authenticated: SPF and a DMARC record exist; DMARC only monitors (p=none).
 *  - Level 2 Protected:     DMARC enforces (p=quarantine or p=reject) on top of SPF.
 *
 * "Not found" here means a lookup that worked and found nothing. A lookup that failed never reaches this
 * function: callers show an error state instead of a level, so a resolver outage cannot downgrade a domain.
 */
export interface LevelAssessment {
	level: Level;
	description: string;
	findings: Finding[];
	/** One sentence on the next step, or null at the top level. */
	next: string | null;
}

const DKIM_HEALTHY = 0.95;

export function assessDomain(s: Pick<DomainCheckSummary, 'dmarc_policy' | 'spf_record' | 'dkim_total' | 'dkim_pass' | 'spf_total' | 'spf_pass' | 'mta_sts_enabled' | 'mta_sts_mode'>): LevelAssessment {
	const hasSpf = !!s.spf_record;
	const policy = s.dmarc_policy;
	const enforcing = policy === 'quarantine' || policy === 'reject';

	let level: Level = 0;
	if (hasSpf && policy) level = 1;
	if (hasSpf && enforcing) level = 2;

	const findings: Finding[] = [];
	findings.push(hasSpf ? { status: 'pass', label: 'SPF record published' } : { status: 'missing', label: 'SPF record', detail: 'No SPF record found. Receivers cannot tell which servers may send for you.' });

	if (!policy) findings.push({ status: 'missing', label: 'DMARC record', detail: 'No DMARC record found.' });
	else if (enforcing) findings.push({ status: 'pass', label: `DMARC enforced (p=${policy})` });
	else findings.push({ status: 'warn', label: 'DMARC is monitoring only (p=none)', detail: 'Failing mail is still delivered. Move to quarantine, then reject, when reports look clean.' });

	if (s.dkim_total > 0) {
		const ok = s.dkim_pass / s.dkim_total >= DKIM_HEALTHY;
		findings.push({ status: ok ? 'pass' : 'warn', label: `DKIM passing on ${formatPercent(s.dkim_pass, s.dkim_total)} of reported mail` });
	}
	if (s.mta_sts_enabled) findings.push({ status: 'pass', label: `MTA-STS ${s.mta_sts_mode ?? 'enabled'}` });

	const description = [
		'Mail is being sent, but receivers cannot fully verify it yet.',
		'Receivers can verify your mail. DMARC is not blocking spoofed messages yet.',
		'Spoofed mail from your domain is quarantined or rejected.',
	][level] as string;

	let next: string | null = null;
	if (!hasSpf) next = 'Publish an SPF record.';
	else if (!policy) next = 'Publish a DMARC record with p=none to start receiving reports.';
	else if (!enforcing) next = 'Review your reports, then move DMARC to quarantine.';

	return { level, description, findings, next };
}
