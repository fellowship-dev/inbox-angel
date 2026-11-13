// HOSTED_SERVICE_URL: every surface says nothing about a hosted service when it is unset, and exactly one
// sentence when it is set on a self-hosted installation. The hosted installation (MODE=saas) never shows it.
import { describe, it, expect, vi } from 'vitest';
import type { Env } from '../src/index';

vi.mock('../src/telemetry', () => ({ track: vi.fn() }));

import { createMigratedD1 } from '@inbox-angel/db/testing';
import { hostedServiceSentence, hostedServiceUrl } from '../src/hosted-service';
import { llmsTxtBody } from '../src/llms-txt';
import { mcpInstructions } from '../src/mcp/server';
import { coreWorker, setupPage } from '../src/index';
import { handleApi } from '../src/api/router';
import { toolWorld } from './mcp/tool-fixture';

const URL_SET = 'https://app.example.net/start';
const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
const mentionsHosted = (text: string) => /hosted/i.test(text) || text.includes(URL_SET);

describe('hostedServiceUrl', () => {
  it('is null when unset, empty or not a clean https URL', () => {
    for (const value of [undefined, '', '   ', 'http://hosted.example.com', 'hosted.example.com', 'https://', 'javascript:alert(1)', 'https://user:pw@hosted.example.com', 'https://hosted.example.com/"><script>', 'https://hosted.example.com/a b']) {
      expect(hostedServiceUrl({ HOSTED_SERVICE_URL: value }), String(value)).toBeNull();
    }
  });

  it('returns the trimmed https URL on a self-hosted installation', () => {
    expect(hostedServiceUrl({ HOSTED_SERVICE_URL: ` ${URL_SET} ` })).toBe(URL_SET);
    expect(hostedServiceUrl({ MODE: 'selfhost', HOSTED_SERVICE_URL: URL_SET })).toBe(URL_SET);
  });

  it('is null on the hosted installation itself (MODE=saas)', () => {
    expect(hostedServiceUrl({ MODE: 'saas', HOSTED_SERVICE_URL: URL_SET })).toBeNull();
  });

  it('the sentence is one sentence, names the URL and keeps self-hosting supported', () => {
    const sentence = hostedServiceSentence(URL_SET);
    expect(sentence).toContain(URL_SET);
    expect(sentence).toMatch(/self-hosting stays fully supported/);
    expect(sentence.match(/\.(\s|$)/g)).toHaveLength(1);
    // No invented limits, prices or guarantees.
    expect(sentence).not.toMatch(/\$|\d+ (domains|workspaces)|guarantee|SLA|support team/i);
  });
});

