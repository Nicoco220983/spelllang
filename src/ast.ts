/**
 * spelllang — AST node types, static type descriptors, and host registry
 * shapes. See DESIGN.md. The AST is plain JSON (every node carries `loc`).
 */

export const LANG_VERSION = 1;

// ---------------------------------------------------------------------------
// Source locations & errors
// ---------------------------------------------------------------------------

export interface Loc {
  /** 1-based */
  line: number;
  /** 1-based */
  col: number;
}

export interface SpellError {
  line: number;
  col: number;
  /** stable snake_case code, e.g. 'unknown-callable' */
  code: string;
  message: string;
  /** candidate fixes / expected tokens, when known */
  expected?: string[];
  found?: string;
}

// ---------------------------------------------------------------------------
// Static type descriptors
// ---------------------------------------------------------------------------

export type Type =
  | { kind: 'int' }
  | { kind: 'float' }
  | { kind: 'bool' }
  | { kind: 'string' }
  | { kind: 'none' }
  /** any record value with numeric x, y, z fields (builtin `distance` only) */
  | { kind: 'vec' }
  | { kind: 'enum'; name: string }
  | { kind: 'list'; elem: Type }
  | { kind: 'record'; name: string }
  /** `T | none` — for callable returns/args and optional fields */
  | { kind: 'optional'; inner: Type };

export const tInt: Type = { kind: 'int' };
export const tFloat: Type = { kind: 'float' };
export const tBool: Type = { kind: 'bool' };
export const tString: Type = { kind: 'string' };
export const tNone: Type = { kind: 'none' };
export const tEnum = (name: string): Type => ({ kind: 'enum', name });
export const tList = (elem: Type): Type => ({ kind: 'list', elem });
export const tRecord = (name: string): Type => ({ kind: 'record', name });
export const tOptional = (inner: Type): Type => ({ kind: 'optional', inner });

/** Structural equality on types (enum/record compared by name). */
export function typeEquals(a: Type, b: Type): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'enum':
      return (b as { name: string }).name === a.name;
    case 'record':
      return (b as { name: string }).name === a.name;
    case 'list':
      return typeEquals(a.elem, (b as { elem: Type }).elem);
    case 'optional':
      return typeEquals(a.inner, (b as { inner: Type }).inner);
    default:
      return true;
  }
}

/**
 * Numeric compatibility: int is assignable to float, and numeric equality /
 * comparison may mix int and float.
 */
export function isNumeric(t: Type): boolean {
  return t.kind === 'int' || t.kind === 'float';
}

/** True if a value of type `from` may be used where `to` is expected. */
export function isAssignable(from: Type, to: Type): boolean {
  if (typeEquals(from, to)) return true;
  if (from.kind === 'int' && to.kind === 'float') return true;
  if (to.kind === 'optional') return isAssignable(from, to.inner);
  return false;
}

// ---------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------

export type Stmt =
  | { kind: 'call'; name: string; args: Expr[]; loc: Loc }
  | { kind: 'let'; name: string; value: Expr; loc: Loc }
  | { kind: 'assign'; name: string; value: Expr; loc: Loc }
  | { kind: 'stateAssign'; field: string; value: Expr; loc: Loc }
  | {
      kind: 'if';
      branches: { cond: Expr; body: Stmt[] }[];
      elseBody: Stmt[] | null;
      loc: Loc;
    }
  | { kind: 'for'; variable: string; iterable: Expr; body: Stmt[]; loc: Loc }
  | { kind: 'stop'; loc: Loc };

export type Expr =
  | { kind: 'num'; value: number; isInt: boolean; loc: Loc }
  | { kind: 'str'; value: string; loc: Loc }
  | { kind: 'bool'; value: boolean; loc: Loc }
  | { kind: 'enum'; name: string; loc: Loc }
  | { kind: 'list'; elements: Expr[]; loc: Loc }
  /** construct a host-declared record: `TypeName { field: expr, ... }` */
  | {
      kind: 'recordLit';
      typeName: string;
      fields: { name: string; value: Expr; loc: Loc }[];
      loc: Loc;
    }
  | { kind: 'var'; name: string; loc: Loc }
  | { kind: 'stateField'; field: string; loc: Loc }
  | { kind: 'contextField'; field: string; loc: Loc }
  | { kind: 'member'; object: Expr; field: string; loc: Loc }
  | { kind: 'binary'; op: string; left: Expr; right: Expr; loc: Loc }
  | { kind: 'unary'; op: '-' | 'not'; operand: Expr; loc: Loc }
  | { kind: 'callBuiltin'; name: string; args: Expr[]; loc: Loc };

export interface Program {
  langVersion: number;
  statements: Stmt[];
}

export function program(statements: Stmt[]): Program {
  return { langVersion: LANG_VERSION, statements };
}

// ---------------------------------------------------------------------------
// Host registry shapes (declarations only — no implementations)
// ---------------------------------------------------------------------------

export interface ValueDomain {
  /** allowed values for enum-typed args */
  enumValues?: string[];
  /** inclusive numeric range */
  min?: number;
  max?: number;
}

export interface ArgDecl {
  name: string;
  type: Type;
  optional?: boolean;
  domain?: ValueDomain;
  doc?: string;
}

export interface CallableDecl {
  name: string;
  args: ArgDecl[];
  returnType: Type;
  fuelCost: number;
  doc: string;
  /** block-palette grouping, e.g. 'world' */
  category?: string;
}

export interface RecordDecl {
  kind: 'record';
  fields: { name: string; type: Type }[];
}

export interface EnumDecl {
  kind: 'enum';
  values: string[];
}

/** Host data types: named records and enums. */
export type TypeDecl = RecordDecl | EnumDecl;

export interface Limits {
  fuel: number;
  callDepth: number;
  stateSlots: number;
  maxResults: number;
  maxListLength: number;
}

export const DEFAULT_LIMITS: Limits = {
  fuel: 10_000,
  callDepth: 8,
  stateSlots: 16,
  maxResults: 512,
  maxListLength: 4096,
};

/** Per-script persistent state shape (host-declared, fixed). */
export type StateShape = Record<string, Type>;

/** Per-invocation context shape (host-declared, fixed). */
export type ContextShape = Record<string, Type>;

// ---------------------------------------------------------------------------
// Runtime values (cross the host API boundary as deep copies)
// ---------------------------------------------------------------------------

export type Value =
  | number
  | string
  | boolean
  | null
  | Value[]
  | { [field: string]: Value };

export type Intent = Value;

export type RunResultKind =
  | 'ok'
  | 'out-of-fuel'
  | 'runtime-error'
  | 'invalid-call';

export interface ExecResult {
  result: RunResultKind;
  intents: Intent[];
  /** updated state record; the host decides whether to keep it */
  state: Record<string, Value>;
  fuelUsed: number;
  error?: { code: string; message: string };
}
