import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// Structural guards for the tenancy refactor: they fail if per-tenant state creeps back to
// module level, or a Cloudflare call bypasses CfClient.

const SRC = join(__dirname, '../../src');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? sources(p) : p.endsWith('.ts') ? [p] : [];
  });
}
const files = sources(SRC).map(p => ({ path: relative(SRC, p), text: readFileSync(p, 'utf8') }));

describe('no module-level mutable state in src/', () => {
  it('has no top-level let/var, and no top-level mutable Map/Set/array/object', () => {
    const offenders = files.flatMap(f =>
      f.text.split('\n')
        .filter(l => /^(export )?(let|var) /.test(l) || /^(export )?const \w+(: [^=]+)? = (new (Map|Set|WeakMap)\b|\[\]|\{\})/.test(l))
        .map(l => `${f.path}: ${l.trim()}`));
    expect(offenders).toEqual([]);
  });

  it('env-utils (the old module-global cache) is gone', () => {
    expect(files.map(f => f.path)).not.toContain('env-utils.ts');
    expect(files.filter(f => /env-utils/.test(f.text)).map(f => f.path).filter(p => p !== 'tenancy/load.ts')).toEqual([]);
  });
});

describe('every Cloudflare call goes through CfClient', () => {
  it('mentions api.cloudflare.com only in tenancy/cf-client.ts', () => {
    expect(files.filter(f => f.text.includes('api.cloudflare.com')).map(f => f.path)).toEqual(['tenancy/cf-client.ts']);
  });

  it('reads CLOUDFLARE_API_TOKEN only where tenants are built', () => {
    const readers = files.filter(f => /env\.CLOUDFLARE_API_TOKEN|\.CLOUDFLARE_API_TOKEN/.test(f.text)).map(f => f.path);
    expect(readers).toEqual(['tenancy/load.ts']);
  });
});
