# @inbox-angel/db

Drizzle ORM schema, migrations and account-scoped typed queries for InboxAngel on Cloudflare D1.

* `src/schema.ts` — the schema (source of truth); see `SCHEMA.md`.
* `/migrations/*.sql` — what `wrangler d1 migrations apply` runs; see `UPGRADING.md`.
* `src/queries/*` — `forAccount(db, accountId)` returns every tenant-data query bound to one account;
  `globalQueries(db)` covers the few global tables (credentials lookup, free checks, IP cache).
* `src/adopt.js` — brings pre-existing installs into the migration history (`npm run migrate`).
* `src/testing` — `createMigratedD1()`: a `node:sqlite`-backed D1 with all migrations applied, for tests.

```ts
import { forAccount, IMPLICIT_ACCOUNT_ID } from '@inbox-angel/db';

const q = forAccount(env.DB, IMPLICIT_ACCOUNT_ID);
const domains = await q.domains.list();
await q.settings.set('brand_color', '#0b5fff');
```

The Worker gets its account from `src/db/scope.ts` (`scope(env.DB)`), the one place the TEN lane will replace
with a per-request tenant context.
