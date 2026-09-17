/**
 * renderPromptRegistry: render a host's callable registry into prompt-ready
 * text (signatures + one-line docs + value domains). Host queries (pure,
 * expression-callable functions) render in a trailing `[queries]` group —
 * the LLM calls them exactly like builtins. See SPELLLANG.md §7.
 */

import type { ArgDecl, CallableDecl, QueryDecl, Type } from './ast.js';

function typeText(t: Type): string {
  switch (t.kind) {
    case 'int':
      return 'int';
    case 'float':
      return 'float';
    case 'bool':
      return 'bool';
    case 'string':
      return 'string';
    case 'none':
      return 'none';
    case 'vec':
      return 'vec(x,y,z)';
    case 'enum':
      return t.name;
    case 'list':
      return `list<${typeText(t.elem)}>`;
    case 'record':
      return t.name;
    case 'optional':
      return `${typeText(t.inner)}?`;
    case 'typevar':
      return t.id;
  }
}

/** The renderable core shared by callables and queries (queries omit category). */
type Signable = {
  name: string;
  args: ArgDecl[];
  returnType: Type;
  fuelCost?: number;
  doc: string;
};

function signature(decl: Signable): string {
  const args = decl.args
    .map((a) => `${a.name}: ${typeText(a.type)}${a.optional ? '?' : ''}`)
    .join(', ');
  return `${decl.name}(${args}) -> ${typeText(decl.returnType)}`;
}

function domainText(decl: Signable): string {
  const parts: string[] = [];
  for (const arg of decl.args) {
    if (!arg.domain) continue;
    const d = arg.domain;
    if (d.enumValues) parts.push(`${arg.name} ∈ {${d.enumValues.join(', ')}}`);
    if (d.min !== undefined || d.max !== undefined) {
      parts.push(`${arg.name} in [${d.min ?? '-inf'}, ${d.max ?? '+inf'}]`);
    }
  }
  return parts.join('; ');
}

export function renderPromptRegistry(callables: CallableDecl[], queries: QueryDecl[] = []): string {
  const byCategory = new Map<string, CallableDecl[]>();
  for (const c of callables) {
    const cat = c.category ?? 'general';
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(c);
  }
  const lines: string[] = [];
  for (const [category, decls] of byCategory) {
    lines.push(`[${category}]`);
    for (const decl of decls) {
      const domain = domainText(decl);
      lines.push(`${signature(decl)}  (cost ${decl.fuelCost})`);
      lines.push(`  ${decl.doc}${domain ? ` ${domain}.` : ''}`);
    }
  }
  if (queries.length > 0) {
    lines.push('[queries]');
    for (const decl of queries) {
      const domain = domainText(decl);
      lines.push(`${signature(decl)}  (cost ${decl.fuelCost ?? 1})`);
      lines.push(`  ${decl.doc}${domain ? ` ${domain}.` : ''}`);
    }
  }
  return lines.join('\n');
}
