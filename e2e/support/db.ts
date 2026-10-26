// Direct access to the local D1 that `wrangler dev --persist-to` serves, for what the API cannot do
// (ingest reports, add a domain without the setup wizard's DNS steps).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';

const PERSIST = process.env.E2E_PERSIST_TO ?? '/tmp/ia-e2e';

export function runSql(sql: string): void {
	const file = join(mkdtempSync(join(tmpdir(), 'ia-sql-')), 'q.sql');
	writeFileSync(file, sql);
	execFileSync('npx', ['wrangler', 'd1', 'execute', 'inbox-angel', '--local', '--persist-to', PERSIST, '--file', file], { stdio: 'pipe' });
}

/** The id of `domain` in the owner's workspace, adding it first if needed. */
export async function ensureDomain(page: Page, domain: string): Promise<number> {
	const list = async () => ((await (await page.request.get('/api/domains')).json()).domains as Array<{ id: number; domain: string }>);
	let found = (await list()).find((d) => d.domain === domain);
	if (!found) {
		runSql(`INSERT OR IGNORE INTO domains (workspace_id, domain, rua_address) VALUES ('ws_default', '${domain}', 'rua@reports.e2e.test');`);
		found = (await list()).find((d) => d.domain === domain);
	}
	if (!found) throw new Error(`could not create ${domain}`);
	return found.id;
}
