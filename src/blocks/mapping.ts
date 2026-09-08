/**
 * spelllang block mapping — the pure, DOM-free core of the block surface.
 *
 * There is no intermediate block tree: the AST is the edited model and each
 * node kind has exactly one block rendering (documented per node in BLOCKS.md).
 * This module provides:
 *
 * - the socket render rule (DESIGN.md §8): when an expression socket renders
 *   as an inline text field vs nested blocks (`shouldRenderAsTextField`)
 * - literal socket specialization (`socketView`)
 * - palette composition from the host registry (`paletteModel`)
 * - default expressions for new blocks / fresh args (`defaultExprFor`)
 * - statement-list path addressing and pure AST edit operations
 *
 * Paths: a `StmtPath` is a flat array alternating a statement index (number)
 * with a child-list key (`'body:<branch>'` into an `if` branch body, `'else'`
 * into an `else` body). It always has odd length; the last number is the
 * index of the statement inside its list. Examples:
 * - `[2]` — third statement of the program
 * - `[2, 'body:0', 1]` — second statement of the first `if` branch of the
 *   third program statement
 * - `[0, 'else', 0]` — first statement of the `else` body of statement 0
 */

import type {
  CallableDecl,
  EnumDecl,
  Expr,
  Program,
  Stmt,
  Type,
} from '../ast.js';
import type { Registry } from '../validator.js';

// ---------------------------------------------------------------------------
// Small constructors for editor-generated nodes (no source location exists —
// generated nodes carry a synthetic loc)
// ---------------------------------------------------------------------------

export const genLoc = { line: 1, col: 1 } as const;

export const numLit = (value: number, isInt = true): Expr => ({
  kind: 'num',
  value,
  isInt,
  loc: genLoc,
});
export const boolLit = (value: boolean): Expr => ({
  kind: 'bool',
  value,
  loc: genLoc,
});
export const strLit = (value: string): Expr => ({ kind: 'str', value, loc: genLoc });
export const enumLit = (name: string): Expr => ({ kind: 'enum', name, loc: genLoc });
export const listLit = (elements: Expr[]): Expr => ({ kind: 'list', elements, loc: genLoc });

// ---------------------------------------------------------------------------
// Socket render rule (DESIGN.md §8)
// ---------------------------------------------------------------------------

function countCalls(expr: Expr): number {
  switch (expr.kind) {
    case 'callBuiltin':
      return 1 + expr.args.reduce((n, a) => n + countCalls(a), 0);
    case 'binary':
      return countCalls(expr.left) + countCalls(expr.right);
    case 'unary':
      return countCalls(expr.operand);
    case 'member':
      return countCalls(expr.object);
    case 'list':
      return expr.elements.reduce((n, e) => n + countCalls(e), 0);
    default:
      return 0;
  }
}

/** True if any `member` node in the subtree accesses a call result. */
function hasMemberOnCall(expr: Expr): boolean {
  switch (expr.kind) {
    case 'member':
      return countCalls(expr.object) > 0 || hasMemberOnCall(expr.object);
    case 'callBuiltin':
      return expr.args.some(hasMemberOnCall);
    case 'binary':
      return hasMemberOnCall(expr.left) || hasMemberOnCall(expr.right);
    case 'unary':
      return hasMemberOnCall(expr.operand);
    case 'list':
      return expr.elements.some(hasMemberOnCall);
    default:
      return false;
  }
}

/**
 * DESIGN.md §8: an expression renders as an inline text field iff it contains
 * at most one function call and no member access on a call result; otherwise
 * nested blocks (applied recursively per socket).
 */
export function shouldRenderAsTextField(expr: Expr): boolean {
  return countCalls(expr) <= 1 && !hasMemberOnCall(expr);
}

// ---------------------------------------------------------------------------
// Socket views (literal specialization on top of the render rule)
// ---------------------------------------------------------------------------

export type SocketView =
  | { kind: 'nested' }
  | { kind: 'number' }
  | { kind: 'enum'; values: string[] }
  | { kind: 'bool' }
  | { kind: 'text' };

function enumDecl(reg: Registry, type: Type): EnumDecl | null {
  if (type.kind !== 'enum') return null;
  const decl = reg.types.get(type.name);
  return decl && decl.kind === 'enum' ? decl : null;
}

