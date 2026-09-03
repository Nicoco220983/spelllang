/**
 * spelllang validator: static checks after parse, before execution.
 * Collects ALL errors (never stops at the first). Reclassifies bare
 * identifiers (var → stateField / contextField / enum) in place.
 * See DESIGN.md §4.
 */

import type {
  CallableDecl,
  Expr,
  Limits,
  Program,
  SpellError,
  Stmt,
  Type,
  TypeDecl,
} from './ast.js';
import {
  isAssignable,
  isNumeric,
  tBool,
  tFloat,
  tInt,
  tList,
  typeEquals,
} from './ast.js';
import { BUILTINS } from './builtins.js';

export interface Registry {
  callables: Map<string, CallableDecl>;
  types: Map<string, TypeDecl>;
  stateShape: Record<string, Type>;
  contextShape: Record<string, Type>;
  limits: Limits;
}

export function validate(program: Program, reg: Registry): SpellError[] {
  return new Validator(reg).validateProgram(program);
}

class Validator {
  errors: SpellError[] = [];
  /** scope stack; each map: name → declared type */
  private scopes: Map<string, Type>[] = [new Map()];

  constructor(private reg: Registry) {}

  // -- program & statements -------------------------------------------------

  validateProgram(program: Program): SpellError[] {
    if (program.langVersion !== 1) {
      this.errors.push({
        line: 1,
        col: 1,
        code: 'unsupported-version',
        message: `Unsupported langVersion ${program.langVersion} (this runtime supports 1).`,
        found: String(program.langVersion),
        expected: ['1'],
      });
    }
    for (const stmt of program.statements) this.checkStmt(stmt);
    return this.errors;
  }

  private checkStmt(stmt: Stmt): void {
    switch (stmt.kind) {
      case 'call':
        this.checkCall(stmt);
        return;
      case 'let': {
        const type = this.checkExpr(stmt.value);
        const scope = this.scopes[this.scopes.length - 1]!;
        if (scope.has(stmt.name)) {
          this.error(stmt.loc, 'duplicate-let', `Variable '${stmt.name}' is already declared in this block.`, undefined, stmt.name);
        }
        scope.set(stmt.name, type);
        return;
      }
      case 'assign': {
        const declared = this.lookupVar(stmt.name);
        if (!declared) {
          const known = this.knownNames();
          this.error(stmt.loc, 'unknown-identifier', `Unknown variable '${stmt.name}'. Declare it with 'let ${stmt.name} = ...' first.`, known, stmt.name);
          this.checkExpr(stmt.value);
          return;
        }
        const type = this.checkExpr(stmt.value);
        this.requireAssignable(stmt.loc, type, declared, `assignment to '${stmt.name}'`);
        return;
      }
      case 'stateAssign': {
        const declared = this.reg.stateShape[stmt.field];
        if (!declared) {
          this.error(stmt.loc, 'unknown-state-field', `Unknown state field 'state.${stmt.field}'. State fields are declared by the host.`, Object.keys(this.reg.stateShape), stmt.field);
          this.checkExpr(stmt.value);
          return;
        }
        const type = this.checkExpr(stmt.value);
        this.requireAssignable(stmt.loc, type, declared, `assignment to 'state.${stmt.field}'`);
        return;
      }
      case 'if': {
        for (const branch of stmt.branches) {
          const cond = this.checkExpr(branch.cond);
          this.requireBool(branch.cond.loc, cond, 'if condition');
          this.pushScope();
          for (const s of branch.body) this.checkStmt(s);
          this.popScope();
        }
        if (stmt.elseBody) {
          this.pushScope();
          for (const s of stmt.elseBody) this.checkStmt(s);
          this.popScope();
        }
        return;
      }
      case 'for': {
        const iterType = this.checkExpr(stmt.iterable);
        if (iterType.kind !== 'list') {
          this.error(stmt.iterable.loc, 'type-mismatch', `'for ... of' requires a list, found ${typeName(iterType)}.`, ['list'], typeName(iterType));
        }
        this.pushScope();
        this.scopes[this.scopes.length - 1]!.set(stmt.variable, iterType.kind === 'list' ? iterType.elem : tInt);
        for (const s of stmt.body) this.checkStmt(s);
        this.popScope();
        return;
      }
      case 'stop':
        return;
    }
  }

