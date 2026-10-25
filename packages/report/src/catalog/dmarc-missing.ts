// Ported from unzip-inboxangel outreach-tools/catalog/dmarc-missing.json.
// Deviation from the Z JSON (plan U2/KTD6): the record carries rua=mailto:dmarc@{domain}; note and optional_next follow.
import type { CatalogFile } from './types';

export const dmarcMissing: CatalogFile = {
  "finding": "dmarc-missing",
  "entries": [
    {
      "provider": "*",
      "dns_host": "*",
      "exact": true,
      "title": "Publish a DMARC record (p=none, blocks nothing)",
      "why": "{domain} has no DMARC record, so receivers have no instruction from you for mail claiming to be from {domain}. Gmail requires DMARC from senders above 5,000 messages a day and Outlook.com applies SPF, DKIM and DMARC rules to high-volume senders; below that volume it is not mandatory.",
      "records": [
        {
          "name": "_dmarc.{domain}",
          "type": "TXT",
          "value": "v=DMARC1; p=none; rua=mailto:dmarc@{domain}",
          "note": "p=none blocks nothing: it publishes the record and takes no action on mail. rua= sends the daily DMARC summaries to dmarc@{domain}: create that mailbox or alias first, or change the address to one you read."
        }
      ],
      "steps": [
        "@dns_host",
        "Wait a few minutes, then re-check {domain} on a public DNS lookup tool: `_dmarc.{domain}` should return the record.",
        "Once your sending services pass, you can move p=none to quarantine and then reject, one step at a time."
      ],
      "caveat": "This is an authentication fix. Whether Gmail or Outlook then puts a given email in the inbox also depends on your sending reputation, which no DNS record controls.",
      "sources": [
        "https://resend.com/docs/dashboard/domains/dmarc",
        "https://www.rfc-editor.org/rfc/rfc7489",
        "https://support.google.com/a/answer/81126",
        "https://substrate.office.com/ip-domain-management-snds/postmaster"
      ],
      "optional_next": "Optional next step: if dmarc@ is not a mailbox you read, change it to `rua=mailto:<a mailbox you read>` (or let Inbox Angel receive and read them for you)."
    }
  ]
};