/** The enum *type* declaring the given value, if any (enum expr nodes store the value). */
function findEnumType(reg: Registry, value: string): string | null {
  for (const [name, decl] of reg.types) {
    if (decl.kind === 'enum' && decl.values.includes(value)) return name;
  }
  return null;
}

/**
 * Decide how a socket holding `expr` (expected type `expected`, null when
 * unconstrained — e.g. a fresh `let` value) is presented.
 */
export function socketView(expr: Expr, expected: Type | null, reg: Registry): SocketView {
  if (!shouldRenderAsTextField(expr)) return { kind: 'nested' };
  if (expr.kind === 'enum') {
    const typeName = expected?.kind === 'enum' ? expected.name : findEnumType(reg, expr.name);
    const decl = typeName ? reg.types.get(typeName) : null;
    return { kind: 'enum', values: decl && decl.kind === 'enum' ? decl.values : [expr.name] };
  }
  if (expected?.kind === 'enum' && expr.kind === 'var') {
    // enum-typed socket holding a non-literal: offer the value list as hints
    const decl = enumDecl(reg, expected);
    if (decl) return { kind: 'enum', values: decl.values };
  }
  if (
    expr.kind === 'num' &&
    (expected === null || expected.kind === 'int' || expected.kind === 'float')
  )
    return { kind: 'number' };
  if (expr.kind === 'bool' && (expected === null || expected.kind === 'bool'))
    return { kind: 'bool' };
  return { kind: 'text' };
}

// ---------------------------------------------------------------------------
// Defaults for new blocks and fresh call args
// ---------------------------------------------------------------------------

/**
 * A valid-by-construction default literal for `type`, or null when the type
 * has no literal form (records, vec) — callers then fall back to `num 0`,
 * which the validator flags with a type error (an honest "fill me" state).
 */
export function defaultExprFor(type: Type, reg: Registry): Expr | null {
  switch (type.kind) {
    case 'int':
    case 'float':
      return numLit(0, type.kind === 'int');
    case 'bool':
      return boolLit(false);
    case 'string':
      return strLit('');
    case 'enum': {
      const decl = enumDecl(reg, type);
      return decl && decl.values.length > 0 ? enumLit(decl.values[0]!) : null;
    }
    case 'list':
      return listLit([]);
    case 'optional':
      return null; // optional args start omitted
    default:
      return null;
  }
}

/** Positional args for a fresh `call` block: required args defaulted, trailing optional args omitted. */
export function defaultCallArgs(decl: CallableDecl, reg: Registry): Expr[] {
  const args: Expr[] = [];
  for (const arg of decl.args) {
    if (arg.optional) break; // trailing optionals start omitted
    args.push(defaultExprFor(arg.type, reg) ?? numLit(0));
  }
  return args;
}

// ---------------------------------------------------------------------------
// Statement paths and pure AST edits
// ---------------------------------------------------------------------------

export type ListKey = `body:${number}` | 'else';
export type StmtPath = (number | ListKey)[];

/** Split a statement path into its containing-list path and final index. */
export function splitPath(path: StmtPath): { list: StmtPath; index: number } {
  return { list: path.slice(0, -1), index: path[path.length - 1] as number };
}

function childList(stmt: Stmt, key: ListKey): Stmt[] | null {
  if (key === 'else') return stmt.kind === 'if' ? stmt.elseBody : null;
  const branch = Number(key.slice('body:'.length));
  if (stmt.kind === 'for') return branch === 0 ? stmt.body : null;
  if (stmt.kind === 'if') return stmt.branches[branch]?.body ?? null;
  return null;
}

function withChildList(stmt: Stmt, key: ListKey, list: Stmt[] | null): Stmt {
  if (key === 'else') return stmt.kind === 'if' ? { ...stmt, elseBody: list } : stmt;
  const branch = Number(key.slice('body:'.length));
  if (stmt.kind === 'for') return branch === 0 ? { ...stmt, body: list ?? [] } : stmt;
  if (stmt.kind === 'if') {
    if (!stmt.branches[branch]) return stmt;
    const branches = stmt.branches.map((b, i) => (i === branch ? { ...b, body: list ?? [] } : b));
    return { ...stmt, branches };
  }
  return stmt;
}

