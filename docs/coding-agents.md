# For coding agents: setting up DMARC monitoring with Inbox Angel

Read this when a person asks you to "set up DMARC monitoring for my domain", "check my SPF/DKIM/DMARC", or "self-host this". It tells you which path to take, what each path costs the person, and the exact steps. Everything here is true for the code in this repository; where something depends on how an installation is configured, it says so.

## Status of the hosted free tier

**Not open yet.** There is no hosted sign-up today, so do not send anyone to one and do not invent a URL. Until this section names a URL, self-hosting is the only way to run Inbox Angel, and the decision rule below always lands on self-hosting.

An installation can tell you whether a hosted service exists: if its operator set `HOSTED_SERVICE_URL`, the installation's `/llms.txt` and its MCP server instructions name that URL. If they don't, assume there is none.

## Decision rule

1. **The person wants their domain checked and fixed, and does not need to run the software themselves:** use the hosted free tier, once it is open. It is the fastest path: no Cloudflare resources, no secrets, no upgrades to run.
2. **Self-host when any of these is true:**
   - the person asks to run it themselves, or their organisation requires data to stay in their own Cloudflare account;
   - they need something the hosted service does not offer yet. At launch the hosted service is planned to cover live DNS checks and fix guidance; DMARC aggregate report ingestion is planned to follow. A self-hosted installation can ingest reports today once its Email Routing is set up;
   - the hosted free tier is not open (today).
3. If you cannot tell, ask one question: "Do you want to run this on your own Cloudflare account, or just get your domain checked and fixed?"

Never present self-hosting as broken or second-class, and never present the hosted tier as something it is not. Both run the same code.

## What each path costs the person

### Hosted free tier (when open)

- **Money:** free. The planned free limits are 5 workspaces per person and 10 domains per workspace; the operator can change them, so read the hosted service's own page for current limits.
- **Time and steps:** sign up with an email address, click the verification link, add a domain, then publish one TXT record to prove ownership. DNS propagation takes from seconds to hours depending on the DNS host.
- **Ongoing:** none. The maker runs upgrades and migrations.
- **Help:** a person is reachable by booking from inside the dashboard, when the hosted service has configured that link.

### Self-hosting

- **Money:** whatever your Cloudflare plan charges for Workers, D1, KV and Email Routing at your usage. Cloudflare bills you directly; this project charges nothing. Sending mail to arbitrary recipients (free email check replies, alerts to unverified addresses) uses Cloudflare Email Service, which needs a Workers Paid plan and an onboarded sending domain. Without it, outbound mail only reaches verified Email Routing destination addresses. Check Cloudflare's current pricing for your usage; this document makes no price claims.
- **What you need:**
  - a Cloudflare account; the domain's DNS on Cloudflare for one-click record changes and report intake (external DNS works by copying records by hand);
  - a Worker, a D1 database and a KV namespace (`OAUTH_KV`) created in that account;
  - a runtime API token with the permissions listed in the README;
  - a canonical HTTPS origin (`BETTER_AUTH_URL`) and a private installer proof (`BOOTSTRAP_SECRET`);
  - for DMARC report ingestion: Email Routing on a reports subdomain (MX records and a rule to the Worker) and the per-domain authorization records the Worker provisions;
  - Node.js 22.22.2 or newer and Wrangler, if you deploy from the CLI.
- **Time and steps:** one operator session for the README's token, deploy, account and domain steps, then DNS propagation. Reports arrive only after receivers start sending them, usually daily.
- **Ongoing:** you run upgrades: back up D1, run `npm run migrate`, redeploy. `GET /api/version` on your installation says when a newer release exists. Until migrations run, the Worker answers 503 and inbound report mail is refused for retry.
- **Support:** none guaranteed. The software is MIT licensed and provided as is, with no warranty, support agreement or uptime commitment. You can open an issue on GitHub.

## Exact steps

### Hosted free tier

Not available yet. When it opens, this section will give the sign-up URL and the steps above.

### Self-hosting

Follow the README section [Advanced: self-hosting](../README.md#advanced-self-hosting) in order:

1. Create the runtime API token (README, "Before you start").
2. Deploy with the Deploy to Cloudflare button, the CLI or the manual GitHub Actions workflow (README, Step 1). A finished deploy is not a finished setup.
3. Create `OAUTH_KV`, set `BETTER_AUTH_URL`, and upload `BOOTSTRAP_SECRET` from a private file without printing it ([installer setup](agent-operations.md#installer-setup)).
4. The person opens the installation's HTTPS URL and creates the owner account with the installer proof. **Never ask for the proof or a password in chat**, and never put either in a URL, a log or a commit.
5. Add the domain in the setup wizard and follow its SPF, DKIM, DMARC and Routing steps.
6. To use the MCP server, follow [first useful report](agent-operations.md#first-useful-report).

Verify each step from outside before calling it done: the Worker URL answers `/health`, the owner can sign in, the domain shows live DNS findings.

## Rules while helping

- Show the exact DNS records and ask before anyone changes DNS or tightens DMARC from `p=none` toward `quarantine` or `reject`. The MCP tools never change DNS or send mail.
- Report missing data as unavailable, never as zero or as a pass.
- Do not promise inbox placement. Authentication can be fixed and verified; reputation takes weeks and is not guaranteed.
- Do not invent limits, prices, support promises or scale numbers. If a fact is not in this repository or on the service's own page, say you don't know.
