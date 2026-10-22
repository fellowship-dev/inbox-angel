/** Pure SPF record helpers for the setup wizard. */

export type SpfQualifier = '~all' | '-all';

/** Every `include:` target in the record, known provider or not, in order. */
export function extractIncludes(record: string): string[] {
	return (record.match(/include:([^\s]+)/g) ?? []).map((m) => m.replace('include:', ''));
}

/** Mechanisms other than version, includes and the final `all` (mx, a, ip4:, ip6:, redirect=…). */
export function extractOtherMechanisms(record: string): string[] {
	return record.split(/\s+/).filter((part) => part !== '' && part !== 'v=spf1' && !part.startsWith('include:') && !/^[~+?-]?all$/.test(part));
}

export function buildSpfRecord(includes: string[], qualifier: SpfQualifier = '~all', otherMechanisms: string[] = []): string {
	return ['v=spf1', ...includes.map((i) => `include:${i}`), ...otherMechanisms, qualifier].join(' ');
}

/** `-all` if the existing record has it, otherwise the softfail default. */
export function existingQualifier(record: string | null): SpfQualifier {
	return record?.includes('-all') ? '-all' : '~all';
}

/**
 * Normalises what someone typed into the "custom provider" box: drops a pasted `include:` prefix and
 * returns null when it is not a plausible domain name.
 */
export function normalizeCustomInclude(input: string): string | null {
	const v = input.trim().toLowerCase().replace(/^include:/, '');
	return /^[a-z0-9_]([a-z0-9_.-]*[a-z0-9])?\.[a-z0-9-]{2,}$/.test(v) ? v : null;
}

/** Colour band for the 10-lookup limit (RFC 7208 section 4.6.4): over 9 is at the limit, 8-9 is close. */
export function lookupLevel(count: number): 'ok' | 'near' | 'over' {
	if (count > 9) return 'over';
	if (count >= 8) return 'near';
	return 'ok';
}