/** The statement list containing the statement at `path` (null if the path is stale). */
export function getStmtList(root: Program, path: StmtPath): Stmt[] | null {
  let list = root.statements;
  for (let i = 0; i + 1 < path.length; i += 2) {
    const stmt = list[path[i] as number];
    if (!stmt) return null;
    const child = childList(stmt, path[i + 1] as ListKey);
    if (!child) return null;
    list = child;
  }
  return list;
}

/** The statement at `path` (null if the path is stale). */
export function getStmt(root: Program, path: StmtPath): Stmt | null {
  const { index } = splitPath(path);
  return getStmtList(root, path)?.[index] ?? null;
}

function setStmtList(root: Program, listPath: StmtPath, list: Stmt[]): Program {
  if (listPath.length === 0) return { ...root, statements: list };
  const parentPath = listPath.slice(0, -1);
  const parentIndex = listPath[listPath.length - 2] as number;
  const key = listPath[listPath.length - 1] as ListKey;
  const parentList = getStmtList(root, parentPath);
  if (parentIndex === undefined || !parentList) return root;
  const stmt = parentList[parentIndex];
  if (!stmt) return root;
  const updated = withChildList(stmt, key, list);
  const nextParent = [
    ...parentList.slice(0, parentIndex),
    updated,
    ...parentList.slice(parentIndex + 1),
  ];
  return setStmtList(root, parentPath.slice(0, -1), nextParent);
}

/** Return a new program with `insert` spliced into the list at `path` (`remove` items removed first). */
export function spliceStmt(root: Program, path: StmtPath, remove: number, ...insert: Stmt[]): Program {
  const { list: listPath, index } = splitPath(path);
  const target = getStmtList(root, path);
  if (!target) return root;
  const next = [...target.slice(0, index), ...insert, ...target.slice(index + remove)];
  return setStmtList(root, listPath, next);
}

/** Return a new program with the statement at `path` replaced by `next`. */
export function replaceStmt(root: Program, path: StmtPath, next: Stmt): Program {
  return spliceStmt(root, path, 1, next);
}

/**
 * Translate a destination path for the state *after* `from` has been removed:
 * at the first shared level where the removed index sorts before the
 * destination index, that level shifts down by one (deeper levels are
 * unaffected; a divergent sibling list is unaffected).
 */
function adjustAfterRemoval(from: StmtPath, to: StmtPath): StmtPath {
  const out = [...to];
  for (let i = 0; i < Math.min(from.length, to.length); i++) {
    const f = from[i]!;
    const t = to[i]!;
    if (typeof f === 'number' && typeof t === 'number') {
      if (f < t) {
        out[i] = t - 1;
        break;
      }
      if (f > t) break;
    } else if (f !== t) {
      break;
    }
  }
  return out;
}

/**
 * Move the statement at `from` to `to` (a path whose final index is the
 * destination position, as if inserting before it). No-op on stale paths;
 * clamps the destination index to the list length.
 */
export function moveStmt(root: Program, from: StmtPath, to: StmtPath): Program {
  const stmt = getStmt(root, from);
  if (!stmt) return root;
  const next = spliceStmt(root, from, 1);
  const dest = adjustAfterRemoval(from, to);
  const { list: destList, index: destIndex } = splitPath(dest);
  const list = getStmtList(next, dest);
  if (!list) return root;
  const index = Math.max(0, Math.min(destIndex, list.length));
  return spliceStmt(next, [...destList, index], 0, stmt);
}

// ---------------------------------------------------------------------------
// Expression slot navigation (sockets inside a statement or nested expr)
// ---------------------------------------------------------------------------

export type ExprSel =
  | 'value'
  | `cond:${number}`
  | 'iterable'
  | `arg:${number}`
  | `elem:${number}`
  | 'object'
  | 'left'
  | 'right'
  | 'operand';

type ExprContainer = { kind: 'stmt'; stmt: Stmt } | { kind: 'expr'; expr: Expr };

