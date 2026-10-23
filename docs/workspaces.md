# Workspaces

A **workspace** holds domains, reports, members, Cloudflare connections and (later) billing. A **user** is one person with one login; a user belongs to workspaces through **memberships** with a role: `owner`, `admin`, or `member` (read-only). The role is per workspace: you can own one and be a read-only member of another.

## Using them

* The **switcher** at the top of the sidebar shows the workspace you are in, lists every workspace you belong to with your role, and has *Create workspace*. Whoever creates a workspace is its owner.
* The workspace is in the URL: `#/w/<workspaceId>/domains/1`. Links are shareable and a reload keeps your place. After signing in you land in the last one you used (remembered in the browser); a link to a workspace you cannot use shows a notice and opens one you can.
* **Members** (sidebar) is the member list of the open workspace. Owners and admins invite people there; an invite is a one-time link (7 days).
* **Settings → Workspace**: rename (owner), leave, delete (owner).

### Invites

* Email with **no login yet**: the link asks for a name and password, creates the login and the membership.
* Email that **already has a login**: no second user is created. Signed in as that email, the link is one click ("Accept invite"); not signed in, the page asks for that login's password first; signed in as a *different* email, it says so and offers to sign out. A password is never accepted to take over an existing login.
* Inviting someone who is already a member of the workspace is refused (`409`).

### Leaving and deleting

* You cannot leave your **only** workspace, and the **last owner** cannot leave a workspace (make someone else an owner, or delete it).
* Only an owner can delete a workspace; the default workspace (`ws_default`) and your only workspace cannot be deleted.
* A workspace **with domains** is deleted only when the request repeats its name (`?confirm=<name>`). Domains go through the normal domain delete first (DNS records and hosted records are cleaned up); if one fails nothing else is deleted. People who belonged only to that workspace are removed with it.

## Self-host and hosted

Creating workspaces is allowed in **both** modes. On a self-hosted instance it is aimed at agencies and consultants who manage several organisations' domains from one install:

* Workspaces share the instance's `CLOUDFLARE_API_TOKEN` (unless a domain is linked to a Cloudflare connection of its own).
* Inbound reports are routed to the workspace that owns the **reports domain** the message was sent to (each workspace sets its own base domain in the setup wizard, which creates `reports.<base domain>`); mail for an unknown reports domain goes to the default workspace. Give each workspace's reports domain Email Routing to this Worker.
* Cron jobs (digests, SPF flattening, checks) run for every workspace.
* First-run setup still creates the owner of the default workspace; further people join by invite, and sign-up stays closed.

In hosted mode (`MODE=saas`) every sign-up still gets a workspace of its own, and users can create more.

## API

All routes need a signed-in **user** (a session, not an API key or the instance key: `403` otherwise). Everything else in `/api` acts on the workspace named by the `X-Workspace-Id` header (a membership is required, `403` otherwise; without the header, the caller's oldest workspace). The `/api/workspaces` routes ignore that header: they act on you and the id in the path, and answer `404` for a workspace you are not in.

| Route | Who | |
|---|---|---|
| `GET /api/workspaces` | any user | `{workspaces: [{id, name, role, member_count, created_at}]}` |
| `POST /api/workspaces` `{name}` | any user | create; caller becomes owner. `201 {id, name, role, member_count}` |
| `PATCH /api/workspaces/:id` `{name}` | owner | rename |
| `POST /api/workspaces/:id/leave` | any member | `409 only_workspace` / `409 last_owner` |
| `DELETE /api/workspaces/:id[?confirm=<name>]` | owner | `409 confirm_required` when it has domains; `400 default_workspace`; `409 only_workspace` |
| `GET /api/invites/:token` | token | adds `workspace_id`, `workspace_name`, `user_exists`, `signed_in_as` |
| `POST /api/invites/:token` | token | new email: `{name, password}` → `201` + session. Existing login: `{}` while signed in as that email → `200 {ok, workspace_id}`; `401` not signed in; `403 wrong_user` signed in as someone else |
