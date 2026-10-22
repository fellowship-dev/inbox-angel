import type { DomainCheckSummary } from '../types';

export interface Recommendation {
	domain: string;
	severity: 'critical' | 'warning' | 'info';
	message: string;
}

function passRate(pass: number, total: number): number | null {
	if (total === 0) return null;
	return pass / total;
}

export function getRecommendations(summary: DomainCheckSummary): Recommendation[] {
	const recs: Recommendation[] = [];

	// DMARC policy
	if (!summary.dmarc_policy || summary.dmarc_policy === 'none') {
		recs.push({
			domain: summary.domain,
			severity: 'critical',
			message: 'DMARC policy is set to "none" (monitor only). Upgrade to "quarantine" or "reject" to protect against spoofing.',
		});
	} else if (summary.dmarc_policy === 'quarantine') {
		recs.push({
			domain: summary.domain,
			severity: 'warning',
			message: 'DMARC policy is "quarantine". Consider upgrading to "reject" once pass rates are stable.',
		});
	}

	// DMARC pass rate
	const dmarcRate = passRate(summary.pass_messages, summary.total_messages);
	if (dmarcRate !== null && dmarcRate < 0.95) {
		const pct = Math.round(dmarcRate * 100);
		recs.push({
			domain: summary.domain,
			severity: dmarcRate < 0.7 ? 'critical' : 'warning',
			message: `DMARC pass rate is ${pct}%. Investigate failing sources in the dashboard to improve deliverability.`,
		});
	}

	// SPF pass rate
	const spfRate = passRate(summary.spf_pass, summary.spf_total);
	if (spfRate !== null && spfRate < 0.9) {
		recs.push({
			domain: summary.domain,
			severity: 'warning',
			message: `SPF pass rate is ${Math.round(spfRate * 100)}%. Ensure all sending services are included in your SPF record.`,
		});
	}

	// DKIM pass rate
	const dkimRate = passRate(summary.dkim_pass, summary.dkim_total);
	if (dkimRate !== null && dkimRate < 0.9) {
		recs.push({
			domain: summary.domain,
			severity: 'warning',
			message: `DKIM pass rate is ${Math.round(dkimRate * 100)}%. Verify DKIM signing is configured for all sending services.`,
		});
	}

	// No messages at all
	if (summary.total_messages === 0) {
		recs.push({
			domain: summary.domain,
			severity: 'info',
			message: 'No DMARC reports received in the last 30 days. Verify the RUA address in your DMARC record is correct.',
		});
	}

	// MTA-STS not enabled
	if (!summary.mta_sts_enabled) {
		recs.push({
			domain: summary.domain,
			severity: 'info',
			message: 'MTA-STS is not enabled. Enabling it forces TLS for inbound mail delivery.',
		});
	}

	return recs;
}

export function getAllRecommendations(summaries: DomainCheckSummary[]): Recommendation[] {
	return summaries.flatMap(getRecommendations);
}
