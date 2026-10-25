// Ported verbatim from unzip-inboxangel outreach-tools/catalog/dkim-not-found-for-sender.json.
import type { CatalogFile } from './types';

export const dkimNotFoundForSender: CatalogFile = {
  "finding": "dkim-not-found-for-sender",
  "entries": [
    {
      "provider": "resend",
      "dns_host": "*",
      "exact": false,
      "title": "Publish the DKIM record from Resend",
      "why": "Your mail service signs messages with DKIM so Gmail and Outlook can see they were not altered or forged. We could not find a DKIM key for {provider} at {domain} under the common selector names (selectors cannot be listed, so this is a hint, not proof). If it is missing, marketing and order emails from {provider} are more likely to be filtered.",
      "records": [
        {
          "name": "resend._domainkey.{domain}",
          "type": "TXT",
          "value": "p=<public key shown in Resend>",
          "note": "The DKIM record is a TXT record with a public key (Resend docs); copy the value from your Records tab."
        }
      ],
      "needs_from_provider": [
        "the DKIM public key, shown in your Resend Records tab"
      ],
      "steps": [
        "In Resend, open Domains, pick {domain}, then the Records tab. Add exactly the records shown there (an MX and a TXT on `send`, and the DKIM record).",
        "@dns_host",
        "Back in Resend, click Verify DNS Records.",
        "Resend also notes that, for SPF on domains created after August 2026, it may generate CNAME records instead of the MX/TXT pair: always add exactly what your Records tab shows."
      ],
      "caveat": "This is an authentication fix. Whether Gmail or Outlook then puts a given email in the inbox also depends on your sending reputation, which no DNS record controls.",
      "sources": [
        "https://resend.com/docs/knowledge-base/cloudflare",
        "https://resend.com/docs/dashboard/domains/manage-domains"
      ]
    },
    {
      "provider": "google-workspace",
      "dns_host": "*",
      "exact": false,
      "title": "Turn on DKIM signing in Google Workspace",
      "why": "Your mail service signs messages with DKIM so Gmail and Outlook can see they were not altered or forged. We could not find a DKIM key for {provider} at {domain} under the common selector names (selectors cannot be listed, so this is a hint, not proof). If it is missing, marketing and order emails from {provider} are more likely to be filtered.",
      "records": [
        {
          "name": "google._domainkey.{domain}",
          "type": "TXT",
          "value": "<value generated in the Admin console>",
          "note": "The value is generated per domain; copy it from the console."
        }
      ],
      "needs_from_provider": [
        "the TXT value Google generates for the domain"
      ],
      "steps": [
        "In the Admin console go to Menu > Apps > Google Workspace > Gmail > Authenticate email, choose {domain} and generate the key (default selector `google`; pick 2048 bits if your DNS host supports it).",
        "@dns_host",
        "Return to the Admin console and click Start authentication once the record is live (it can take up to 48 hours)."
      ],
      "caveat": "This is an authentication fix. Whether Gmail or Outlook then puts a given email in the inbox also depends on your sending reputation, which no DNS record controls.",
      "sources": [
        "https://knowledge.workspace.google.com/admin/security/set-up-dkim"
      ]
    },
    {
      "provider": "amazon-ses",
      "dns_host": "*",
      "exact": false,
      "title": "Publish the Easy DKIM records from Amazon SES",
      "why": "Your mail service signs messages with DKIM so Gmail and Outlook can see they were not altered or forged. We could not find a DKIM key for {provider} at {domain} under the common selector names (selectors cannot be listed, so this is a hint, not proof). If it is missing, marketing and order emails from {provider} are more likely to be filtered.",
      "records": [
        {
          "name": "<token>._domainkey.{domain}",
          "type": "CNAME",
          "value": "<token>.dkim.<region>.amazonses.com",
          "note": "Three of these, one per token SES shows. Do not add a leading underscore to the token."
        }
      ],
      "needs_from_provider": [
        "the three DKIM tokens for the identity, shown in the SES console"
      ],
      "steps": [
        "In the SES console open Identities, choose {domain}, then the Authentication tab and Publish DNS records. SES lists three CNAME records (you can download them as a CSV).",
        "@dns_host",
        "Wait for the identity's DKIM status to turn Successful (SES says up to 72 hours)."
      ],
      "caveat": "This is an authentication fix. Whether Gmail or Outlook then puts a given email in the inbox also depends on your sending reputation, which no DNS record controls.",
      "sources": [
        "https://docs.aws.amazon.com/ses/latest/dg/creating-identities.html"
      ]
    },
    {
      "provider": "postmark",
      "dns_host": "*",
      "exact": false,
      "title": "Publish the DKIM record from Postmark",
      "why": "Your mail service signs messages with DKIM so Gmail and Outlook can see they were not altered or forged. We could not find a DKIM key for {provider} at {domain} under the common selector names (selectors cannot be listed, so this is a hint, not proof). If it is missing, marketing and order emails from {provider} are more likely to be filtered.",
      "records": [
        {
          "name": "<selector>._domainkey.{domain}",
          "type": "TXT",
          "value": "k=rsa; p=<public key shown in Postmark>",
          "note": "The selector and key are generated per account."
        }
      ],
      "needs_from_provider": [
        "the DKIM hostname and value from Postmark's DNS Settings"
      ],
      "steps": [
        "In Postmark open Sender Signatures > DNS Settings for {domain} and copy the DKIM hostname and value.",
        "@dns_host",
        "Also add the custom Return-Path CNAME Postmark shows (default host `pm-bounces`, pointing to `pm.mtasv.net`), so SPF aligns with your domain for DMARC."
      ],
      "caveat": "This is an authentication fix. Whether Gmail or Outlook then puts a given email in the inbox also depends on your sending reputation, which no DNS record controls.",
      "sources": [
        "https://postmarkapp.com/support/article/how-do-i-verify-a-domain",
        "https://postmarkapp.com/support/article/910-how-do-i-add-a-custom-return-path"
      ]
    },
    {
      "provider": "sendgrid",
      "dns_host": "*",
      "exact": false,
      "title": "Authenticate your domain in SendGrid",
      "why": "Your mail service signs messages with DKIM so Gmail and Outlook can see they were not altered or forged. We could not find a DKIM key for {provider} at {domain} under the common selector names (selectors cannot be listed, so this is a hint, not proof). If it is missing, marketing and order emails from {provider} are more likely to be filtered.",
      "records": [
        {
          "name": "s1._domainkey.{domain}",
          "type": "CNAME",
          "value": "s1.domainkey.<account-specific>.sendgrid.net",
          "note": "Plus s2._domainkey and an em#### CNAME. SendGrid shows the exact hosts and values; they differ per account."
        }
      ],
      "needs_from_provider": [
        "the CNAME hosts and values shown by SendGrid"
      ],
      "steps": [
        "In SendGrid go to Settings > Sender Authentication and authenticate {domain}. With Automated Security on (the default) it gives you CNAME records.",
        "@dns_host",
        "Click Verify in SendGrid."
      ],
      "caveat": "This is an authentication fix. Whether Gmail or Outlook then puts a given email in the inbox also depends on your sending reputation, which no DNS record controls.",
      "sources": [
        "https://www.twilio.com/docs/sendgrid/ui/account-and-settings/how-to-set-up-domain-authentication"
      ]
    },
    {
      "provider": "microsoft-365",
      "dns_host": "*",
      "exact": false,
      "title": "Publish and enable DKIM in Microsoft 365",
      "why": "Your mail service signs messages with DKIM so Gmail and Outlook can see they were not altered or forged. We could not find a DKIM key for {provider} at {domain} under the common selector names (selectors cannot be listed, so this is a hint, not proof). If it is missing, marketing and order emails from {provider} are more likely to be filtered.",
      "records": [
        {
          "name": "selector1._domainkey.{domain}",
          "type": "CNAME",
          "value": "<value shown in Defender>",
          "note": "Plus selector2._domainkey. The target depends on your tenant, so copy it from the portal."
        }
      ],
      "needs_from_provider": [
        "the two CNAME targets shown in the Defender portal"
      ],
      "steps": [
        "In the Defender portal open Email & collaboration > Policies & rules > Threat policies > Email authentication settings > DKIM, and choose {domain}. It shows the two CNAME records.",
        "@dns_host",
        "Back in that DKIM flyout, switch on \"Sign messages for this domain with DKIM signatures\". The status stays CnameMissing until the records resolve."
      ],
      "caveat": "This is an authentication fix. Whether Gmail or Outlook then puts a given email in the inbox also depends on your sending reputation, which no DNS record controls.",
      "sources": [
        "https://learn.microsoft.com/en-us/defender-office-365/email-authentication-dkim-configure"
      ]
    },
    {
      "provider": "*",
      "dns_host": "*",
      "exact": false,
      "title": "Publish the DKIM record from {provider}",
      "why": "Your mail service signs messages with DKIM so Gmail and Outlook can see they were not altered or forged. We could not find a DKIM key for {provider} at {domain} under the common selector names (selectors cannot be listed, so this is a hint, not proof). If it is missing, marketing and order emails from {provider} are more likely to be filtered.",
      "records": [
        {
          "name": "<selector>._domainkey.{domain}",
          "type": "TXT",
          "value": "<value shown by your provider>",
          "note": ""
        }
      ],
      "needs_from_provider": [
        "the DKIM record your provider shows"
      ],
      "steps": [
        "Open {provider}'s domain or DNS settings page: it shows the exact DKIM record to publish for {domain}. Check your provider's DNS settings page if unsure.",
        "@dns_host"
      ],
      "caveat": "This is an authentication fix. Whether Gmail or Outlook then puts a given email in the inbox also depends on your sending reputation, which no DNS record controls.",
      "sources": []
    }
  ]
};