function childExpr(c: ExprContainer, sel: ExprSel): Expr | null {
  if (sel === 'value') {
    return c.kind === 'stmt' &&
      (c.stmt.kind === 'let' || c.stmt.kind === 'assign' || c.stmt.kind === 'stateAssign')
      ? c.stmt.value
      : null;
  }
  if (c.kind === 'stmt') {
    const s = c.stmt;
    if (s.kind === 'call' && sel.startsWith('arg:')) return s.args[Number(sel.slice(4))] ?? null;
    if (s.kind === 'if' && sel.startsWith('cond:')) return s.branches[Number(sel.slice(5))]?.cond ?? null;
    if (s.kind === 'for' && sel === 'iterable') return s.iterable;
    return null;
  }
  const e = c.expr;
  if (sel.startsWith('arg:')) return e.kind === 'callBuiltin' ? (e.args[Number(sel.slice(4))] ?? null) : null;
  if (sel.startsWith('elem:')) return e.kind === 'list' ? (e.elements[Number(sel.slice(5))] ?? null) : null;
  switch (sel) {
    case 'object':
      return e.kind === 'member' ? e.object : null;
    case 'left':
      return e.kind === 'binary' ? e.left : null;
    case 'right':
      return e.kind === 'binary' ? e.right : null;
    case 'operand':
      return e.kind === 'unary' ? e.operand : null;
    default:
      return null;
  }
}

function withChildExpr(c: ExprContainer, sel: ExprSel, next: Expr): ExprContainer {
  if (
    sel === 'value' &&
    c.kind === 'stmt' &&
    (c.stmt.kind === 'let' || c.stmt.kind === 'assign' || c.stmt.kind === 'stateAssign')
  ) {
    return { kind: 'stmt', stmt: { ...c.stmt, value: next } };
  }
  if (c.kind === 'stmt') {
    const s = c.stmt;
    if (s.kind === 'call' && sel.startsWith('arg:')) {
      const i = Number(sel.slice(4));
      if (i >= s.args.length) return c;
      return { kind: 'stmt', stmt: { ...s, args: s.args.map((a, j) => (j === i ? next : a)) } };
    }
    if (s.kind === 'if' && sel.startsWith('cond:')) {
      const b = Number(sel.slice(5));
      if (!s.branches[b]) return c;
      return {
        kind: 'stmt',
        stmt: { ...s, branches: s.branches.map((br, j) => (j === b ? { ...br, cond: next } : br)) },
      };
    }
    if (s.kind === 'for' && sel === 'iterable') {
      return { kind: 'stmt', stmt: { ...s, iterable: next } };
    }
    return c;
  }
  const e = c.expr;
  if (sel.startsWith('arg:') && e.kind === 'callBuiltin') {
    const i = Number(sel.slice(4));
    if (i >= e.args.length) return c;
    return { kind: 'expr', expr: { ...e, args: e.args.map((a, j) => (j === i ? next : a)) } };
  }
  if (sel.startsWith('elem:') && e.kind === 'list') {
    const i = Number(sel.slice(5));
    if (i >= e.elements.length) return c;
    return { kind: 'expr', expr: { ...e, elements: e.elements.map((a, j) => (j === i ? next : a)) } };
  }
  switch (sel) {
    case 'object':
      return e.kind === 'member' ? { kind: 'expr', expr: { ...e, object: next } } : c;
    case 'left':
      return e.kind === 'binary' ? { kind: 'expr', expr: { ...e, left: next } } : c;
    case 'right':
      return e.kind === 'binary' ? { kind: 'expr', expr: { ...e, right: next } } : c;
    case 'operand':
      return e.kind === 'unary' ? { kind: 'expr', expr: { ...e, operand: next } } : c;
    default:
      return c;
  }
}

/** The expression held by the socket addressed by `sel` inside `stmt` (null if stale). */
export function getExprSlot(stmt: Stmt, sel: ExprSel[]): Expr | null {
  let c: ExprContainer = { kind: 'stmt', stmt };
  for (const s of sel) {
    const next = childExpr(c, s);
    if (!next) return null;
    c = { kind: 'expr', expr: next };
  }
  return c.kind === 'expr' ? c.expr : null;
}

function replaceInExpr(expr: Expr, sel: ExprSel[], next: Expr): Expr {
  const [first, ...rest] = sel as [ExprSel, ...ExprSel[]];
  const child = childExpr({ kind: 'expr', expr }, first);
  if (!child) return expr;
  const replaced = rest.length === 0 ? next : replaceInExpr(child, rest, next);
  const upd = withChildExpr({ kind: 'expr', expr }, first, replaced);
  return upd.kind === 'expr' ? upd.expr : expr;
}