describe('/llms.txt', () => {
  const get = (env: Partial<Env>) => coreWorker.fetch(new Request('https://ia.example.com/llms.txt'), { ...env } as Env, ctx);

  it('unset: describes the product and docs, says nothing about a hosted service', async () => {
    const res = await get({ BETTER_AUTH_URL: 'https://ia.example.com' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/plain/);
    const body = await res.text();
    expect(body.startsWith('# Inbox Angel\n')).toBe(true);
    expect(body).toContain('https://ia.example.com/mcp');
    expect(body).toContain('docs/coding-agents.md');
    expect(mentionsHosted(body)).toBe(false);
  });

  it('answers before a database is bound (no setup page in its place)', async () => {
    const res = await get({});
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('# Inbox Angel');
    expect(body).not.toContain('/mcp.'); // no endpoint claimed without a canonical origin
  });

  it('set: exactly one hosted sentence, self-hosting still documented', async () => {
    const body = await (await get({ BETTER_AUTH_URL: 'https://ia.example.com', HOSTED_SERVICE_URL: URL_SET })).text();
    expect(body.split(hostedServiceSentence(URL_SET))).toHaveLength(2);
    expect(body.match(/hosted/gi)).toHaveLength(1);
    expect(body).toContain('self-hosting');
  });

  it('set on the hosted installation (MODE=saas): no hosted sentence', () => {
    expect(mentionsHosted(llmsTxtBody({ MODE: 'saas', HOSTED_SERVICE_URL: URL_SET }))).toBe(false);
  });
});

describe('MCP server instructions', () => {
  it('unset: no hosted sentence', () => {
    const text = mcpInstructions({});
    expect(text).toMatch(/never change DNS or send mail/);
    expect(mentionsHosted(text)).toBe(false);
  });

  it('set: one sentence appended, the rest unchanged', () => {
    const text = mcpInstructions({ HOSTED_SERVICE_URL: URL_SET });
    expect(text.startsWith(mcpInstructions({}))).toBe(true);
    expect(text).toContain(hostedServiceSentence(URL_SET));
    expect(mcpInstructions({ MODE: 'saas', HOSTED_SERVICE_URL: URL_SET })).toBe(mcpInstructions({}));
  });

  it('a real MCP client receives the instructions; tool descriptions never mention a hosted service', async () => {
    const world = await toolWorld();
    const client = await world.connect();
    expect(client.getInstructions()).toBe(mcpInstructions({}));
    const tools = await client.listTools();
    for (const tool of tools.tools) expect(mentionsHosted(tool.description ?? ''), tool.name).toBe(false);
    await client.close();
  });

  it('a real MCP client on an installation with HOSTED_SERVICE_URL set receives the sentence', async () => {
    const world = await toolWorld();
    Object.assign(world.tenant.env, { HOSTED_SERVICE_URL: URL_SET });
    const client = await world.connect();
    expect(client.getInstructions()).toContain(hostedServiceSentence(URL_SET));
    const whoami = await client.callTool({ name: 'whoami', arguments: {} });
    expect(mentionsHosted(JSON.stringify(whoami))).toBe(false); // tool responses stay free of it
    await client.close();
  });
});

describe('setup-required page (no D1 bound)', () => {
  it('unset: no hosted mention', async () => {
    const html = await setupPage({}).text();
    expect(html).toContain('Setup required');
    expect(mentionsHosted(html)).toBe(false);
  });

  it('set: one linked sentence, setup steps unchanged', async () => {
    const plain = await setupPage({}).text();
    const html = await setupPage({ HOSTED_SERVICE_URL: URL_SET }).text();
    expect(html).toContain(`<a href="${URL_SET}"`);
    expect(html.match(/hosted free tier/g)).toHaveLength(1);
    expect(html).toContain('wrangler d1 create inbox-angel');
    expect(html.length - plain.length).toBeLessThan(600);
  });

  it('the Worker serves it with the variable when DB is unbound', async () => {
    const res = await coreWorker.fetch(new Request('https://ia.example.com/'), { HOSTED_SERVICE_URL: URL_SET } as unknown as Env, ctx);
    expect(res.status).toBe(503);
    expect(await res.text()).toContain(URL_SET);
  });
});

describe('API surfaces', () => {
  const env = (extra: Record<string, string> = {}) => ({ DB: createMigratedD1() as unknown as D1Database, BOOTSTRAP_SECRET: 'test-only-installer-proof-32-characters-minimum', ...extra }) as unknown as Env;
  const get = async (e: Env, path: string) => (await handleApi(new Request(`https://ia.example.com${path}`), e, ctx)).json() as Promise<Record<string, unknown>>;

  it('GET /api/auth/status: absent when unset, present when set (self-host), absent in saas', async () => {
    expect(await get(env(), '/api/auth/status')).not.toHaveProperty('hosted_service_url');
    expect(await get(env({ HOSTED_SERVICE_URL: URL_SET }), '/api/auth/status')).toMatchObject({ configured: false, mode: 'self-host', hosted_service_url: URL_SET });
    expect(await get(env({ MODE: 'saas', SAAS_ENABLED: '1', HOSTED_SERVICE_URL: URL_SET }), '/api/auth/status')).not.toHaveProperty('hosted_service_url');
  });

  it('GET /api/version: absent when unset, present when set', async () => {
    vi.stubGlobal('caches', { default: { match: async () => undefined, put: async () => undefined } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })));
    try {
      expect(await get(env(), '/api/version')).not.toHaveProperty('hosted_service_url');
      expect(await get(env({ HOSTED_SERVICE_URL: URL_SET }), '/api/version')).toMatchObject({ hosted_service_url: URL_SET });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
