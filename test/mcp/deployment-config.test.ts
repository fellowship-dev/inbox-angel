import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const parsed=ts.parseConfigFileTextToJson('wrangler.jsonc',readFileSync('wrangler.jsonc','utf8'));
it('routes protocol and API requests through the Worker before SPA fallback',()=>{
 expect(parsed.error).toBeUndefined();
 expect(parsed.config.assets.binding).toBe('ASSETS');
 expect(parsed.config.assets.run_worker_first).toEqual(expect.arrayContaining(['/api/*','/mcp','/mcp/*','/oauth/*','/.well-known/*','/health']));
});
it('ships no installation-specific resource ids: a deploy must fail until the operator substitutes their own',()=>{
 for(const db of parsed.config.d1_databases) expect(db.database_id).toMatch(/^REPLACE_WITH_/);
 for(const kv of parsed.config.kv_namespaces) expect(kv.id).toMatch(/^REPLACE_WITH_/);
 expect(parsed.config.vars.WORKER_NAME).toBe(parsed.config.name);
});
it('declares isolated OAuth storage and public-only metadata fetch without secret defaults or invocation URL logs',()=>{
 expect(parsed.config.kv_namespaces).toEqual(expect.arrayContaining([expect.objectContaining({binding:'OAUTH_KV'})]));
 expect(parsed.config.compatibility_flags).toContain('global_fetch_strictly_public');
 expect(parsed.config.observability.logs.invocation_logs).toBe(false);
 for(const key of ['BOOTSTRAP_SECRET','API_KEY','GOOGLE_POSTMASTER_CLIENT_SECRET']) expect(parsed.config.vars).not.toHaveProperty(key);
});
