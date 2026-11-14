import { assessDomain, type LevelAssessment } from './levels';

/** GET /api/domains/claims/:id/preview: public DNS only, nothing stored (src/domains/claim-preview.ts). */
export interface ClaimPreviewData {
	domain: string;
	checked_at: string;
	source: 'public_dns';
	cached: boolean;
	nxdomain: boolean;
	spf: { status: 'found' | 'missing' | 'error'; record: string | null; lookup_count: number | null; over_limit: boolean };
	/** `pct`: pct= of the record that applies (100 when absent), null without a usable record; absent from older servers. */
	dmarc: { status: 'found' | 'missing' | 'error'; policy: string | null; issue: 'multiple' | 'invalid' | null; inherited_from: string | null; record: string | null; pct?: number | null };
	dkim: { status: 'found' | 'not_found' | 'wildcard' | 'error'; selectors: string[]; scanned: number; failed: number };
	mx: { status: 'found' | 'none' | 'error' };
	lookup_failed: string[];
}

/**
 * The level and the SPF/DMARC findings for a preview, from the overview's own `assessDomain`, fed the same facts the daily refresh
 * stores: so the preview and the overview card cannot word or judge the same DNS answers differently. Null when SPF or DMARC could
 * not be read (no level is guessed) or the domain does not exist.
 */
export function previewAssessment(p: ClaimPreviewData): LevelAssessment | null {
	if (p.nxdomain || p.spf.status === 'error' || p.dmarc.status === 'error') return null;
	return assessDomain({
		spf_record: p.spf.status === 'found' ? p.spf.record : null,
		dmarc_policy: p.dmarc.policy,
		dmarc_issue: p.dmarc.issue,
		dmarc_inherited_from: p.dmarc.inherited_from,
		// The same SPF lookup and pct= judgments as the overview, from the same read.
		spf_lookup_count: p.spf.lookup_count,
		dmarc_pct: p.dmarc.pct,
		dns_checked_at: Math.floor(Date.parse(p.checked_at) / 1000),
		dkim_total: 0,
		dkim_pass: 0,
		spf_total: 0,
		spf_pass: 0,
		mta_sts_enabled: 0,
		mta_sts_mode: null,
	});
}

