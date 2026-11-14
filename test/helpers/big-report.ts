/** A valid DMARC aggregate report (XML) for `domain` with `n` records from `n` distinct source IPs (up to 65,536). */
export function reportWithDistinctIps(domain: string, reportId: string, n: number): string {
  const rec = (i: number) => `<record><row><source_ip>203.${(i >> 8) & 255}.${i & 255}.${(i % 250) + 1}</source_ip><count>${1 + (i % 7)}</count>
<policy_evaluated><disposition>none</disposition><dkim>pass</dkim><spf>${i % 5 ? 'pass' : 'fail'}</spf></policy_evaluated></row>
<identifiers><header_from>${domain}</header_from></identifiers>
<auth_results><spf><domain>${domain}</domain><result>pass</result></spf></auth_results></record>`;
  const records: string[] = [];
  for (let i = 0; i < n; i++) records.push(rec(i));
  return `<?xml version="1.0"?><feedback><report_metadata><org_name>google.com</org_name><email>noreply-dmarc-support@google.com</email><report_id>${reportId}</report_id>
<date_range><begin>1529366400</begin><end>1529452799</end></date_range></report_metadata>
<policy_published><domain>${domain}</domain><adkim>r</adkim><aspf>r</aspf><p>none</p><pct>100</pct></policy_published>${records.join('')}</feedback>`;
}
