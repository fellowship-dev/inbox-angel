import { vi } from 'vitest';
import { gzipSync, zipSync, strToU8 } from 'fflate';

export const dmarcXml = (domain: string, reportId = 'rep-1', org = 'google.com') => `<?xml version="1.0"?>
<feedback>
  <report_metadata><org_name>${org}</org_name><email>noreply-dmarc-support@${org}</email><report_id>${reportId}</report_id>
    <date_range><begin>1529366400</begin><end>1529452799</end></date_range></report_metadata>
  <policy_published><domain>${domain}</domain><adkim>r</adkim><aspf>r</aspf><p>none</p><pct>100</pct></policy_published>
  <record>
    <row><source_ip>199.230.200.36</source_ip><count>3</count>
      <policy_evaluated><disposition>none</disposition><dkim>fail</dkim><spf>pass</spf></policy_evaluated></row>
    <identifiers><header_from>${domain}</header_from></identifiers>
    <auth_results><spf><domain>${domain}</domain><result>pass</result></spf></auth_results>
  </record>
</feedback>`;

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64').replace(/(.{76})/g, '$1\r\n');

/** A multipart MIME message carrying `bytes` as an attachment. */
export function mimeWithAttachment(bytes: Uint8Array, filename: string, contentType: string): string {
  return [
    'From: noreply-dmarc-support@google.com', 'To: x', 'Subject: Report', 'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="BOUND"', '',
    '--BOUND', 'Content-Type: text/plain', '', 'see attached', '',
    '--BOUND', `Content-Type: ${contentType}; name="${filename}"`, `Content-Disposition: attachment; filename="${filename}"`,
    'Content-Transfer-Encoding: base64', '', b64(bytes), '--BOUND--', '',
  ].join('\r\n');
}

export const gzipReportMime = (xml: string) => mimeWithAttachment(gzipSync(strToU8(xml)), 'report.xml.gz', 'application/gzip');
export const zipReportMime = (xml: string) => mimeWithAttachment(zipSync({ 'report.xml': strToU8(xml) }), 'report.zip', 'application/zip');

export const tlsRptJson = (policyDomain: string, extra: object = {}) => JSON.stringify({
  'organization-name': 'Google Inc.',
  'date-range': { 'start-datetime': '2024-01-01T00:00:00Z', 'end-datetime': '2024-01-01T23:59:59Z' },
  'report-id': 'tls-1',
  policies: [{
    policy: { 'policy-type': 'sts', 'policy-domain': policyDomain },
    summary: { 'total-successful-session-count': 10, 'total-failure-session-count': 2 },
  }],
  ...extra,
});

export const tlsRptMime = (json: string, gz = false) => gz
  ? mimeWithAttachment(gzipSync(strToU8(json)), 'report.json.gz', 'application/tlsrpt+gzip')
  : ['From: noreply@google.com', 'To: x', 'Subject: TLS-RPT', 'Content-Type: application/tlsrpt+json', '', json].join('\r\n');

export interface FakeMessage extends ForwardableEmailMessage { setReject: ReturnType<typeof vi.fn>; reply: ReturnType<typeof vi.fn> }

/**
 * An inbound message. `headers` are also written into the raw MIME as header lines (topmost first, as a receiver prepends
 * its own) unless the MIME already carries that header, and set on `message.headers`.
 */
/**
 * How many DKIM-Signature fields a message with these results headers would carry: one per dkim result other than "none" (a receiver
 * writes one result per signature it verified). The intake does not believe a header with more dkim results than signatures.
 */
export function signaturesFor(results: string[]): number {
  return Math.max(0, ...results.map((r) => (r.match(/(?:^|;)\s*dkim\s*=\s*(?!none\b)[a-z]+/gi) ?? []).length));
}

/**
 * A fake inbound message. Results headers (given in `headers` or `rawHeaderLines`, or already in the raw text) get as many DKIM-Signature fields as their dkim results,
 * so a genuine-looking header stays genuine; `dkimSignatures` overrides that count (a forged header that adds a result, for example).
 */
export function fakeMessage(to: string, rawMime: string, o: { from?: string; headers?: Record<string, string>; rawSize?: number; rawHeaderLines?: string[]; dkimSignatures?: number } = {}): FakeMessage {
  const head = rawMime.split(/\r?\n\r?\n/)[0];
  // Every results header the message will carry: given as options, or already in the raw text (tests that inject one into a fixture).
  const inHead = head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/).filter((l) => /^(arc-)?authentication-results:/i.test(l)).map((l) => l.slice(l.indexOf(':') + 1));
  const given = [...Object.entries(o.headers ?? {}).filter(([k]) => /^(arc-)?authentication-results$/i.test(k)).map(([, v]) => v), ...(o.rawHeaderLines ?? []).filter((l) => /^(arc-)?authentication-results:/i.test(l)).map((l) => l.slice(l.indexOf(':') + 1)), ...inHead];
  const already = (head.match(/^dkim-signature:/gim) ?? []).length;
  const wanted = o.dkimSignatures ?? (given.length ? signaturesFor(given) : 0);
  const sigs = Array.from({ length: Math.max(0, wanted - already) }, (_, n) => `DKIM-Signature: v=1; a=rsa-sha256; d=signer${n}.test; s=s; bh=x; b=x`);
  const lines = [...(o.rawHeaderLines ?? []), ...Object.entries(o.headers ?? {}).filter(([k]) => !new RegExp(`^${k}:`, 'im').test(head)).map(([k, v]) => `${k}: ${v}`), ...sigs];
  const bytes = new TextEncoder().encode(lines.length ? lines.join('\r\n') + '\r\n' + rawMime : rawMime);
  return {
    from: o.from ?? 'noreply-dmarc-support@google.com',
    to,
    headers: new Headers(o.headers ?? {}),
    raw: new Response(bytes).body!,
    rawSize: o.rawSize ?? bytes.length,
    setReject: vi.fn(),
    reply: vi.fn().mockResolvedValue(undefined),
    forward: vi.fn(),
  } as unknown as FakeMessage;
}
