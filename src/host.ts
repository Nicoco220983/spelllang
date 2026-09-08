/**
 * spelllang host API — the surface host projects code against.
 * See SPELLLANG.md §4 and DESIGN.md §7.
 */

import type {
  CallableDecl,
  ContextShape,
  ExecResult,
  Limits,
  Program,
  SpellError,
  StateShape,
  TypeDecl,
} from './ast.js';
import { DEFAULT_LIMITS, LANG_VERSION } from './ast.js';
import { parse, type ParseResult } from './parser.js';
import { validate, type Registry } from './validator.js';
import { run, type RunInputs } from './interpreter.js';

export interface SpellLangConfig {
  langVersion?: number;
  callables?: CallableDecl[];
  types?: Record<string, TypeDecl>;
  /** fixed shape of the persistent state record */
  stateShape?: StateShape;
  /** fixed shape of the per-invocation context */
  contextShape?: ContextShape;
  limits?: Partial<Limits>;
}

// ---------------------------------------------------------------------------
// Config validation — fail fast on malformed host input instead of producing
// cryptic validator errors or silently mis-registering entries.
// ---------------------------------------------------------------------------

function describeValue(v: unknown): string {
  if (typeof v === 'string') return `"${v}"`;
  if (Array.isArray(v)) return 'an array';
  if (typeof v === 'object' && v !== null) {
    const s = JSON.stringify(v);
    return s.length > 80 ? `${s.slice(0, 77)}...` : s;
  }
  return String(v);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const TYPE_KINDS = new Set([
  'int',
  'float',
  'bool',
  'string',
  'none',
  'vec',
  'enum',
  'list',
  'record',
  'optional',
]);

function checkType(value: unknown, path: string): void {
  if (!isPlainObject(value) || typeof value.kind !== 'string' || !TYPE_KINDS.has(value.kind)) {
    throw new Error(
      `${path} must be a Type object (e.g. tInt, tEnum('VoxelType'), tList(tInt)); ` +
        `got ${describeValue(value)}.`,
    );
  }
  if ((value.kind === 'enum' || value.kind === 'record') && typeof value.name !== 'string') {
    throw new Error(`${path}.name must be a string naming a declared type.`);
  }
  if (value.kind === 'list') checkType(value.elem, `${path}.elem`);
  if (value.kind === 'optional') checkType(value.inner, `${path}.inner`);
}

function checkTypeDecl(value: unknown, path: string): void {
  if (!isPlainObject(value)) {
    throw new Error(`${path} must be a type declaration; got ${describeValue(value)}.`);
  }
  if (value.kind === 'enum') {
    if (!Array.isArray(value.values) || !value.values.every((v) => typeof v === 'string')) {
      throw new Error(`${path}.values must be an array of strings.`);
    }
  } else if (value.kind === 'record') {
    if (!Array.isArray(value.fields)) {
      throw new Error(`${path}.fields must be an array of { name, type } entries.`);
    }
    value.fields.forEach((f, i) => {
      if (!isPlainObject(f) || typeof f.name !== 'string') {
        throw new Error(`${path}.fields[${i}] must have a string name.`);
      }
      checkType(f.type, `${path}.fields[${i}].type`);
    });
  } else {
    throw new Error(`${path}.kind must be 'enum' or 'record'; got ${describeValue(value.kind)}.`);
  }
}

function checkShape(value: unknown, path: string): void {
  if (!isPlainObject(value)) {
    throw new Error(`${path} must be a Record<string, Type>; got ${describeValue(value)}.`);
  }
  for (const [field, t] of Object.entries(value)) {
    checkType(t, `${path}.${field}`);
  }
}

function checkCallable(decl: unknown, index: number): void {
  const path = `callables[${index}]`;
  if (!isPlainObject(decl)) {
    throw new Error(`${path} must be a callable declaration; got ${describeValue(decl)}.`);
  }
  if (typeof decl.name !== 'string' || decl.name === '') {
    throw new Error(`${path}.name must be a non-empty string.`);
  }
  if (!Array.isArray(decl.args)) {
    throw new Error(`${path}.args must be an array of { name, type } entries.`);
  }
  decl.args.forEach((arg, j) => {
    if (!isPlainObject(arg) || typeof arg.name !== 'string') {
      throw new Error(`${path}.args[${j}] must have a string name.`);
    }
    checkType(arg.type, `${path}.args[${j}].type`);
  });
  checkType(decl.returnType, `${path}.returnType`);
  if (
    typeof decl.fuelCost !== 'number' ||
    !Number.isFinite(decl.fuelCost) ||
    decl.fuelCost < 0
  ) {
    throw new Error(`${path}.fuelCost must be a non-negative finite number.`);
  }
  if (typeof decl.doc !== 'string') {
    throw new Error(`${path}.doc must be a string.`);
  }
}

function checkConfig(config: SpellLangConfig): void {
  if (config.types !== undefined) {
    if (Array.isArray(config.types)) {
      throw new Error(
        "SpellLangConfig.types must be a Record<string, TypeDecl>, not an array. " +
          "Did you mean { VoxelType: { kind: 'enum', values: [...] } }?",
      );
    }
    for (const [name, decl] of Object.entries(config.types)) {
      checkTypeDecl(decl, `types.${name}`);
    }
  }
  if (config.callables !== undefined) {
    if (!Array.isArray(config.callables)) {
      throw new Error('SpellLangConfig.callables must be an array of CallableDecl.');
    }
    config.callables.forEach(checkCallable);
  }
  if (config.stateShape !== undefined) checkShape(config.stateShape, 'stateShape');
  if (config.contextShape !== undefined) checkShape(config.contextShape, 'contextShape');
  if (config.limits !== undefined) {
    if (!isPlainObject(config.limits)) {
      throw new Error('SpellLangConfig.limits must be a partial Limits object.');
    }
    for (const [key, v] of Object.entries(config.limits)) {
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
        throw new Error(`limits.${key} must be a non-negative finite number; got ${describeValue(v)}.`);
      }
    }
  }
}

