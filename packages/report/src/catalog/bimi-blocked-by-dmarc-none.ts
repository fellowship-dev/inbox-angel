// Ported verbatim from unzip-inboxangel outreach-tools/catalog/bimi-blocked-by-dmarc-none.json.
import type { CatalogFile } from './types';

export const bimiBlockedByDmarcNone: CatalogFile = {
  "finding": "bimi-blocked-by-dmarc-none",
  "entries": [
    {
      "provider": "*",
      "dns_host": "*",
      "exact": false,
      "title": "Enforce DMARC so BIMI can switch on",
      "why": "Mailbox providers show your logo only on mail that DMARC protects. The BIMI Group requires enforcement on the organizational domain and its subdomains. {domain} is on a policy that does not enforce (p=none, no record, or sp=none for subdomains), so a BIMI logo would not be displayed even if everything else were in place.",
      "records": [
        {
          "name": "_dmarc.{domain}",
          "type": "TXT",
          "value": "{dmarc_enforce_value}",
          "note": "Do not publish this until the reports show every legitimate sender (newsletter tool, store, CRM, support desk) passing. Moving to quarantine too early sends real mail to spam."
        }
      ],
      "steps": [
        "Turn on DMARC reports and read them for a few weeks; list every service that sends as {domain}.",
        "Fix SPF and DKIM for each legitimate sender that fails.",
        "@dns_host",
        "Move to p=reject later if you want the strictest setting."
      ],
      "caveat": "Enforcement changes how receivers treat mail that fails authentication. It needs the sender audit first, which is why it is a project and not a copy-paste fix.",
      "sources": [
        "https://www.rfc-editor.org/rfc/rfc7489",
        "https://bimigroup.org/implementation-guide/",
        "https://knowledge.workspace.google.com/admin/security/set-up-bimi"
      ]
    }
  ]
};
