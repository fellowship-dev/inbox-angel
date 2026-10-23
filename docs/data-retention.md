# Data retention and deletion

What Inbox Angel keeps, for how long, and how it goes away. This is the page the privacy policy and the DPA cite: if a window changes
here, the policy changes with it. The windows are enforced by a daily job (`src/lifecycle/retention.ts`), not by convention.

## Retention windows

Defaults apply when the variable is unset. Values are whole days; a value that is not a positive whole number is ignored and the default is used
(so a typo can never switch a window off).

| Data | Kept for | Variable | Notes |
|---|---|---|---|
| Aggregate report rows and their records (`aggregate_reports`, `report_records`) | **13 months** (395 days after the report period ended) | `RETENTION_REPORTS_DAYS` | Year-over-year trends need 13 months. |
| TLS-RPT reports | **13 months** (395 days) | `RETENTION_TLS_DAYS` | |
| Raw report XML (and the raw JSON of TLS-RPT reports) | **30 days** self-hosted; **not stored** in hosted mode | `RAW_XML_RETENTION_DAYS` | `0` = never store. The parsed rows above are what the raw payload contained. After the window only the raw payload is removed. Hosted mode defaults to `0`. |
| IP enrichment cache (`ip_info`: reverse DNS, ASN, organisation, country) | **30 days** | `RETENTION_IP_INFO_DAYS` | A global cache, not per workspace. |
| Free-check results (`check_results`) | **30 days** | `RETENTION_CHECK_RESULTS_DAYS` | |
| Sessions | until they expire (sessions last 30 days) | | Includes the IP address and user agent stored with the session. |
| Email-verification and password-reset tokens | until they expire | | |
| Invites | **30 days after they expire** (used or not) | `RETENTION_INVITES_DAYS` | |
| Audit log | **12 months** (365 days) | `RETENTION_AUDIT_DAYS` | |
| Expired canary (free-check) tokens | 1 day after they expire | | Existing rule, in the hosted daily job. |
| Failed Cloudflare revocations of deleted workspaces | retried daily until they succeed, at most **30 days** | | See below. The sealed token is deleted with the row; giving up is logged and written to the audit log. |

Backups: deleted data can remain in Cloudflare D1 Time Travel restore points until they roll off. Check the retention of your D1 plan; we state
"within 30 days" for hosted deletions.

Not covered by this job: data held by other parties (Cloudflare, Stripe, Vercel, email providers) under their own terms, and the
records the privacy policy describes for the website and for sales prospecting.

## How the job works

* Runs once a day on its own cron trigger (`0 4 * * *`, so it never shares an invocation with the per-workspace jobs), over the whole database (not per workspace).
  Failed Cloudflare revocations are retried first, then the sweeps.
* Deletes in bounded batches (500 rows per statement; at most 1,000 `report_records` per statement) and issues at most **300 statements per run in total**, so D1's per-invocation query limit holds.
  A large backlog is cleared over several days. A sweep that was not finished says `<table>_truncated` in the log line.
* Report windows count from when the report ended **or** when it was received, whichever is earlier, so a report cannot extend its own life by claiming a future end date.
* Idempotent: running it again deletes nothing more. Safe to re-run by hand or after a failure.
* A failing step is logged and the other steps still run.
* Logs one line per run with the counts: `[retention] {"aggregate_reports":12,"sessions":4,…,"failed":0}`.
  Read it in Workers logs; an alert on `"failed":` greater than 0 is worthwhile.
* Retention for `leads`, suppression lists, unsubscribe records and the free-monitor subscriptions is owned by the onboarding feature, not by this job.

## Deleting a workspace

`DELETE /api/workspaces/:id` (owners; `?confirm=<name>` when it has domains). In order:

1. Cloudflare is checked for every domain; if it cannot be reached nothing is deleted.
2. Each domain is deleted through the normal delete (DNS records Inbox Angel added are removed).
3. **Every Cloudflare connection is disconnected, which revokes OAuth grants at Cloudflare.**
   If Cloudflare does not confirm a revocation the deletion still goes ahead, the failure is logged, and a *tombstone* keeps the sealed (encrypted) token
   so the daily job can retry; the tombstone is written *before* the connection is deleted, and if it cannot be written (or the connections cannot be listed) the deletion stops with `502 revoke_failed` and nothing more is removed.
   The tombstone is deleted on success, and given up after 30 days (logged and recorded in the audit log under the deleted workspace's id).
   **Pasted API tokens cannot be revoked from here**: the response says how many there were (`cloudflare.pasted_tokens`) and the owner must revoke them in the Cloudflare dashboard.
4. All workspace data is deleted, and people who belonged only to this workspace are deleted with it.

## Deleting an account

`DELETE /api/account` with `{ "confirm": "<your email>" }` (signed-in users only, not API keys). Deletes the user, their sessions, login methods
(password and OAuth links), tokens, API keys, memberships and invites addressed to them; their email is removed from the audit log (the entries remain, without it).
Workspaces only they belong to are deleted as above, including the Cloudflare revocation.

`GET /api/account` previews it: the workspaces that would be deleted and the Cloudflare connections the user created in workspaces that stay (those keep working after the user is gone; disconnect them first if that is not wanted). Invites the user sent that are still pending are revoked.

If several workspaces are deleted and a later one fails, the error names those already deleted; the account is kept and retrying finishes the job.

Refused with `409 transfer_required` while the user is the only owner of a workspace that has other members. Transfer ownership
(`POST /api/workspaces/:id/transfer-ownership {"user_id": …}`, or Members → Make owner) or delete the workspace first.
The instance workspace of a self-hosted install is never deleted this way.

## Data export

`GET /api/workspaces/:id/export` (owners) returns everything the workspace holds as JSON: members, domains, reports and records, TLS reports, settings,
audit log, invites, API-key metadata, Cloudflare connection metadata and per-domain configuration. It never includes password hashes, tokens, key hashes,
sealed Cloudflare tokens, secret settings or raw report payloads. Use it to answer subject-access and portability requests.
The dashboard has a button in Settings → Danger zone.
Columns are listed explicitly (a new column is not exported until it is added to the list), and the file is streamed a page at a time. A workspace with more than 250,000 rows in its big tables is refused with `413 export_too_large`; a background export is a planned follow-up.

## Settings reference

```
RAW_XML_RETENTION_DAYS=30        # 0 = never store raw XML; hosted default 0
RETENTION_REPORTS_DAYS=395
RETENTION_TLS_DAYS=395
RETENTION_IP_INFO_DAYS=30
RETENTION_CHECK_RESULTS_DAYS=30
RETENTION_INVITES_DAYS=30
RETENTION_AUDIT_DAYS=365
```

Set them as Worker variables (`vars` in `wrangler.jsonc`).
