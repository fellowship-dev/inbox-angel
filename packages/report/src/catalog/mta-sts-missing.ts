// Ported verbatim from unzip-inboxangel outreach-tools/catalog/mta-sts-missing.json.
import type { CatalogFile } from './types';

export const mtaStsMissing: CatalogFile = {
  "finding": "mta-sts-missing",
  "entries": [
    {
      "provider": "*",
      "dns_host": "*",
      "exact": false,
      "title": "Add an MTA-STS policy (optional)",
      "why": "MTA-STS makes other mail servers use encrypted delivery when they send mail to {domain}. It does not affect whether your outgoing marketing or order emails are accepted.",
      "records": [
        {
          "name": "_mta-sts.{domain}",
          "type": "TXT",
          "value": "v=STSv1; id=<date stamp you choose>",
          "note": "Also needs a policy file at https://mta-sts.{domain}/.well-known/mta-sts.txt."
        }
      ],
      "steps": [
        "Publish the policy file over HTTPS on the mta-sts subdomain, then the TXT record. Start with mode: testing.",
        "@dns_host"
      ],
      "caveat": null,
      "sources": [
        "https://www.rfc-editor.org/rfc/rfc8461"
      ]
    }
  ]
};
