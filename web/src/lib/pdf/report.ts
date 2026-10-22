import { jsPDF } from 'jspdf';
import type { DomainCheckSummary, DailyStat } from '../types';
import { getAllRecommendations, type Recommendation } from './recommendations';

// ── Colours & layout constants ────────────────────────────────

const PASS_COLOR: [number, number, number] = [34, 197, 94];   // green-500
const FAIL_COLOR: [number, number, number] = [239, 68, 68];   // red-500
const WARN_COLOR: [number, number, number] = [234, 179, 8];   // yellow-500
const DARK_COLOR: [number, number, number] = [30, 30, 46];    // near-black
const MUTED_COLOR: [number, number, number] = [100, 100, 120];
const PAGE_W = 210; // A4 mm
const MARGIN = 14;
const COL_W = PAGE_W - MARGIN * 2;

// ── Helpers ───────────────────────────────────────────────────

function passRate(pass: number, total: number): string {
	if (total === 0) return 'N/A';
	return `${Math.round((pass / total) * 100)}%`;
}

function statusLabel(pass: number, total: number): { label: string; color: [number, number, number] } {
	if (total === 0) return { label: 'Pending', color: MUTED_COLOR };
	const rate = pass / total;
	if (rate >= 0.95) return { label: 'Pass', color: PASS_COLOR };
	if (rate >= 0.7)  return { label: 'Warning', color: WARN_COLOR };
	return { label: 'Fail', color: FAIL_COLOR };
}

function dmarcPolicyLabel(policy: string | null): { label: string; color: [number, number, number] } {
	if (policy === 'reject')     return { label: 'reject', color: PASS_COLOR };
	if (policy === 'quarantine') return { label: 'quarantine', color: WARN_COLOR };
	if (policy === 'none')       return { label: 'none (monitor only)', color: FAIL_COLOR };
	return { label: 'Not configured', color: FAIL_COLOR };
}

function addPageIfNeeded(doc: jsPDF, y: number, needed = 20): number {
	if (y + needed > 275) {
		doc.addPage();
		return 20;
	}
	return y;
}

export interface WeekBucket {
	label: string;
	total: number;
	passed: number;
}

/** Daily stats to 7-day buckets starting at the first day; a new bucket opens once a day is past the bucket's end. */
export function weeklyBuckets(stats: DailyStat[]): WeekBucket[] {
	const weeks: Array<WeekBucket & { end: string }> = [];
	const sorted = [...stats].sort((a, b) => a.day.localeCompare(b.day));
	let bucket: (WeekBucket & { end: string }) | null = null;
	for (const s of sorted) {
		if (!bucket || s.day > bucket.end) {
			const weekEnd = new Date(`${s.day}T00:00:00Z`);
			weekEnd.setUTCDate(weekEnd.getUTCDate() + 6);
			const end = weekEnd.toISOString().slice(0, 10);
			bucket = { label: `${s.day} -> ${end}`, end, total: 0, passed: 0 };
			weeks.push(bucket);
		}
		bucket.total += s.total;
		bucket.passed += s.passed;
	}
	return weeks.map(({ label, total, passed }) => ({ label, total, passed }));
}

// ── Main builder ──────────────────────────────────────────────

export interface PdfReportData {
	summaries: DomainCheckSummary[];
	// 90 days of daily stats per domain, for the weekly trend
	trends?: Record<number, DailyStat[]>;
}

