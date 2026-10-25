// Ported verbatim from unzip-inboxangel outreach-tools/catalog/bimi-blocked-by-dmarc-pct.json.
import type { CatalogFile } from './types';

export const bimiBlockedByDmarcPct: CatalogFile = {
  "finding": "bimi-blocked-by-dmarc-pct",
  "entries": [
    {
      "provider": "*",
      "dns_host": "*",
      "exact": false,
      "title": "Apply DMARC to all of your mail",
      "why": "Your DMARC policy enforces, but the pct tag applies it to only part of your mail. BIMI requires the policy to cover all of it.",
      "records": [
        {
          "name": "_dmarc.{domain}",
          "type": "TXT",
          "value": "{dmarc_enforce_value}",
          "note": "pct is set to 100."
        }
      ],
      "steps": [
        "@dns_host"
      ],
      "caveat": "Raising pct means every message that fails authentication is now quarantined or rejected, so check the DMARC reports first.",
      "sources": [
        "https://www.rfc-editor.org/rfc/rfc7489",
        "https://knowledge.workspace.google.com/admin/security/set-up-bimi"
      ]
    }
  ]
};