  private checkCall(stmt: Extract<Stmt, { kind: 'call' }>): void {
    const decl = this.reg.callables.get(stmt.name);
    if (!decl) {
      const hostCallables = [...this.reg.callables.keys()];
      const known = [...hostCallables, ...BUILTINS.map((b) => `${b.name}()`)];
      this.error(
        stmt.loc,
        'unknown-callable',
        `Unknown callable '${stmt.name}'.`,
        known,
        stmt.name,
      );
      for (const arg of stmt.args) this.checkExpr(arg);
      return;
    }
    this.checkArgs(stmt.loc, stmt.name, decl.args, decl, stmt.args);
  }

  private checkArgs(
    loc: { line: number; col: number },
    name: string,
    params: CallableDecl['args'],
    _decl: CallableDecl,
    args: Expr[],
  ): void {
    const required = params.filter((p) => !p.optional).length;
    if (args.length < required || args.length > params.length) {
      this.error(
        loc,
        'arity-mismatch',
        `Callable '${name}' expects ${required === params.length ? `${required}` : `${required}–${params.length}`} argument(s), got ${args.length}.`,
        params.map((p) => p.name),
        String(args.length),
      );
    }
    args.forEach((arg, i) => {
      const param = params[i];
      if (!param) {
        this.checkExpr(arg); // still type the extra arg for cascading checks
        return;
      }
      const argType = this.checkExpr(arg);
      const ok =
        param.type.kind === 'vec'
          ? this.isVecAssignable(argType)
          : isAssignable(argType, param.type);
      if (!ok) {
        this.error(
          arg.loc,
          'type-mismatch',
          `Argument '${param.name}' of '${name}' expects ${typeName(param.type)}, found ${typeName(argType)}.`,
          [typeName(param.type)],
          typeName(argType),
        );
      }
      this.checkDomain(arg, param, name);
    });
  }

  /** A value satisfies `vec` if it is a record with numeric x, y, z fields. */
  private isVecAssignable(t: Type): boolean {
    if (t.kind !== 'record') return false;
    const decl = this.reg.types.get(t.name);
    if (!decl || decl.kind !== 'record') return false;
    for (const axis of ['x', 'y', 'z']) {
      const f = decl.fields.find((fd) => fd.name === axis);
      if (!f || !isNumeric(f.type)) return false;
    }
    return true;
  }

  /** Value-domain checks (enums, ranges) for statically-known argument values. */
  private checkDomain(arg: Expr, param: CallableDecl['args'][number], callableName: string): void {
    const d = param.domain;
    if (!d) return;
    if (d.enumValues && (arg.kind === 'enum' || arg.kind === 'str')) {
      const v = arg.kind === 'enum' ? arg.name : arg.value;
      if (!d.enumValues.includes(v)) {
        this.error(arg.loc, 'enum-out-of-domain', `Value '${v}' is not allowed for '${param.name}' of '${callableName}'.`, d.enumValues, v);
      }
    }
    if ((d.min !== undefined || d.max !== undefined) && arg.kind === 'num') {
      if (d.min !== undefined && arg.value < d.min) {
        this.error(arg.loc, 'out-of-range', `Value ${arg.value} is below the minimum ${d.min} for '${param.name}' of '${callableName}'.`, [`>= ${d.min}`], String(arg.value));
      }
      if (d.max !== undefined && arg.value > d.max) {
        this.error(arg.loc, 'out-of-range', `Value ${arg.value} is above the maximum ${d.max} for '${param.name}' of '${callableName}'.`, [`<= ${d.max}`], String(arg.value));
      }
    }
  }

  // -- expressions ----------------------------------------------------------

