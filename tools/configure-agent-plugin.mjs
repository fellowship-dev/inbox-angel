import { cp, mkdir, access, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const value = flag => args[args.indexOf(flag) + 1];
try {
  if (args.length !== 4 || !args.includes('--endpoint') || !args.includes('--out')) throw new Error('usage');
  const endpoint = new URL(value('--endpoint'));
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/mcp') throw new Error('endpoint');
  const output = resolve(value('--out'));
  try { await access(output); throw new Error('exists'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(dirname(output), { recursive: true });
  await cp(fileURLToPath(new URL('../plugins/inbox-angel/', import.meta.url)), output, { recursive: true, force: false, errorOnExist: true });
  const server = { url: endpoint.href };
  await writeFile(resolve(output, 'mcp.json'), JSON.stringify({ $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json', mcpServers: { 'inbox-angel': { type: 'streamable-http', ...server } } }, null, 2) + '\n');
  await writeFile(resolve(output, '.mcp.json'), JSON.stringify({ mcpServers: { 'inbox-angel': { type: 'http', ...server } } }, null, 2) + '\n');
  process.stdout.write('Plugin copy configured. Install it, authenticate, then verify whoami and an actual report.\n');
} catch (error) {
  // Never include supplied URLs: they may accidentally contain a credential.
  process.stderr.write('Use --endpoint with a canonical HTTPS /mcp URL without credentials, query or fragment, and --out with a new directory.\n');
  if (error.code) process.stderr.write(`Filesystem operation failed (${error.code}).\n`);
  process.exitCode = 1;
}
