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

export class SpellLang {
  readonly langVersion: number;
  private registry: Registry;

  constructor(config: SpellLangConfig = {}) {
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
      limits: this.registry.limits,
    });
  }

  /** The callable registry, for prompt rendering. */
  get callables(): CallableDecl[] {
    return [...this.registry.callables.values()];
  }
}
