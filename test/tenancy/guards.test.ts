import { describe, it, expect } from 'vitest';
import ts from 'typescript';
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

const FROZEN = /\bas const\b|Object\.freeze|\breadonly\b|\bReadonly(Array|Map|Set)?\b/;

function isMutableInit(init: ts.Expression): boolean {
  let e = init;
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
  if (ts.isArrayLiteralExpression(e) || ts.isObjectLiteralExpression(e)) return true;
  if (ts.isNewExpression(e) && ts.isIdentifier(e.expression)) return /^(Map|Set|WeakMap|WeakSet|Array|Object)$/.test(e.expression.text);
  if (ts.isCallExpression(e)) return /^(Array\.from|Object\.create|new Array)$/.test(e.expression.getText());
  return false;
}

/**
 * Module-level mutable state: let/var, mutable Map/Set/array/object consts, and static class fields.
 * Parsed with the TypeScript compiler, so indentation, nesting in top-level blocks/namespaces,
 * comments, strings and regexes can't fool it. Function and method bodies are not module level.
 */
export function mutableModuleState(text: string): string[] {
  const sf = ts.createSourceFile('x.ts', text, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const flag = (n: ts.Node) => out.push(n.getText(sf).split('\n')[0].trim());
  const visit = (n: ts.Node): void => {
    if (ts.isFunctionLike(n) && !ts.isClassLike(n)) return;
    if (ts.isVariableStatement(n)) {
      const list = n.declarationList;
      const kind = list.flags & ts.NodeFlags.BlockScoped;
      for (const d of list.declarations) {
        const mutableBinding = !(list.flags & ts.NodeFlags.Const); // let / var
        if ((mutableBinding || (d.initializer && isMutableInit(d.initializer) && !FROZEN.test(d.getText(sf)))) && kind !== undefined) flag(d);
      }
      return;
    }
    if (ts.isPropertyDeclaration(n) && n.modifiers?.some(m => m.kind === ts.SyntaxKind.StaticKeyword)
        && !n.modifiers.some(m => m.kind === ts.SyntaxKind.ReadonlyKeyword)) flag(n);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

describe('the guard itself', () => {
  it('flags indented declarations, non-empty literals, new Array/Map and static class fields', () => {
    const bad = [
      '  let cache = 1;',
      'var x;',
      'export const m = new Map([["a", 1]]);',
      'const a = new Array(3);',
      'const list = [1, 2, 3];',
      'const o = { a: 1 };',
      'const w = new WeakMap<object, string>();',
      'class K {\n  static cache = new Map();\n  static n = 0;\n}',
      'if (true) {\n  var hidden = 1;\n}',
      'namespace N { export const m = new Map(); }',
    ];
    for (const b of bad) expect(mutableModuleState(b), b).not.toEqual([]);
  });

  it('allows frozen constants, locals and static methods', () => {
    const ok = [
      'const A = [1, 2] as const;',
      'const B = Object.freeze({ a: 1 });',
      'const C: ReadonlyArray<string> = ["a"];',
      'const D: Readonly<Record<string, string>> = { a: "b" };',
      'function f() { let x = 1; const y = [1]; return x + y.length; }',
      'class K {\n  static make() { return 1; }\n  static readonly NAME = "k";\n  private cache = new Map();\n}',
      'const s = "let x = [1]"; // let y = {}',
      'const re = /let/;',
      'const q = /"/; const o2 = "}}}"; const tpl = `${1}{`;',
    ];
    for (const o of ok) expect(mutableModuleState(o), o).toEqual([]);
  });
});

describe('no module-level mutable state in src/', () => {
  it('has no top-level let/var, mutable Map/Set/array/object, or static class field', () => {
    const offenders = files.flatMap(f => mutableModuleState(f.text).map(l => `${f.path}: ${l}`));
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
