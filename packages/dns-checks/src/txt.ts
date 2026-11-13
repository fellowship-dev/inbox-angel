// Dependency-free TXT helpers (the dashboard imports this directly).

/**
 * TXT content as DNS presents it. Cloudflare's API returns the quoted form (`"v=DKIM1; k=rsa; p="`), and a long
 * or split record as several quoted strings (`"v=DKIM1; k=rsa; " "p="`). The strings are concatenated with nothing
 * between them (RFC 4408 §3.1.3 / RFC 6376 §3.6.2.2). Unquoted content is returned trimmed.
 */
export function unquoteTxt(content: string): string {
  const t = content.trim();
  if (!t.includes('"')) return t;
  const parts = [...t.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => (m[1] ?? '').replace(/\\(.)/g, '$1'));
  return parts.length > 0 ? parts.join('') : t.replace(/^"|"$/g, '');
}
