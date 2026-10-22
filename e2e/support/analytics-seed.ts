// SQL for the analytics e2e and the screenshots: 30 days of reports for one domain, dated relative to now.
// A clean Google Workspace, Mailchimp that passes SPF/DKIM only for its own domain (so DMARC fails), an unknown host
// that fails, and a SendGrid that appeared two days ago. The API has no way to ingest a report, so this goes
// straight into the local D1.
const DAY = 86400;

interface Entry { ip: string; count: number; pass: boolean; spf: [string, string]; dkim: [string, string]; ptr?: string; base?: string; org?: string; recent?: boolean }

export function analyticsSeedSql(domainId: number, domain: string, now = Math.floor(Date.now() / 1000)): string {
	const entries: Entry[] = [
		{ ip: '209.85.220.41', count: 80, pass: true, spf: ['pass', domain], dkim: ['pass', domain], ptr: 'mail-sor-f41.google.com', base: 'google.com', org: 'Google LLC' },
		{ ip: '198.2.180.1', count: 12, pass: false, spf: ['pass', 'mcsv.net'], dkim: ['pass', 'mcsv.net'], ptr: 'mail180.mcsv.net', base: 'mcsv.net', org: 'The Rocket Science Group' },
		{ ip: '203.0.113.9', count: 3, pass: false, spf: ['fail', domain], dkim: ['none', domain], org: 'Shady Hosting' },
		{ ip: '167.89.1.1', count: 5, pass: true, spf: ['pass', `em.${domain}`], dkim: ['pass', domain], ptr: 'o1.em.sendgrid.net', base: 'sendgrid.net', org: 'SendGrid', recent: true },
	];
	const q = (v: string | null) => (v === null ? 'NULL' : `'${v.replace(/'/g, "''")}'`);
	const out: string[] = [`UPDATE domains SET spf_record = 'v=spf1 include:_spf.google.com ~all', dmarc_policy = 'none' WHERE id = ${domainId} AND account_id = 'acct_default';`];
	for (let ago = 1; ago <= 30; ago++) {
		const today = entries.filter((e) => !e.recent || ago <= 2);
		const total = today.reduce((n, e) => n + e.count, 0);
		const pass = today.filter((e) => e.pass).reduce((n, e) => n + e.count, 0);
		const begin = Math.floor((now - ago * DAY) / DAY) * DAY;
		const rid = `e2e-${domainId}-${ago}`;
		out.push(
			`INSERT OR IGNORE INTO aggregate_reports (domain_id, org_name, report_id, date_begin, date_end, total_count, pass_count, fail_count, account_id) VALUES (${domainId}, 'google.com', '${rid}', ${begin}, ${begin + DAY - 1}, ${total}, ${pass}, ${total - pass}, 'acct_default');`,
		);
		for (const e of today) {
			out.push(
				`INSERT INTO report_records (report_id, source_ip, count, disposition, spf_result, spf_domain, dkim_result, dkim_domain, header_from, reverse_dns, base_domain, org, account_id) ` +
					`SELECT id, '${e.ip}', ${e.count}, '${e.pass ? 'none' : 'quarantine'}', ${q(e.spf[0])}, ${q(e.spf[1])}, ${q(e.dkim[0])}, ${q(e.dkim[1])}, ${q(domain)}, ${q(e.ptr ?? null)}, ${q(e.base ?? null)}, ${q(e.org ?? null)}, 'acct_default' ` +
					`FROM aggregate_reports WHERE domain_id = ${domainId} AND report_id = '${rid}';`,
			);
		}
	}
	return out.join('\n');
}
