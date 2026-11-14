// GET /llms.txt (https://llmstxt.org): a short, factual summary of this installation for coding agents.
// It needs no database and reveals nothing private: no domains, workspaces, users or settings.

import { hostedServiceSentence, hostedServiceUrl, type HostedServiceEnv } from './hosted-service';
import { mcpInstallation } from './mcp/discovery';

const REPO = 'https://github.com/fellowship-dev/inbox-angel';

export interface LlmsTxtEnv extends HostedServiceEnv {
  BETTER_AUTH_URL?: string;
  PUBLIC_BASE_URL?: string;
}

export function llmsTxtBody(env: LlmsTxtEnv): string {
  const hosted = hostedServiceUrl(env);
  let mcp: string | null = null;
  try {
    mcp = mcpInstallation(env).resource;
  } catch {
    // No canonical HTTPS origin configured yet: say nothing about this installation's endpoint.
  }
  const lines = [
    '# Inbox Angel',
    '',
    '> Checks a domain\'s SPF, DKIM and DMARC from live DNS, shows what to fix with the exact records to publish, ingests DMARC aggregate reports once report intake is configured, and offers an MCP server for agents. Open source (MIT), runs as a Cloudflare Worker.',
    '',
  ];
  if (hosted) lines.push(hostedServiceSentence(hosted), '');
  if (mcp) {
    lines.push(
      `This installation's MCP endpoint is ${mcp}. A person signs in in the browser and approves exact domains, actions and an expiry; the tools read DNS and reports and can enroll a domain, but never change DNS or send mail.`,
      '',
    );
  }
  lines.push(
    '## Docs',
    '',
    `- [Guide for coding agents](${REPO}/blob/main/docs/coding-agents.md): for "set up DMARC monitoring for my domain" or "self-host this": what running it takes, what it costs, and the exact steps`,
    `- [README](${REPO}#readme): what the product does, self-hosting, upgrading and uninstalling`,
    `- [Agents, product credentials and source metrics](${REPO}/blob/main/docs/agent-operations.md): installer setup, connecting an MCP client, first useful report`,
    '',
  );
  return lines.join('\n');
}

export function llmsTxt(env: LlmsTxtEnv, head = false): Response {
  return new Response(head ? null : llmsTxtBody(env), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'max-age=300', 'X-Content-Type-Options': 'nosniff' },
  });
}
