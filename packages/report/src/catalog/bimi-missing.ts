// Ported verbatim from unzip-inboxangel outreach-tools/catalog/bimi-missing.json.
import type { CatalogFile } from './types';

export const bimiMissing: CatalogFile = {
  "finding": "bimi-missing",
  "entries": [
    {
      "provider": "*",
      "dns_host": "*",
      "exact": false,
      "title": "Publish a BIMI record",
      "why": "BIMI is the DNS record that tells supporting mail apps such as Gmail and Apple Mail to show your verified logo next to your emails. {domain} has none. It also needs enforced DMARC and a certificate, so the record is the last step, not the first.",
      "records": [
        {
          "name": "default._bimi.{domain}",
          "type": "TXT",
          "value": "v=BIMI1; l=<https URL of your SVG logo>; a=<https URL of your certificate .pem>",
          "note": "Replace both URLs. Publish it only once DMARC is enforced and the certificate is issued."
        }
      ],
      "steps": [
        "Prepare the logo as an SVG Tiny-PS file and host it over HTTPS.",
        "Order a Verified Mark Certificate (VMC; Gmail also accepts a Common Mark Certificate, CMC) and host the PEM file over HTTPS.",
        "@dns_host"
      ],
      "caveat": "A BIMI record alone does nothing without enforced DMARC and a certificate. Whether the logo appears also depends on each mailbox provider's own rules.",
      "sources": [
        "https://bimigroup.org/implementation-guide/",
        "https://datatracker.ietf.org/doc/draft-brand-indicators-for-message-identification/",
        "https://knowledge.workspace.google.com/admin/security/set-up-bimi"
      ]
    }
  ]
};
