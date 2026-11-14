/**
 * A name made safe to show (the same rule as the server's src/auth/names.ts): control and invisible format characters
 * (bidi overrides, zero-width characters, line breaks) removed, whitespace collapsed, cut to 80 characters. Applied where
 * names typed by people render, so a name stored before the server cleaned names still reads as plain text.
 */
export function cleanName(raw: string | null | undefined, max = 80): string {
	if (typeof raw !== 'string') return '';
	const flat = raw.normalize('NFC').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim();
	return [...flat].slice(0, max).join('').trim();
}
