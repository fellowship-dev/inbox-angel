// What the product may write to DNS through Cloudflare. Pure: no I/O, no env. The CfClient runs it for every
// non-GET request to /zones/<id>/dns_records[/<id>], before anything leaves the Worker, so a bug (or a hostile
// input) elsewhere can never turn a DNS:Edit token into "write any record anywhere".
//
// Managed records, for a monitored domain D inside the zone:
//   TXT    _dmarc.D  _mta-sts.D  _smtp._tls.D
//   TXT    <D>._report._dmarc.<reports domain>   (report authorization; content v=DMARC1…)
//   TXT    v=spf1… at a monitored domain or the reports domain (`allowedApexes`); when the caller gives none, at any
//          name without a `_`-prefixed label and not under mta-sts.
//   CNAME  mta-sts.D -> exactly one of `cnameTargets` (the MTA-STS policy host the caller computed); no other CNAME
//   (DKIM and BIMI records are never written; hosted pointers are customer-side and go through assertHostedDnsWrite.)
//   MX     the Cloudflare Email Routing hosts of the reports domain (self-host only)
// Everything else (A, AAAA, NS, SRV, MX in saas, a CNAME at the apex, a TXT with some other name or content) is refused.

import { CfRecordNotAllowedError } from '../tenancy/cf-client';
import type { Mode } from '../tenancy/mode';

export interface DnsWrite {
  method: string;
  /** The zone the write goes to, when known. Names must then lie inside it. */
  zoneName?: string;
  type?: string;
  name?: string;
  content?: string;
  mode: Mode;
  /** PATCH only: the keys of the body. */
  patchKeys?: string[];
  /** Hostnames a `mta-sts.D` CNAME may point at. Without it no CNAME is allowed. */
  cnameTargets?: string[];
  /** Names (monitored domains, the reports domain) an SPF TXT may sit at. Without it, the name heuristic applies. */
  allowedApexes?: string[];
}

const PATCH_KEYS: ReadonlySet<string> = Object.freeze(new Set(['content', 'ttl', 'comment', 'proxied', 'priority', 'name', 'type']));
const LABEL = '[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?';
const HOST_RE = new RegExp(`^${LABEL}(?:\\.${LABEL})*$`);
const DOMAIN = `${LABEL}(?:\\.${LABEL})*`;
const REPORT_AUTH = new RegExp(`^${DOMAIN}\\._report\\._dmarc\\.${DOMAIN}$`);
const MX_TARGET = /^[a-z0-9-]+\.mx\.cloudflare\.net$/;

function refuse(w: DnsWrite, reason: string): never {
  throw new CfRecordNotAllowedError(reason, { method: w.method, type: w.type, name: w.name });
}

const bare = (s: string) => s.trim().replace(/^"|"$/g, '').trim();
const norm = (s: string) => s.trim().toLowerCase().replace(/\.$/, '');

/** Lower-cased FQDN of `name` inside `zone`, or throws. Relative names are accepted only for self-host MX (email routing). */
function resolveName(w: DnsWrite, name: string, type: string): string {
  const n = norm(name);
  if (!HOST_RE.test(n) || n.length > 253) refuse(w, `record name ${JSON.stringify(name)} is not a plain hostname`);
  const zone = w.zoneName ? norm(w.zoneName) : undefined;
  if (!zone) return n;
  if (n === zone || n.endsWith(`.${zone}`)) return n;
  if (type === 'MX' && w.mode === 'selfhost' && !n.includes('.')) return `${n}.${zone}`;
  return refuse(w, `record name ${n} is outside zone ${zone}`);
}

