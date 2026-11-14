// Names people type (a display name, a workspace name) shown back to them and to their teammates.
//
// Rendered as text everywhere (React, escaped server pages), so markup is not the risk; these are: control and format
// characters (bidi overrides, zero-width joiners, line breaks) that make a name read as something else, and length.

/** Longest name kept, in characters. */
export const MAX_NAME = 80;

/** A name made safe to show: control and invisible format characters removed, whitespace collapsed, cut to `max` characters. */
export function cleanName(raw: unknown, max = MAX_NAME): string {
  if (typeof raw !== 'string') return '';
  const flat = raw.normalize('NFC').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim();
  return [...flat].slice(0, max).join('').trim();
}

/** The workspace name a new account starts with: from the name the person gave, else from their email's domain. */
export function defaultWorkspaceName(name: string, email: string): string {
  const clean = cleanName(name);
  if (clean) return cleanName(`${clean}'s workspace`);
  const domain = email.split('@')[1]?.toLowerCase() ?? '';
  return cleanName(domain ? `${domain} workspace` : 'My workspace');
}
