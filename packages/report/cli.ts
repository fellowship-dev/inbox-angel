/// <reference types="node" />
// Report CLI (KTD4): cross-checked report models for domains, one JSON line per domain.
//
//   node --import ./packages/report/loader.mjs packages/report/cli.ts example.com other.io
//   node --import ./packages/report/loader.mjs packages/report/cli.ts --in domains.txt \
//     [--tokens '{"example.com":"<token>"}'] [--report-url-base https://inboxangel.io/r/] [--blocks blocks.json] [--concurrency 2]
//
// Per domain: checkDomain() once per public DoH resolver (Cloudflare, Google, NextDNS; NS and the DNS host come with each
// run), then buildReport(). Each line is {schema, domain, model, html, md} (the JSON rendering is `model` itself), or
// {schema, domain, error} when the domain could not be reported. A failed lookup is not an error: it stays in the model
// (`lookupFailed`, `grade.level: null`). One domain never aborts the batch. Public DNS only, read-only, no secrets.
import { readFileSync, realpathSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { checkDomain, DOH_ENDPOINTS, organizationalDomain, type FetchLike } from '@inbox-angel/dns-checks';
import { buildReport, REPORT_SCHEMA, renderHtml, renderMarkdown, type CallerBlock } from './src/index';

export const DEFAULT_REPORT_URL_BASE = 'https://inboxangel.io/r/';

export interface RunDeps {
  /** DoH (and policy-file) fetch; defaults to the global fetch. */
  fetch?: FetchLike;
  /** Receives each output line, newline included; defaults to stdout. */
  write?: (line: string) => void;
}

const USAGE = 'usage: cli.ts <domain>... [--in file] [--tokens <json {domain: token}>] [--report-url-base url] [--blocks <json file {domain: [{id, html}]}>] [--concurrency n]';

/** `HTTPS://WWW.Example.com/path` -> `example.com`; null when the input has no registrable domain. */
export function normalizeInput(raw: string): string | null {
  const host = raw.trim().toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .split(/[/?#]/, 1)[0]
    .replace(/^.*@/, '')
    .replace(/:\d+$/, '')
    .replace(/\.$/, '');
  return host ? organizationalDomain(host) : null;
}

function keyed<T>(map: Record<string, T>): Map<string, T> {
  const out = new Map<string, T>();
  for (const [k, v] of Object.entries(map)) {
    const d = normalizeInput(k);
    if (d) out.set(d, v);
  }
  return out;
}

function jsonObject(text: string, what: string): Record<string, unknown> {
  const v: unknown = JSON.parse(text);
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`${what} must be a JSON object`);
  return v as Record<string, unknown>;
}

/** Runs the CLI; returns the exit code (0 when every domain got a line, 2 on a usage error before any lookup). */
export async function run(argv: string[], deps: RunDeps = {}): Promise<number> {
  const write = deps.write ?? (line => { process.stdout.write(line); });
  let domains: { input: string; domain: string | null }[];
  let tokens: Map<string, string>;
  let blocks: Map<string, CallerBlock[]>;
  let base: string;
  let concurrency: number;
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        in: { type: 'string' },
        tokens: { type: 'string' },
        'report-url-base': { type: 'string', default: DEFAULT_REPORT_URL_BASE },
        blocks: { type: 'string' },
        concurrency: { type: 'string', default: '2' },
      },
    });
    const inputs = [...positionals, ...(values.in ? readFileSync(values.in, 'utf8').split(/\s+/) : [])].map(s => s.trim()).filter(Boolean);
    if (inputs.length === 0) throw new Error('no domains given');
    const seen = new Set<string>();
    domains = [];
    for (const input of inputs) {
      const domain = normalizeInput(input);
      const key = domain ?? `!${input}`;
      if (seen.has(key)) continue;
      seen.add(key);
      domains.push({ input, domain });
    }
    const rawTokens = values.tokens ? jsonObject(values.tokens, '--tokens') : {};
    for (const [k, t] of Object.entries(rawTokens)) if (typeof t !== 'string' || !t) throw new Error(`--tokens: token for ${k} must be a non-empty string`);
    tokens = keyed(rawTokens as Record<string, string>);
    const rawBlocks = values.blocks ? jsonObject(readFileSync(values.blocks, 'utf8'), '--blocks') : {};
    for (const [k, list] of Object.entries(rawBlocks)) {
      if (!Array.isArray(list) || list.some(b => typeof b?.id !== 'string' || typeof b?.html !== 'string')) throw new Error(`--blocks: ${k} must be a list of {id, html}`);
    }
    blocks = keyed(rawBlocks as Record<string, CallerBlock[]>);
    base = values['report-url-base']!;
    concurrency = Number(values.concurrency);
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('--concurrency must be a positive integer');
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n${USAGE}\n`);
    return 2;
  }

  const emit = (o: object) => write(`${JSON.stringify({ schema: REPORT_SCHEMA, ...o })}\n`);
  const queue = [...domains];
  async function worker() {
    for (let next; (next = queue.shift()); ) {
      const { input, domain } = next;
      if (!domain) { emit({ domain: input, error: 'not a registrable domain' }); continue; }
      try {
        // One resolver at a time: each checkDomain already sends ~40 lookups in parallel (DKIM selectors), and three at
        // once per domain made public resolvers drop connections ("fetch failed"), which leaves findings unconfirmed.
        const runs = [];
        for (const endpoint of Object.values(DOH_ENDPOINTS)) runs.push(await checkDomain(domain, { endpoint, fetch: deps.fetch }));
        const token = tokens.get(domain);
        const model = buildReport({ runs, reportUrl: token ? `${base}${encodeURIComponent(token)}` : null, generatedAt: new Date().toISOString() });
        emit({ domain, model, html: renderHtml(model, { blocks: blocks.get(domain) ?? [] }), md: renderMarkdown(model) });
      } catch (e) {
        emit({ domain, error: e instanceof Error ? e.message : String(e) });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, domains.length) }, worker));
  return 0;
}

const invoked = process.argv[1] ? (() => { try { return realpathSync(process.argv[1]); } catch { return null; } })() : null;
if (invoked && invoked === realpathSync(import.meta.filename)) process.exitCode = await run(process.argv.slice(2));
