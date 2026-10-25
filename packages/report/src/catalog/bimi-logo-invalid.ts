// Ported verbatim from unzip-inboxangel outreach-tools/catalog/bimi-logo-invalid.json.
import type { CatalogFile } from './types';

export const bimiLogoInvalid: CatalogFile = {
  "finding": "bimi-logo-invalid",
  "entries": [
    {
      "provider": "*",
      "dns_host": "*",
      "exact": false,
      "title": "Fix the BIMI logo file",
      "why": "Your BIMI record points to a logo that mail providers cannot use: the URL is missing, does not load, or is not an SVG.",
      "records": [
        {
          "name": "default._bimi.{domain}",
          "type": "TXT",
          "value": "v=BIMI1; l=<https URL of your SVG Tiny-PS logo>; a=<https URL of your certificate .pem>",
          "note": "Keep your existing a= value; replace only the l= URL."
        }
      ],
      "steps": [
        "Export the logo as SVG Tiny-PS (square, solid background, no scripts or external links).",
        "Host it over HTTPS at a stable URL that returns the file directly.",
        "@dns_host"
      ],
      "caveat": "We check that the file exists and looks like an SVG; whether it meets the full Tiny-PS profile is confirmed when the certificate is issued.",
      "sources": [
        "https://bimigroup.org/implementation-guide/",
        "https://datatracker.ietf.org/doc/draft-brand-indicators-for-message-identification/",
        "https://knowledge.workspace.google.com/admin/security/set-up-bimi"
      ]
    }
  ]
};
