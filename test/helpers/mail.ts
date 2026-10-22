import { vi } from 'vitest';
import { gzipSync, zipSync, strToU8 } from 'fflate';

export const dmarcXml = (domain: string, reportId = 'rep-1', org = 'google.com') => `<?xml version="1.0"?>
<feedback>
  <report_metadata><org_name>${org}</org_name><email>noreply@${org}</email><report_id>${reportId}</report_id>
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

export function fakeMessage(to: string, rawMime: string, o: { from?: string; headers?: Record<string, string>; rawSize?: number } = {}): FakeMessage {
  const bytes = new TextEncoder().encode(rawMime);
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
