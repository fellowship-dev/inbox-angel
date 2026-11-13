// Dependency-free TXT helpers (the dashboard imports this directly).

/**
 * Decode TXT presentation data into the logical record string.
 * Handles `"a" "b"` (multiple character-strings, joined, with nothing between them: RFC 4408 §3.1.3 / RFC 6376
 * §3.6.2.2), `\"` and `\DDD` escapes inside quotes, and unquoted data (returned trimmed, as Google's DoH and the
 * Cloudflare API return it). Quotes are only read when the data starts with one, so a quote inside a record
 * (`n="note"`) is left alone.
 */
export function decodeTxtData(data: string): string {
  const s = data.trim();
  if (!s.startsWith('"')) return s;
  let out = '';
  let i = 0;
  while (i < s.length) {
    if (s[i] === '"') {
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '\\' && i + 1 < s.length) {
          const next = s[i + 1] ?? '';
          // \DDD decimal escape
          if (/\d/.test(next) && /^\d{3}$/.test(s.slice(i + 1, i + 4))) {
            out += String.fromCharCode(parseInt(s.slice(i + 1, i + 4), 10));
            i += 4;
            continue;
          }
          out += next;
          i += 2;
          continue;
        }
        out += s[i++];
      }
      i++; // closing quote
    } else {
      i++; // whitespace between character-strings
    }
  }
  return out;
}
