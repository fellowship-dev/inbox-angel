import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse as parseYaml } from 'yaml';

const root = 'plugins/inbox-angel';
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
describe('distributable agent setup', () => {
 it('ships matching portable and Codex identities plus three focused skills', () => {
  const portable = json(`${root}/plugin.json`), codex = json(`${root}/.codex-plugin/plugin.json`);
  expect(portable.$schema).toBe('https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
  expect(codex).toMatchObject({name:portable.name,version:portable.version,skills:'./skills/',mcpServers:'./.mcp.json'});
  expect(readdirSync(`${root}/skills`).sort()).toEqual(['domain-setup','email-health','remediation-plan']);
  for (const name of readdirSync(`${root}/skills`)) {
   const skill=readFileSync(`${root}/skills/${name}/SKILL.md`,'utf8');
   expect(skill).toMatch(new RegExp(`^---\\nname: ${name}\\n`));
   const metadata=parseYaml(skill.match(/^---\n([\s\S]*?)\n---/)![1]);
   expect(metadata).toMatchObject({name,description:expect.any(String)});
   expect(metadata.description.trim().length).toBeGreaterThan(10);
   expect(skill).toContain('whoami');
   expect(skill).not.toMatch(/defaultPassword|Bearer ias_/);
  }
 });
 it('generates an endpoint-specific copy without embedding credentials or changing the source', () => {
  const dir=mkdtempSync(join(tmpdir(),'ia-plugin-')), out=join(dir,'configured');
  const result=spawnSync(process.execPath,['tools/configure-agent-plugin.mjs','--endpoint','https://my-install.example/mcp','--out',out],{encoding:'utf8'});
  expect(result.status,result.stderr).toBe(0);
  expect(json(join(out,'mcp.json')).mcpServers['inbox-angel']).toEqual({type:'streamable-http',url:'https://my-install.example/mcp'});
  expect(json(join(out,'.mcp.json')).mcpServers['inbox-angel']).toEqual({type:'http',url:'https://my-install.example/mcp'});
  expect(json(`${root}/mcp.json`).mcpServers).toEqual({});
  expect(existsSync(join(out,'skills/email-health/SKILL.md'))).toBe(true);
  // Reconfiguration cannot overwrite an existing operator package.
  expect(spawnSync(process.execPath,['tools/configure-agent-plugin.mjs','--endpoint','https://other.example/mcp','--out',out]).status).not.toBe(0);
 });
 it('rejects credential-bearing, insecure and noncanonical endpoint URLs before writing', () => {
  for(const endpoint of ['http://my-install.example/mcp','https://user:secret@my-install.example/mcp','https://my-install.example/mcp?token=secret','https://my-install.example/other']) {
   const dir=mkdtempSync(join(tmpdir(),'ia-plugin-invalid-')),out=join(dir,'package');
   const result=spawnSync(process.execPath,['tools/configure-agent-plugin.mjs','--endpoint',endpoint,'--out',out],{encoding:'utf8'});
   expect(result.status).not.toBe(0);expect(existsSync(out)).toBe(false);
   expect(result.stdout+result.stderr).not.toContain('secret');
  }
 });
});
