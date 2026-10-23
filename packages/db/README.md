# @inbox-angel/db

Drizzle ORM schema, migrations and workspace-scoped typed queries for InboxAngel on Cloudflare D1.

* `src/schema.ts` — the schema (source of truth); see `SCHEMA.md`.
* `/migrations/*.sql` — what `wrangler d1 migrations apply` runs; see `UPGRADING.md`.
* `src/queries/*` — `forWorkspace(db, workspaceId)` returns every tenant-data query bound to one workspace;
  `globalQueries(db)` covers the few global tables (credentials lookup, free checks, IP cache).
* `src/testing` — `createMigratedD1()`: a `node:sqlite`-backed D1 with all migrations applied, for tests.

```ts
import { forWorkspace, IMPLICIT_WORKSPACE_ID } from '@inbox-angel/db';

const q = forWorkspace(env.DB, IMPLICIT_WORKSPACE_ID);
const domains = await q.domains.list();
await q.settings.set('brand_color', '#0b5fff');
```

The Worker gets its workspace from `src/db/scope.ts` (`scope(env.DB)`), the one place the TEN lane will replace
with a per-request tenant context.