/** Throws CfRecordNotAllowedError unless this DNS write is one the product makes. DELETE is checked by id elsewhere. */
export function assertDnsWriteAllowed(w: DnsWrite): void {
  const method = w.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD') return;
  if (method === 'DELETE') return;
  if (method === 'PATCH') {
    for (const k of w.patchKeys ?? []) if (!PATCH_KEYS.has(k)) refuse(w, `a DNS record update may not change "${k}"`);
    if (w.name === undefined && w.type === undefined) return; // content/ttl/... of a record we hold the id of
    if (w.name === undefined || w.type === undefined) refuse(w, 'a DNS record update that renames or retypes must give both name and type');
  } else if (method !== 'POST' && method !== 'PUT') {
    refuse(w, `method ${method} is not allowed on DNS records`);
  }

  if (typeof w.type !== 'string' || typeof w.name !== 'string') refuse(w, 'DNS record needs a type and a name');
  if (w.content !== undefined && typeof w.content !== 'string') refuse(w, 'DNS record content must be a string');
  const type = w.type.toUpperCase();
  const name = resolveName(w, w.name, type);
  const content = w.content === undefined ? undefined : bare(w.content);
  if (content === undefined && method !== 'PATCH') refuse(w, 'DNS record needs content');

  switch (type) {
    case 'TXT': {
      if (content === undefined) refuse(w, 'a TXT record update must carry its content');
      if (/^v=spf1(\s|$)/i.test(content)) {
        if (w.allowedApexes) {
          if (w.allowedApexes.some(a => norm(a) === name)) return;
          return refuse(w, `SPF at ${name} is not at a monitored domain or the reports domain`);
        }
        if (name.split('.').some(l => l.startsWith('_')) || name.startsWith('mta-sts.')) refuse(w, `SPF at ${name} is not allowed`);
        return;
      }
      if (name.startsWith('_dmarc.') || name.startsWith('_mta-sts.') || name.startsWith('_smtp._tls.')) return;
      if (REPORT_AUTH.test(name) && /^v=DMARC1/i.test(content)) return;
      return refuse(w, `TXT ${name} is not a record Inbox Angel manages`);
    }
    case 'CNAME': {
      if (!name.startsWith('mta-sts.')) return refuse(w, `CNAME ${name} is not a record Inbox Angel manages`);
      if (content === undefined || !(w.cnameTargets ?? []).some(t => norm(t) === norm(content))) refuse(w, `CNAME ${name} may only point at the MTA-STS policy host`);
      return;
    }
    case 'MX': {
      if (w.mode !== 'selfhost') refuse(w, 'MX records are written only by the self-host email-routing setup');
      if (name === norm(w.zoneName ?? '')) refuse(w, 'MX at the zone apex is not managed');
      if (content === undefined || !MX_TARGET.test(norm(content))) refuse(w, 'MX records may only point at Cloudflare Email Routing');
      return;
    }
    default:
      return refuse(w, `${type} records are not managed by Inbox Angel`);
  }
}

/**
 * The hosted-records writer's policy (HOSTED_RECORDS_TOKEN, the operator's records zone): TXT, AAAA or CNAME,
 * strictly below `<label>.<zone>`, in that zone and no other.
 */
export function assertHostedDnsWrite(w: Pick<DnsWrite, 'method' | 'zoneName' | 'type' | 'name' | 'patchKeys'>, cfg: { recordsZone?: string; recordsLabel: string }): void {
  const method = w.method.toUpperCase();
  const full: DnsWrite = { ...w, mode: 'saas' };
  if (!cfg.recordsZone) refuse(full, 'hosted-records zone is not configured');
  const zone = norm(cfg.recordsZone);
  if (!w.zoneName || norm(w.zoneName) !== zone) refuse(full, `hosted records may only be written in zone ${zone}`);
  if (method === 'DELETE') return;
  if (method === 'PATCH') {
    for (const k of w.patchKeys ?? []) if (!PATCH_KEYS.has(k)) refuse(full, `a DNS record update may not change "${k}"`);
    if (w.name === undefined && w.type === undefined) return;
  } else if (method !== 'POST' && method !== 'PUT') {
    refuse(full, `method ${method} is not allowed on DNS records`);
  }
  if (typeof w.type !== 'string' || typeof w.name !== 'string') refuse(full, 'DNS record needs a type and a name');
  const type = w.type.toUpperCase();
  if (!['TXT', 'AAAA', 'CNAME'].includes(type)) refuse(full, `${type} records are not written in the hosted zone`);
  const n = norm(w.name);
  const apex = `${cfg.recordsLabel.toLowerCase()}.${zone}`;
  if (!HOST_RE.test(n) || !n.endsWith(`.${apex}`)) refuse(full, `hosted records may only be written under *.${apex}`);
}