  private checkExpr(expr: Expr): Type {
    switch (expr.kind) {
      case 'num':
        return expr.isInt ? tInt : tFloat;
      case 'str':
        return { kind: 'string' };
      case 'bool':
        return tBool;
      case 'enum': {
        const decl = this.reg.types.get(expr.name);
        if (!decl || decl.kind !== 'enum') {
          this.error(expr.loc, 'unknown-enum', `Unknown enum value '${expr.name}'.`, [...this.reg.types.keys()], expr.name);
        }
        return { kind: 'enum', name: expr.name };
      }
      case 'list': {
        if (expr.elements.length > this.reg.limits.maxListLength) {
          this.error(expr.loc, 'list-too-large', `List literal has ${expr.elements.length} elements (max ${this.reg.limits.maxListLength}).`, [String(this.reg.limits.maxListLength)], String(expr.elements.length));
        }
        let elemType: Type | null = null;
        for (const el of expr.elements) {
          const t = this.checkExpr(el);
          if (!elemType) {
            elemType = t;
          } else if (!typeEquals(elemType, t)) {
            this.error(el.loc, 'type-mismatch', `List elements must all have the same type; found ${typeName(elemType)} and ${typeName(t)}.`, [typeName(elemType)], typeName(t));
          }
        }
        return tList(elemType ?? tInt);
      }
      case 'var':
        return this.resolveVar(expr);
      case 'stateField': {
        const t = this.reg.stateShape[expr.field];
        if (!t) {
          this.error(expr.loc, 'unknown-state-field', `Unknown state field 'state.${expr.field}'. State fields are declared by the host.`, Object.keys(this.reg.stateShape), expr.field);
          return tInt;
        }
        return t;
      }
      case 'contextField': {
        const t = this.reg.contextShape[expr.field];
        if (!t) {
          this.error(expr.loc, 'unknown-context-field', `Unknown context value '${expr.field}'. Context fields are declared by the host.`, Object.keys(this.reg.contextShape), expr.field);
          return tInt;
        }
        return t;
      }
      case 'member':
        return this.checkMember(expr);
      case 'unary': {
        const t = this.checkExpr(expr.operand);
        if (expr.op === 'not') {
          this.requireBool(expr.operand.loc, t, 'operand of not');
          return tBool;
        }
        if (!isNumeric(t)) {
          this.error(expr.operand.loc, 'type-mismatch', `Unary '-' expects a number, found ${typeName(t)}.`, ['number'], typeName(t));
          return tInt;
        }
        return t;
      }
      case 'binary':
        return this.checkBinary(expr);
      case 'callBuiltin': {
        const decl = BUILTINS.find((b) => b.name === expr.name)!;
        this.checkArgs(expr.loc, expr.name, decl.args, decl, expr.args);
        return decl.returnType;
      }
    }
  }

  /**
   * Reclassify a bare identifier: variable → state field → context field →
   * enum → error. Mutates the node in place.
   */
  private resolveVar(expr: Extract<Expr, { kind: 'var' }>): Type {
    const local = this.lookupVar(expr.name);
    if (local) return local;
    if (expr.name in this.reg.stateShape) {
      const field = expr.name;
      Object.assign(expr, { kind: 'stateField', field });
      return this.reg.stateShape[field]!;
    }
    if (expr.name in this.reg.contextShape) {
      const field = expr.name;
      Object.assign(expr, { kind: 'contextField', field });
      return this.reg.contextShape[field]!;
    }
    const enumType = this.findEnumType(expr.name);
    if (enumType) {
      const value = expr.name;
      Object.assign(expr, { kind: 'enum', name: value });
      return { kind: 'enum', name: enumType };
    }
    this.error(expr.loc, 'unknown-identifier', `Unknown identifier '${expr.name}'.`, this.knownNames(), expr.name);
    return tInt;
  }

  /** Find the enum *type* that declares the given value, if any. */
  private findEnumType(value: string): string | null {
    for (const [typeName, decl] of this.reg.types) {
      if (decl.kind === 'enum' && decl.values.includes(value)) return typeName;
    }
    return null;
  }

  private checkMember(expr: Extract<Expr, { kind: 'member' }>): Type {
    const objType = this.checkExpr(expr.object);
    if (objType.kind === 'record') {
      const decl = this.reg.types.get(objType.name);
      if (decl && decl.kind === 'record') {
        const field = decl.fields.find((f) => f.name === expr.field);
        if (field) return field.type;
        this.error(expr.loc, 'unknown-field', `Record '${objType.name}' has no field '${expr.field}'.`, decl.fields.map((f) => f.name), expr.field);
        return tInt;
      }
      this.error(expr.loc, 'unknown-type', `Unknown record type '${objType.name}'.`, [...this.reg.types.keys()], objType.name);
      return tInt;
    }
    if (objType.kind === 'list') {
      this.error(expr.loc, 'type-mismatch', `Lists have no fields; use 'for x of <list>' to iterate.`, [], expr.field);
      return tInt;
    }
    this.error(expr.loc, 'type-mismatch', `Cannot access field '${expr.field}' on ${typeName(objType)}.`, [], expr.field);
    return tInt;
  }

