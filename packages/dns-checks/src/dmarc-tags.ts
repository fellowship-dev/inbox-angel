// The one DMARC tag parser (RFC 7489 §6.4), used by the server checks, the daily refresh and the dashboard.
// Pure on purpose: the dashboard imports this file alone, without the resolver or the public-suffix list.

/** One `tag=value` part of a record: name lower-cased, whitespace around the name, `=` and value ignored. */
export function readDmarcTag(part: string): { key: string; value: string } | null {
  const i = part.indexOf('=');
  if (i < 0) return null;
  const key = part.slice(0, i).trim().toLowerCase();
  return key ? { key, value: part.slice(i + 1).trim() } : null;
}

/** Every tag of a record, names lower-cased, first occurrence wins. Values are trimmed, nothing else is interpreted. */
export function parseDmarcTags(record: string | null | undefined): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const part of (record ?? '').split(';')) {
    const tag = readDmarcTag(part);
    if (tag && !(tag.key in tags)) tags[tag.key] = tag.value;
  }
  return tags;
}
