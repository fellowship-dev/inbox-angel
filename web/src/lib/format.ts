const dtf = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
const dttf = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/** Unix seconds → "Oct 22, 2026". */
export const formatDate = (unix: number): string => dtf.format(new Date(unix * 1000));
export const formatDateTime = (unix: number): string => dttf.format(new Date(unix * 1000));
export const formatPercent = (part: number, total: number): string => (total > 0 ? `${Math.round((part / total) * 100)}%` : 'n/a');
export const formatNumber = (n: number): string => n.toLocaleString();

/** "3 days ago" style, for last-used columns. */
export function timeAgo(unix: number, now = Date.now() / 1000): string {
	const s = Math.max(0, Math.round(now - unix));
	if (s < 60) return 'just now';
	const units: Array<[number, string]> = [[86400, 'day'], [3600, 'hour'], [60, 'minute']];
	for (const [size, name] of units) {
		if (s >= size) {
			const n = Math.floor(s / size);
			return `${n} ${name}${n === 1 ? '' : 's'} ago`;
		}
	}
	return 'just now';
}