/** Return a new statement with the socket addressed by `sel` holding `next`. */
export function replaceExprSlot(stmt: Stmt, sel: ExprSel[], next: Expr): Stmt {
  if (sel.length === 0) return stmt;
  const [first, ...rest] = sel as [ExprSel, ...ExprSel[]];
  const child = childExpr({ kind: 'stmt', stmt }, first);
  if (!child) return stmt;
  const replaced = rest.length === 0 ? next : replaceInExpr(child, rest, next);
  const upd = withChildExpr({ kind: 'stmt', stmt }, first, replaced);
  return upd.kind === 'stmt' ? upd.stmt : stmt;
}

// ---------------------------------------------------------------------------
// Scope inspection (assign targets)
// ---------------------------------------------------------------------------

/** `let` names (and enclosing `for` variables) visible at the statement `path`. */
export function visibleInScopeLets(root: Program, path: StmtPath): string[] {
  const names: string[] = [];
  const collect = (list: Stmt[], upto: number): void => {
    for (let i = 0; i < Math.min(upto, list.length); i++) {
      const s = list[i]!;
      if (s.kind === 'let') names.push(s.name);
      if (s.kind === 'for') names.push(s.variable);
    }
  };
  let list = root.statements;
  for (let i = 0; i + 1 < path.length; i += 2) {
    const idx = path[i] as number;
    collect(list, idx);
    const stmt = list[idx];
    if (stmt?.kind === 'for') names.push(stmt.variable); // loop var is in scope in its body
    const child = stmt ? childList(stmt, path[i + 1] as ListKey) : null;
    if (!child) return [...new Set(names)];
    list = child;
  }
  collect(list, path[path.length - 1] as number);
  return [...new Set(names)];
}

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

export interface PaletteItem {
  id: string;
  label: string;
  /** Fresh statement for a new block of this kind. */
  make: (reg: Registry) => Stmt;
}

export interface PaletteGroup {
  name: string;
  items: PaletteItem[];
}

/**
 * The block palette derived from a host registry: core control blocks, a
 * Variables group, a State group (only when a state shape is declared), then
 * one group per callable `category`.
 */
export function paletteModel(reg: Registry): PaletteGroup[] {
  const groups: PaletteGroup[] = [
    {
      name: 'Control',
      items: [
        {
          id: 'if',
          label: 'if … else',
          make: () => ({
            kind: 'if',
            branches: [{ cond: boolLit(true), body: [] }],
            elseBody: null,
            loc: genLoc,
          }),
        },
        {
          id: 'for',
          label: 'for item of list',
          make: (r) => ({
            kind: 'for',
            variable: 'item',
            iterable: defaultExprFor({ kind: 'list', elem: { kind: 'int' } }, r)!,
            body: [],
            loc: genLoc,
          }),
        },
        { id: 'stop', label: 'stop', make: () => ({ kind: 'stop', loc: genLoc }) },
      ],
    },
    {
      name: 'Variables',
      items: [
        {
          id: 'let',
          label: 'let x = …',
          make: () => ({ kind: 'let', name: 'x', value: numLit(0), loc: genLoc }),
        },
        {
          id: 'assign',
          label: 'x = …',
          make: () => ({ kind: 'assign', name: 'x', value: numLit(0), loc: genLoc }),
        },
      ],
    },
  ];
  const stateFields = Object.keys(reg.stateShape);
  if (stateFields.length > 0) {
    groups.push({
      name: 'State',
      items: stateFields.map((f) => ({
        id: `state:${f}`,
        label: `state.${f} = …`,
        make: () => ({ kind: 'stateAssign', field: f, value: numLit(0), loc: genLoc }),
      })),
    });
  }
  const byCategory = new Map<string, PaletteItem[]>();
  for (const decl of reg.callables.values()) {
    const cat = decl.category ?? 'Actions';
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push({
      id: `call:${decl.name}`,
      label: `call ${decl.name}(…)`,
      make: (r) => ({ kind: 'call', name: decl.name, args: defaultCallArgs(decl, r), loc: genLoc }),
    });
  }
  for (const [name, items] of byCategory) groups.push({ name, items });
  return groups;
}