export function buildPdfReport(data: PdfReportData): jsPDF {
	const { summaries } = data;
	const doc = new jsPDF({ unit: 'mm', format: 'a4' });
	const now = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

	// ── Cover ──────────────────────────────────────────────────
	doc.setFillColor(...DARK_COLOR);
	doc.rect(0, 0, PAGE_W, 50, 'F');

	doc.setTextColor(255, 255, 255);
	doc.setFontSize(20);
	doc.setFont('helvetica', 'bold');
	doc.text('Email Authentication Health Report', MARGIN, 22);

	doc.setFontSize(10);
	doc.setFont('helvetica', 'normal');
	doc.text(`Generated ${now} - Last 30 days of data`, MARGIN, 32);
	doc.text(`${summaries.length} domain${summaries.length !== 1 ? 's' : ''} monitored`, MARGIN, 40);

	// ── Overall summary banner ─────────────────────────────────
	let y = 60;
	const totalMsgs = summaries.reduce((s, d) => s + d.total_messages, 0);
	const passMsgs  = summaries.reduce((s, d) => s + d.pass_messages,  0);
	const overallRate = totalMsgs > 0 ? Math.round((passMsgs / totalMsgs) * 100) : null;

	doc.setTextColor(...DARK_COLOR);
	doc.setFontSize(13);
	doc.setFont('helvetica', 'bold');
	doc.text('Overall DMARC Pass Rate', MARGIN, y);

	doc.setFontSize(28);
	const rateStr = overallRate !== null ? `${overallRate}%` : 'No data';
	const rateColor = overallRate === null ? MUTED_COLOR : overallRate >= 95 ? PASS_COLOR : overallRate >= 70 ? WARN_COLOR : FAIL_COLOR;
	doc.setTextColor(...rateColor);
	doc.text(rateStr, MARGIN, y + 12);

	doc.setFontSize(10);
	doc.setTextColor(...MUTED_COLOR);
	doc.text(`${passMsgs.toLocaleString()} of ${totalMsgs.toLocaleString()} messages passed`, MARGIN, y + 20);

	y += 34;

	// ── Per-domain table ──────────────────────────────────────
	doc.setTextColor(...DARK_COLOR);
	doc.setFontSize(13);
	doc.setFont('helvetica', 'bold');
	doc.text('Domain Status', MARGIN, y);
	y += 6;

	// Table header
	const cols = [52, 28, 28, 28, 28, 28];
	const headers = ['Domain', 'DMARC Policy', 'DMARC Rate', 'SPF Rate', 'DKIM Rate', 'MTA-STS'];
	let x = MARGIN;
	doc.setFillColor(240, 240, 248);
	doc.rect(MARGIN, y, COL_W, 7, 'F');
	doc.setFontSize(8);
	doc.setFont('helvetica', 'bold');
	doc.setTextColor(...DARK_COLOR);
	for (let i = 0; i < headers.length; i++) {
		doc.text(headers[i] ?? '', x + 1, y + 5);
		x += cols[i] ?? 0;
	}
	y += 7;

	// Table rows
	doc.setFont('helvetica', 'normal');
	for (const d of summaries) {
		y = addPageIfNeeded(doc, y, 10);

		const policy = dmarcPolicyLabel(d.dmarc_policy);
		const dmarcStatus = statusLabel(d.pass_messages, d.total_messages);
		const spfStatus   = statusLabel(d.spf_pass,       d.spf_total);
		const dkimStatus  = statusLabel(d.dkim_pass,       d.dkim_total);
		const mtaLabel    = d.mta_sts_enabled ? (d.mta_sts_mode ?? 'on') : 'Off';
		const mtaColor: [number, number, number] = d.mta_sts_enabled ? PASS_COLOR : MUTED_COLOR;

		// Alternate row background
		const rowIdx = summaries.indexOf(d);
		if (rowIdx % 2 === 0) {
			doc.setFillColor(250, 250, 255);
			doc.rect(MARGIN, y, COL_W, 8, 'F');
		}

		x = MARGIN;
		doc.setFontSize(8);
		doc.setTextColor(...DARK_COLOR);
		// Domain name (truncate if long)
		const domainText = d.domain.length > 22 ? d.domain.slice(0, 20) + '...' : d.domain;
		doc.text(domainText, x + 1, y + 5.5);
		x += cols[0] ?? 0;

		doc.setTextColor(...policy.color);
		doc.text(policy.label, x + 1, y + 5.5);
		x += cols[1] ?? 0;

		doc.setTextColor(...dmarcStatus.color);
		doc.text(`${passRate(d.pass_messages, d.total_messages)} (${dmarcStatus.label})`, x + 1, y + 5.5);
		x += cols[2] ?? 0;

		doc.setTextColor(...spfStatus.color);
		doc.text(`${passRate(d.spf_pass, d.spf_total)} (${spfStatus.label})`, x + 1, y + 5.5);
		x += cols[3] ?? 0;

		doc.setTextColor(...dkimStatus.color);
		doc.text(`${passRate(d.dkim_pass, d.dkim_total)} (${dkimStatus.label})`, x + 1, y + 5.5);
		x += cols[4] ?? 0;

		doc.setTextColor(...mtaColor);
		doc.text(mtaLabel, x + 1, y + 5.5);

		y += 8;
	}

	// ── Recommendations section ────────────────────────────────
	const recs = getAllRecommendations(summaries);
	if (recs.length > 0) {
		y = addPageIfNeeded(doc, y, 20);
		y += 8;

		doc.setTextColor(...DARK_COLOR);
		doc.setFontSize(13);
		doc.setFont('helvetica', 'bold');
		doc.text('Recommendations', MARGIN, y);
		y += 6;

		const SEVERITY_COLOR: Record<Recommendation['severity'], [number, number, number]> = {
			critical: FAIL_COLOR,
			warning:  WARN_COLOR,
			info:     [59, 130, 246], // blue-500
		};

		for (const rec of recs) {
			y = addPageIfNeeded(doc, y, 14);

			const color = SEVERITY_COLOR[rec.severity];
			// Severity badge
			doc.setFillColor(...color);
			doc.roundedRect(MARGIN, y, 18, 5, 1, 1, 'F');
			doc.setTextColor(255, 255, 255);
			doc.setFontSize(7);
			doc.setFont('helvetica', 'bold');
			doc.text(rec.severity.toUpperCase(), MARGIN + 1.5, y + 3.5);

			// Domain label
			doc.setTextColor(...MUTED_COLOR);
			doc.setFontSize(7);
			doc.setFont('helvetica', 'normal');
			doc.text(rec.domain, MARGIN + 20, y + 3.5);

			// Message (wrap to fit page width)
			doc.setTextColor(...DARK_COLOR);
			doc.setFontSize(8.5);
			const lines = doc.splitTextToSize(rec.message, COL_W - 4) as string[];
			doc.text(lines, MARGIN + 2, y + 9);
			y += 8 + lines.length * 4.5;
		}
	}

	// ── Trend section ──────────────────────────────────────────
	const trends = data.trends;
	if (trends && Object.keys(trends).length > 0) {
		y = addPageIfNeeded(doc, y, 20);
		y += 8;

		doc.setTextColor(...DARK_COLOR);
		doc.setFontSize(13);
		doc.setFont('helvetica', 'bold');
		doc.text('Weekly DMARC Pass Rate Trend', MARGIN, y);
		y += 6;

		for (const d of summaries) {
			const stats = trends[d.domain_id];
			if (!stats || stats.length === 0) continue;

			const weeks = weeklyBuckets(stats);

			if (weeks.length === 0) continue;

			y = addPageIfNeeded(doc, y, 8 + weeks.length * 6);

			// Domain header
			doc.setFontSize(9);
			doc.setFont('helvetica', 'bold');
			doc.setTextColor(...DARK_COLOR);
			doc.text(d.domain, MARGIN, y);
			y += 5;

			// Week rows
			for (const w of weeks) {
				const rate = w.total > 0 ? Math.round((w.passed / w.total) * 100) : null;
				const color: [number, number, number] = rate === null ? MUTED_COLOR : rate >= 95 ? PASS_COLOR : rate >= 70 ? WARN_COLOR : FAIL_COLOR;

				doc.setFontSize(7.5);
				doc.setFont('helvetica', 'normal');
				doc.setTextColor(...MUTED_COLOR);
				doc.text(w.label, MARGIN + 2, y);
				doc.setTextColor(...color);
				doc.text(rate !== null ? `${rate}% (${w.passed.toLocaleString()}/${w.total.toLocaleString()})` : 'No data', MARGIN + 80, y);
				y += 5;
			}
			y += 3;
		}
	}

	return doc;
}

export function downloadPdfReport(data: PdfReportData, filename = 'email-auth-report.pdf'): void {
	const doc = buildPdfReport(data);
	doc.save(filename);
}