export class SpellLang {
  readonly langVersion: number;
  private registry: Registry;

  constructor(config: SpellLangConfig = {}) {
    checkConfig(config);
    this.langVersion = config.langVersion ?? LANG_VERSION;
    if (this.langVersion !== LANG_VERSION) {
      throw new Error(
        `Unsupported langVersion ${this.langVersion} (this runtime supports ${LANG_VERSION}).`,
      );
    }
    this.registry = {
      callables: new Map((config.callables ?? []).map((c) => [c.name, c])),
      types: new Map(Object.entries(config.types ?? {})),
      stateShape: config.stateShape ?? {},
      contextShape: config.contextShape ?? {},
      limits: { ...DEFAULT_LIMITS, ...config.limits },
    };
  }

  registerCallable(decl: CallableDecl): void {
    this.registry.callables.set(decl.name, decl);
  }

  registerType(name: string, decl: TypeDecl): void {
    this.registry.types.set(name, decl);
  }

  /** Text → parse → fully validate. Errors are machine-readable. */
  parse(text: string): ParseResult & { errors: SpellError[] } {
    const result: ParseResult = parse(text);
    if (!result.ok || !result.program) {
      return { ok: false, errors: result.errors };
    }
    const errors = validate(result.program, this.registry);
    if (errors.length > 0) {
      return { ok: false, errors };
    }
    return { ok: true, program: result.program, errors: [] };
  }

  /** Validate an already-materialized AST (e.g. loaded from a spellbook). */
  validate(program: Program): SpellError[] {
    return validate(program, this.registry);
  }

  run(program: Program, inputs: RunInputs): ExecResult {
    return run(program, inputs, {
      callables: this.registry.callables,
      types: this.registry.types,
      limits: this.registry.limits,
    });
  }

  /** The callable registry, for prompt rendering. */
  get callables(): CallableDecl[] {
    return [...this.registry.callables.values()];
  }
}