  private checkBinary(expr: Extract<Expr, { kind: 'binary' }>): Type {
    const l = this.checkExpr(expr.left);
    const r = this.checkExpr(expr.right);
    const op = expr.op;
    if (op === 'and' || op === 'or') {
      this.requireBool(expr.left.loc, l, `left operand of '${op}'`);
      this.requireBool(expr.right.loc, r, `right operand of '${op}'`);
      return tBool;
    }
    if (op === '+' || op === '-' || op === '*' || op === '/' || op === '%') {
      if (!isNumeric(l) || !isNumeric(r)) {
        this.error(expr.loc, 'type-mismatch', `Operator '${op}' expects numbers, found ${typeName(l)} and ${typeName(r)}.`, ['number'], `${typeName(l)}, ${typeName(r)}`);
        return tInt;
      }
      if (op === '%' && (l.kind !== 'int' || r.kind !== 'int')) {
        this.error(expr.loc, 'type-mismatch', `Operator '%' requires int operands, found ${typeName(l)} and ${typeName(r)}.`, ['int'], `${typeName(l)}, ${typeName(r)}`);
      }
      if (op === '/') return tFloat;
      if (l.kind === 'int' && r.kind === 'int') return tInt;
      return tFloat;
    }
    // comparisons
    if (op === '<' || op === '<=' || op === '>' || op === '>=') {
      if (!isNumeric(l) || !isNumeric(r)) {
        this.error(expr.loc, 'type-mismatch', `Operator '${op}' expects numbers, found ${typeName(l)} and ${typeName(r)}.`, ['number'], `${typeName(l)}, ${typeName(r)}`);
      }
      return tBool;
    }
    // == / !=
    if (isNumeric(l) && isNumeric(r)) return tBool;
    if (typeEquals(l, r)) return tBool;
    this.error(expr.loc, 'type-mismatch', `Cannot compare ${typeName(l)} with ${typeName(r)} using '${op}'.`, [typeName(l)], typeName(r));
    return tBool;
  }

  // -- helpers --------------------------------------------------------------

  private lookupVar(name: string): Type | null {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const t = this.scopes[i]!.get(name);
      if (t) return t;
    }
    return null;
  }

  private knownNames(): string[] {
    const names = new Set<string>();
    for (const scope of this.scopes) for (const k of scope.keys()) names.add(k);
    for (const k of Object.keys(this.reg.stateShape)) names.add(k);
    for (const k of Object.keys(this.reg.contextShape)) names.add(k);
    for (const t of this.reg.types.values()) if (t.kind === 'enum') for (const v of t.values) names.add(v);
    return [...names];
  }

  private pushScope(): void {
    this.scopes.push(new Map());
  }

  private popScope(): void {
    this.scopes.pop();
  }

  private requireBool(loc: { line: number; col: number }, t: Type, what: string): void {
    if (t.kind !== 'bool') {
      this.error(loc, 'type-mismatch', `${what} must be a bool, found ${typeName(t)}.`, ['bool'], typeName(t));
    }
  }

  private requireAssignable(loc: { line: number; col: number }, from: Type, to: Type, what: string): void {
    if (!isAssignable(from, to)) {
      this.error(loc, 'type-mismatch', `Cannot assign ${typeName(from)} to ${what} (${typeName(to)}).`, [typeName(to)], typeName(from));
    }
  }

  private error(loc: { line: number; col: number }, code: string, message: string, expected?: string[], found?: string): void {
    this.errors.push({ line: loc.line, col: loc.col, code, message, expected, found });
  }
}

export function typeName(t: Type): string {
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
      return 'vec';
    case 'enum':
      return t.name;
    case 'list':
      return `list<${typeName(t.elem)}>`;
    case 'record':
      return t.name;
    case 'optional':
      return `${typeName(t.inner)} | none`;
  }
}
