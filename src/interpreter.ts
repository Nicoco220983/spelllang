/**
 * spelllang interpreter: fuel-bounded, deterministic, side-effect-free
 * except through declared callables and intents. Execution never suspends:
 * a run completes or is preempted at a node boundary by fuel exhaustion.
 * See DESIGN.md §6.
 */

import type {
  CallableDecl,
  ExecResult,
  Expr,
  Intent,
  Limits,
  Program,
  Stmt,
  Value,
} from './ast.js';
import { BUILTINS } from './builtins.js';

export interface RunInputs {
  /** host-managed per-script state (deep-copied in; updated copy out) */
  state?: Record<string, Value>;
  /** per-invocation data (deep-copied in; read-only during the run) */
  context?: Record<string, Value>;
  /** random seed; default 0 */
  seed?: number;
  /** host implementations, injected per run */
  callablesImpl: Record<
    string,
    (args: Value[], helpers: { emit: (intent: Intent) => void }) => Value | void
  >;
}

export interface RunConfig {
  callables: Map<string, CallableDecl>;
  limits: Limits;
}

class OutOfFuel extends Error {}
class StopProgram extends Error {}
class RuntimeFailure extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/** mulberry32 — small, fast, deterministic PRNG. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function run(program: Program, inputs: RunInputs, config: RunConfig): ExecResult {
  const interp = new Interpreter(inputs, config);
  return interp.runProgram(program);
}

class Interpreter {
  private fuel: number;
  private fuelUsed = 0;
  private rng: () => number;
  private scopes: Map<string, Value>[] = [new Map()];
  private state: Record<string, Value>;
  private readonly context: Record<string, Value>;
  private intents: Intent[] = [];
  private depth = 0;

  constructor(
    private inputs: RunInputs,
    private config: RunConfig,
  ) {
    this.fuel = config.limits.fuel;
    this.rng = mulberry32(inputs.seed ?? 0);
    this.state = deepCopy(inputs.state ?? {});
    this.context = deepCopy(inputs.context ?? {});
  }

  runProgram(program: Program): ExecResult {
    let result: ExecResult['result'] = 'ok';
    let error: { code: string; message: string } | undefined;
    try {
      for (const stmt of program.statements) {
        this.execStmt(stmt);
      }
    } catch (e) {
      if (e instanceof OutOfFuel) {
        result = 'out-of-fuel';
      } else if (e instanceof StopProgram) {
        result = 'ok';
      } else if (e instanceof RuntimeFailure) {
        result = e.code === 'invalid-call' ? 'invalid-call' : 'runtime-error';
        error = { code: e.code, message: e.message };
      } else {
        throw e;
      }
    }
    return {
      result,
      intents: this.intents,
      state: deepCopy(this.state),
      fuelUsed: this.fuelUsed,
      error,
    };
  }

  // -- fuel -----------------------------------------------------------------

  private burn(loc: { line: number; col: number }, amount = 1): void {
    this.fuel -= amount;
    this.fuelUsed += amount;
    if (this.fuel < 0) {
      throw new OutOfFuel(`out of fuel at ${loc.line}:${loc.col}`);
    }
  }

  // -- statements -----------------------------------------------------------

  private execStmt(stmt: Stmt): void {
    this.burn(stmt.loc);
    switch (stmt.kind) {
      case 'call':
        this.execCall(stmt);
        return;
      case 'let':
        this.scopes[this.scopes.length - 1]!.set(stmt.name, this.evalExpr(stmt.value));
        return;
      case 'assign':
        this.assignVar(stmt.name, this.evalExpr(stmt.value));
        return;
      case 'stateAssign':
        this.state[stmt.field] = this.evalExpr(stmt.value);
        return;
      case 'if': {
        for (const branch of stmt.branches) {
          if (this.evalExpr(branch.cond)) {
            this.execBlock(branch.body);
            return;
          }
        }
        if (stmt.elseBody) this.execBlock(stmt.elseBody);
        return;
      }
      case 'for': {
        const iterable = this.evalExpr(stmt.iterable);
        if (!Array.isArray(iterable)) {
          throw new RuntimeFailure('runtime-error', `'for ... of' requires a list (validator missed this).`);
        }
        for (const item of iterable) {
          this.scopes.push(new Map([[stmt.variable, item]]));
          try {
            this.execBlock(stmt.body);
          } finally {
            this.scopes.pop();
          }
        }
        return;
      }
      case 'stop':
        throw new StopProgram();
    }
  }

  private execBlock(stmts: Stmt[]): void {
    for (const s of stmts) this.execStmt(s);
  }

  private execCall(stmt: Extract<Stmt, { kind: 'call' }>): void {
    const decl = this.config.callables.get(stmt.name);
    const impl = this.inputs.callablesImpl[stmt.name];
    if (!decl || !impl) {
      throw new RuntimeFailure('invalid-call', `No implementation provided for callable '${stmt.name}'.`);
    }
    const args = stmt.args.map((a) => this.evalExpr(a));
    this.callHost(decl, impl, args, stmt.loc);
  }

  private callHost(
    decl: CallableDecl,
    impl: RunInputs['callablesImpl'][string],
    args: Value[],
    loc: { line: number; col: number },
  ): void {
    if (this.depth >= this.config.limits.callDepth) {
      throw new RuntimeFailure('runtime-error', `Call depth limit (${this.config.limits.callDepth}) exceeded.`);
    }
    this.burn(loc, decl.fuelCost);
    this.depth++;
    let returned: Value | void;
    try {
      returned = impl(args, {
        emit: (intent) => {
          if (this.intents.length >= this.config.limits.maxResults) {
            throw new RuntimeFailure('too-many-results', `Intent limit (${this.config.limits.maxResults}) exceeded.`);
          }
          this.intents.push(deepCopy(intent));
        },
      });
    } catch (e) {
      if (e instanceof RuntimeFailure) throw e;
      // a crash inside host code is a host bug, not a script fault
      throw new RuntimeFailure(
        'invalid-call',
        `Implementation of '${decl.name}' threw: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      this.depth--;
    }
    const value: Value = returned === undefined ? null : returned;
    this.checkReturnShape(decl, value);
  }

  /** Host contract: returned value must match the declared return type. */
  private checkReturnShape(decl: CallableDecl, value: Value): void {
    const ok = shapeMatches(decl.returnType, value);
    if (!ok) {
      throw new RuntimeFailure(
        'invalid-call',
        `Implementation of '${decl.name}' returned a value not matching '${decl.returnType.kind}'.`,
      );
    }
  }

  private assignVar(name: string, value: Value): void {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      if (this.scopes[i]!.has(name)) {
        this.scopes[i]!.set(name, value);
        return;
      }
    }
    throw new RuntimeFailure('runtime-error', `Unknown variable '${name}' (validator missed this).`);
  }

  // -- expressions ----------------------------------------------------------

  private evalExpr(expr: Expr): Value {
    this.burn(expr.loc);
    switch (expr.kind) {
      case 'num':
      case 'str':
      case 'bool':
        return expr.value;
      case 'enum':
        return expr.name;
      case 'list':
        return expr.elements.map((e) => this.evalExpr(e));
      case 'var': {
        for (let i = this.scopes.length - 1; i >= 0; i--) {
          if (this.scopes[i]!.has(expr.name)) return this.scopes[i]!.get(expr.name)!;
        }
        throw new RuntimeFailure('runtime-error', `Unknown variable '${expr.name}' (validator missed this).`);
      }
      case 'stateField':
        return this.state[expr.field] ?? null;
      case 'contextField':
        return this.context[expr.field] ?? null;
      case 'member': {
        const obj = this.evalExpr(expr.object);
        if (obj !== null && typeof obj === 'object' && !Array.isArray(obj)) {
          return (obj as Record<string, Value>)[expr.field] ?? null;
        }
        throw new RuntimeFailure('runtime-error', `Cannot access field '${expr.field}' on a non-object.`);
      }
      case 'unary': {
        const v = this.evalExpr(expr.operand);
        if (expr.op === 'not') return !v;
        return -this.asNumber(v);
      }
      case 'binary':
        return this.evalBinary(expr);
      case 'callBuiltin':
        return this.evalBuiltin(expr);
    }
  }

  private evalBinary(expr: Extract<Expr, { kind: 'binary' }>): Value {
    // short-circuit operators evaluate lazily
    if (expr.op === 'and') {
      return Boolean(this.evalExpr(expr.left)) && Boolean(this.evalExpr(expr.right));
    }
    if (expr.op === 'or') {
      return Boolean(this.evalExpr(expr.left)) || Boolean(this.evalExpr(expr.right));
    }
    const l = this.evalExpr(expr.left);
    const r = this.evalExpr(expr.right);
    switch (expr.op) {
      case '+':
        return this.asNumber(l) + this.asNumber(r);
      case '-':
        return this.asNumber(l) - this.asNumber(r);
      case '*':
        return this.asNumber(l) * this.asNumber(r);
      case '/': {
        const d = this.asNumber(r);
        if (d === 0) throw new RuntimeFailure('division-by-zero', 'Division by zero.');
        return this.asNumber(l) / d;
      }
      case '%': {
        const d = this.asNumber(r);
        if (d === 0) throw new RuntimeFailure('division-by-zero', 'Modulo by zero.');
        return this.asNumber(l) % d;
      }
      case '<':
        return this.asNumber(l) < this.asNumber(r);
      case '<=':
        return this.asNumber(l) <= this.asNumber(r);
      case '>':
        return this.asNumber(l) > this.asNumber(r);
      case '>=':
        return this.asNumber(l) >= this.asNumber(r);
      case '==':
        return valuesEqual(l, r);
      case '!=':
        return !valuesEqual(l, r);
      default:
        throw new RuntimeFailure('runtime-error', `Unknown operator '${expr.op}'.`);
    }
  }

  private evalBuiltin(expr: Extract<Expr, { kind: 'callBuiltin' }>): Value {
    const decl = BUILTINS.find((b) => b.name === expr.name)!;
    const args = expr.args.map((a) => this.evalExpr(a));
    this.burn(expr.loc, decl.fuelCost);
    switch (expr.name) {
      case 'min':
        return Math.min(this.asNumber(args[0]!), this.asNumber(args[1]!));
      case 'max':
        return Math.max(this.asNumber(args[0]!), this.asNumber(args[1]!));
      case 'abs':
        return Math.abs(this.asNumber(args[0]!));
      case 'floor':
        return Math.floor(this.asNumber(args[0]!));
      case 'ceil':
        return Math.ceil(this.asNumber(args[0]!));
      case 'round': {
        const x = this.asNumber(args[0]!);
        return x < 0 ? -Math.round(-x) : Math.round(x); // ties away from zero
      }
      case 'distance': {
        const a = args[0]! as Record<string, Value>;
        const b = args[1]! as Record<string, Value>;
        const dx = this.asNumber(a['x']!) - this.asNumber(b['x']!);
        const dy = this.asNumber(a['y']!) - this.asNumber(b['y']!);
        const dz = this.asNumber(a['z']!) - this.asNumber(b['z']!);
        return Math.sqrt(dx * dx + dy * dy + dz * dz);
      }
      case 'random':
        return this.rng();
      case 'range': {
        const start = this.asNumber(args[0]!);
        const end = this.asNumber(args[1]!);
        const len = Math.abs(end - start);
        if (len > this.config.limits.maxListLength) {
          throw new RuntimeFailure('list-too-large', `range(${start}, ${end}) has ${len} elements (max ${this.config.limits.maxListLength}).`);
        }
        const out: number[] = [];
        if (start <= end) {
          for (let i = start; i < end; i++) out.push(i);
        } else {
          for (let i = start; i > end; i--) out.push(i);
        }
        return out;
      }
      default:
        throw new RuntimeFailure('runtime-error', `Unknown builtin '${expr.name}'.`);
    }
  }

  private asNumber(v: Value): number {
    if (typeof v !== 'number') {
      throw new RuntimeFailure('runtime-error', `Expected a number, found ${typeof v} (validator missed this).`);
    }
    return v;
  }
}

// ---------------------------------------------------------------------------
// Value helpers
// ---------------------------------------------------------------------------

function deepCopy<T>(v: T): T {
  return structuredClone(v);
}

function valuesEqual(a: Value, b: Value): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => valuesEqual(v, b[i]!));
  }
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => valuesEqual(a[k]!, b[k]!));
  }
  return false;
}

function isObject(v: Value): v is Record<string, Value> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Runtime shape check for host-returned values (loose, structural). */
function shapeMatches(type: CallableDecl['returnType'], value: Value): boolean {
  switch (type.kind) {
    case 'none':
      return value === null || value === undefined;
    case 'int':
    case 'float':
      return typeof value === 'number';
    case 'bool':
      return typeof value === 'boolean';
    case 'string':
      return typeof value === 'string';
    case 'enum':
      return typeof value === 'string';
    case 'list':
      return Array.isArray(value);
    case 'record':
      return isObject(value);
    case 'optional':
      return value === null || shapeMatches(type.inner, value);
    case 'vec':
      return isObject(value);
  }
}
