// Ported verbatim from unzip-inboxangel outreach-tools/catalog/_dns_hosts.json.
import type { DnsHostCatalog } from './types';

export const DNS_HOST_STEPS: DnsHostCatalog = {
  "note": "DIY steps per DNS host; {rec_*} come from the record being added.",
  "hosts": {
    "cloudflare": {
      "label": "Cloudflare",
      "steps": [
        "In Cloudflare, open {domain}, then DNS > Records > Add record.",
        "Type {rec_type}; Name `{rec_name}`; Content `{rec_value}`.",
        {
          "types": [
            "TXT"
          ],
          "text": "Paste the content without surrounding quotes: Cloudflare adds them to TXT records for you."
        },
        {
          "types": [
            "CNAME"
          ],
          "text": "Set Proxy status to DNS only (grey cloud)."
        },
        "Save."
      ],
      "sources": [
        "https://developers.cloudflare.com/dns/manage-dns-records/how-to/create-dns-records/",
        "https://developers.cloudflare.com/dns/proxy-status/",
        "https://developers.cloudflare.com/dns/manage-dns-records/reference/dns-record-types/"
      ]
    },
    "generic": {
      "label": "your DNS host",
      "steps": [
        "At your DNS host, add a {rec_type} record named `{rec_fqdn}` (some hosts want just `{rec_name}`) with the value `{rec_value}`.",
        {
          "types": [
            "CNAME"
          ],
          "text": "If your host has a proxy or CDN toggle for this record, turn it off."
        },
        "Your DNS host's help page says how it wants names and quotes."
      ],
      "sources": []
    }
  }
};
