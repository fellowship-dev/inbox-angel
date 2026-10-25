// Node resolve hook so the report CLI and the workspace packages run from their TypeScript source (Node >= 22.18 type
// stripping): an extensionless relative import ("./doh") resolves to "./doh.ts" when that file exists. Bare dependencies
// (@inbox-angel/dns-checks, tldts) resolve normally from this checkout's node_modules after `npm ci`.
//
//   node --import ./packages/report/loader.mjs packages/report/cli.ts example.com
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && context.parentURL?.startsWith('file:') && !/\.[cm]?[jt]s$/.test(specifier)) {
      const candidate = new URL(`${specifier}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context);
    }
    return nextResolve(specifier, context);
  },
});
