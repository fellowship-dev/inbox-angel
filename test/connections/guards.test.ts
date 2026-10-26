import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// Structural guards for Cloudflare connections: where the secrets may be touched.
const SRC = join(__dirname, '../../src');
const walk = (dir: string): string[] => readdirSync(dir).flatMap(n => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
});
const files = walk(SRC).map(p => ({ path: relative(SRC, p), text: readFileSync(p, 'utf8') }));
const using = (re: RegExp) => files.filter(f => re.test(f.text)).map(f => f.path).sort();

describe('connection secrets stay in their lane', () => {
  it('TOKEN_ENCRYPTION_KEY is read only by the crypto module', () => {
    expect(using(/\.TOKEN_ENCRYPTION_KEY/)).toEqual(['connections/crypto.ts']);
  });

  it('stored envelopes stay in their provider connection modules', () => {
    expect(using(/token_envelope/)).toEqual(['connections/service.ts', 'metrics/google-postmaster/connection.ts', 'metrics/google-postmaster/sync.ts']);
  });

  it('provider tokens are minted only in their OAuth clients', () => {
    expect(using(/grant_type|token_type_hint/)).toEqual(['connections/oauth.ts', 'metrics/google-postmaster/client.ts']);
  });

  it('nothing outside the connection layer builds a CfClient from a stored connection', () => {
    expect(using(/new CfClient\(/)).toEqual(['connections/service.ts', 'hosted/records.ts', 'tenancy/context.ts']);
  });

  it('no logging call in src/connections can mention a token, code, state, secret or envelope', () => {
    const offenders = files
      .filter(f => f.path.startsWith('connections/') || f.path.startsWith('metrics/') || f.path.startsWith('mcp/') || f.path === 'auth/mcp-issuer.ts' || f.path === 'auth/bootstrap.ts')
      .flatMap(f => f.text.split('\n').map((l, i) => ({ f: f.path, l, i })))
      .filter(({ l }) => /console\.(log|warn|error|info|debug)\(/.test(l))
      // the one allowed line: the operator-error log in service.ts (ids and error class names only)
      .filter(({ f, l }) => !(f === 'connections/service.ts' && l.includes('[connections]') && !/token|code|state|secret|material|envelope|access|refresh/i.test(l.replace(/\$\{this\.#host\.workspaceId\}/, ''))));
    expect(offenders.map(o => `${o.f}:${o.i + 1}`)).toEqual([]);
  });
});
