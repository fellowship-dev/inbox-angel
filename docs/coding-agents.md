# For coding agents: setting up DMARC monitoring with Inbox Angel

Read this when a person asks you to "set up DMARC monitoring for my domain", "check my SPF/DKIM/DMARC", or "self-host this". It says what running Inbox Angel takes, what it costs the person, and the exact steps. Everything here is true for the code in this repository; where something depends on how an installation is configured, it says so.

**Hosted service:** none. Inbox Angel runs on the person's own Cloudflare account; follow the self-hosting steps below. Do not send anyone to a sign-up page or invent a URL. If an installation's `/llms.txt` or MCP server instructions name a hosted service URL, that installation's operator configured it.

## What self-hosting costs the person

- **Money:** whatever Cloudflare charges for Workers, D1, KV and email under the person's plan and usage. Cloudflare bills them directly; this project charges nothing. Sending mail to arbitrary recipients (free email check replies, alerts to unverified addresses) uses Cloudflare Email Service, which needs a Workers Paid plan and an onboarded sending domain. Without it, outbound mail only reaches verified Email Routing destination addresses. Check Cloudflare's current pricing; this document makes no price claims.
- **What they need:**
  - a Cloudflare account holding a Worker, a D1 database and a KV namespace (`OAUTH_KV`);
  - a runtime API token with the permissions listed in the README;
  - a canonical HTTPS origin (`BETTER_AUTH_URL`) and a private installer proof (`BOOTSTRAP_SECRET`);
  - for one-click DNS changes to a monitored domain: that domain's DNS on Cloudflare. On any other DNS host the dashboard shows the records to copy by hand;
  - for DMARC report ingestion: Cloudflare Email Routing on the reports domain (MX records and a rule to the Worker). The `_report._dmarc` authorization records also live in the reports domain's zone, not in the monitored domain's zone, so a monitored domain on external DNS can still have its reports ingested by adding the reports address to its own DMARC record;
  - Node.js 22.22.2 or newer and Wrangler, if they deploy from the CLI.
- **Time and steps:** one operator session for the README's token, deploy, account and domain steps, then DNS propagation, which takes from seconds to hours depending on the DNS host. Reports arrive only after receivers start sending them, usually daily.
- **Ongoing:** they run upgrades: back up D1, run `npm run migrate`, redeploy. `GET /api/version` on the installation says when a newer release exists. Until migrations run, the Worker answers 503 and inbound report mail is refused for retry.
- **Support:** none guaranteed. The software is MIT licensed and provided as is, with no warranty, support agreement or uptime commitment. They can open an issue on GitHub.

## Exact steps

Follow the README section [Self-hosting](../README.md#self-hosting) in order:

1. Create the runtime API token (README, "Before you start").
2. Deploy with the Deploy to Cloudflare button, the CLI or the manual GitHub Actions workflow (README, Step 1). A finished deploy is not a finished setup.
3. Create `OAUTH_KV`, set `BETTER_AUTH_URL`, and upload `BOOTSTRAP_SECRET` from a private file without printing it ([installer setup](agent-operations.md#installer-setup)).
4. The person opens the installation's HTTPS URL and creates the owner account with the installer proof. **Never ask for the proof or a password in chat**, and never put either in a URL, a log or a commit.
5. Add the domain in the setup wizard and follow its steps.
6. To use the MCP server, follow [first useful report](agent-operations.md#first-useful-report).

Verify each step from outside before calling it done: the Worker URL answers `/health`, the owner can sign in, the domain shows live DNS findings.

## Rules while helping

- Show the exact DNS records and ask before anyone changes DNS or tightens DMARC from `p=none` toward `quarantine` or `reject`. The MCP tools never change DNS or send mail.
- Report missing data as unavailable, never as zero or as a pass.
- Do not promise inbox placement. Authentication can be fixed and verified; reputation takes weeks and is not guaranteed.
- Do not invent limits, prices, support promises or scale numbers. If a fact is not in this repository, say you don't know.
