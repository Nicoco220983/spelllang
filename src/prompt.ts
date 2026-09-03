/**
 * renderPromptRegistry: render a host's callable registry into prompt-ready
 * text (signatures + one-line docs + value domains). See SPELLLANG.md §7.
 */

import type { CallableDecl, Type } from './ast.js';

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
  }
}

function signature(decl: CallableDecl): string {
  const args = decl.args
    .map((a) => `${a.name}: ${typeText(a.type)}${a.optional ? '?' : ''}`)
    .join(', ');
  return `${decl.name}(${args}) -> ${typeText(decl.returnType)}`;
}

function domainText(decl: CallableDecl): string {
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

export function renderPromptRegistry(callables: CallableDecl[]): string {
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
  return lines.join('\n');
}
