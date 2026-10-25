// Ported verbatim from unzip-inboxangel outreach-tools/catalog/bimi-no-certificate.json.
import type { CatalogFile } from './types';

export const bimiNoCertificate: CatalogFile = {
  "finding": "bimi-no-certificate",
  "entries": [
    {
      "provider": "*",
      "dns_host": "*",
      "exact": false,
      "title": "Add the BIMI certificate (VMC or CMC)",
      "why": "Your BIMI record has a logo but no certificate. Gmail needs a Verified Mark Certificate (VMC, recommended, and the only one that gets the checkmark) or a Common Mark Certificate (CMC). Apple's BIMI page names a VMC as an example of the evidence it accepts and does not say whether a CMC is accepted, so plan on a VMC if Apple Mail matters.",
      "records": [
        {
          "name": "default._bimi.{domain}",
          "type": "TXT",
          "value": "v=BIMI1; l=<your existing logo URL>; a=<https URL of your certificate .pem>",
          "note": "Keep your existing l= value; add the a= URL once the certificate is issued."
        }
      ],
      "steps": [
        "Choose a certificate authority that issues mark certificates and start the validation. A VMC needs a registered trademark of the logo. A CMC does not, but the exact logo must have been in use on a domain you control for at least 12 months before validation (DigiCert checks this, for example with archive.org captures).",
        "Host the issued PEM file over HTTPS.",
        "@dns_host"
      ],
      "caveat": "The certificate is a separate purchase from the CA and takes days to weeks to validate. We check that the file is reachable and is a PEM certificate; we do not validate the certificate chain.",
      "sources": [
        "https://bimigroup.org/implementation-guide/",
        "https://knowledge.workspace.google.com/admin/security/set-up-bimi",
        "https://developer.apple.com/support/bimi",
        "https://docs.digicert.com/en/certcentral/manage-certificates/verified-mark-certificates--vmc-/common-mark-certificate--cmc-.html"
      ]
    }
  ]
};
