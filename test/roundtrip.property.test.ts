import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { parse } from '../src/parser.js';
import { printExpr, printProgram } from '../src/printer.js';
import type { Expr, Program, Stmt } from '../src/ast.js';
import { LANG_VERSION } from '../src/ast.js';
import { BUILTINS } from '../src/builtins.js';

/**
 * Round-trip property (SPELLLANG.md §8): for any well-formed AST,
 * print → parse → print is stable, and parse(print(ast)) reproduces the
 * same AST (modulo loc, which is determined by the printed text anyway).
 */

const loc = { line: 1, col: 1 };

/** Keywords are reserved: the text surface can never express `state.if` etc.,
 * so reachable ASTs never use them as names (mirrors parser.ts RESERVED). */
const RESERVED = new Set([
  'call', 'let', 'if', 'else', 'for', 'of', 'stop', 'state',
  'and', 'or', 'not', 'true', 'false',
]);

const identGen = fc.stringMatching(/^[a-z_][a-z0-9_]*$/).filter((s) => !RESERVED.has(s));

const numGen = fc.oneof(
  fc.integer({ min: 0, max: 100000 }),
  fc
    .float({ min: 0, max: 100000, noNaN: true, noDefaultInfinity: true })
    .filter((v) => Number.isFinite(v) && v >= 0.0001),
  // ^ subnormal/tiny floats print in exponent notation, which the lexer
  // intentionally does not support (scripts never need them)
);

const builtinNameGen = fc.constantFrom(...BUILTINS.map((b) => b.name));

const strGen = fc.string({ minLength: 0, maxLength: 10 }).filter((s) => !/["\\\n\t]/.test(s));

const exprGen: fc.Arbitrary<Expr> = fc.letrec((tie) => ({
  expr: fc.oneof(
    { maxDepth: 4 },
    numGen.map((v) => ({
      kind: 'num',
      value: v,
      isInt: Number.isInteger(v),
      loc,
    })) as fc.Arbitrary<Expr>,
    strGen.map((v) => ({ kind: 'str', value: v, loc }) as Expr),
    fc.boolean().map((v) => ({ kind: 'bool', value: v, loc }) as Expr),
    identGen.map((v) => ({ kind: 'var', name: v, loc }) as Expr),
    identGen.map((v) => ({ kind: 'stateField', field: v, loc }) as Expr),
    fc
      .array(tie('expr') as fc.Arbitrary<Expr>, { minLength: 0, maxLength: 3 })
      .map((elements) => ({ kind: 'list', elements, loc }) as Expr),
    fc
      .tuple(tie('expr') as fc.Arbitrary<Expr>, fc.constantFrom('+', '-', '*', '/', '%', '==', '!=', '<', '<=', '>', '>=', 'and', 'or'))
      .map(([left, op]) => ({ kind: 'binary', op, left, right: { kind: 'num', value: 1, isInt: true, loc }, loc }) as Expr),
    fc
      .tuple(fc.constantFrom('-', 'not'), tie('expr') as fc.Arbitrary<Expr>)
      .map(([op, operand]) => ({ kind: 'unary', op, operand, loc }) as Expr),
    fc
      .tuple(tie('expr') as fc.Arbitrary<Expr>, identGen)
      .map(([object, field]) => ({ kind: 'member', object, field, loc }) as Expr),
    fc
      .tuple(builtinNameGen, fc.array(tie('expr') as fc.Arbitrary<Expr>, { minLength: 0, maxLength: 2 }))
      .map(([name, args]) => ({ kind: 'callBuiltin', name, args, loc }) as Expr),
  ),
  stmt: fc.oneof(
    { maxDepth: 3 },
    fc
      .tuple(identGen, fc.array(tie('expr') as fc.Arbitrary<Expr>, { minLength: 0, maxLength: 3 }))
      .map(([name, args]) => ({ kind: 'call', name, args, loc }) as Stmt),
    fc
      .tuple(identGen, tie('expr') as fc.Arbitrary<Expr>)
      .map(([name, value]) => ({ kind: 'let', name, value, loc }) as Stmt),
    fc
      .tuple(identGen, tie('expr') as fc.Arbitrary<Expr>)
      .map(([name, value]) => ({ kind: 'assign', name, value, loc }) as Stmt),
    fc
      .tuple(identGen, tie('expr') as fc.Arbitrary<Expr>)
      .map(([field, value]) => ({ kind: 'stateAssign', field, value, loc }) as Stmt),
    fc.constant({ kind: 'stop', loc }) as fc.Arbitrary<Stmt>,
    fc
      .tuple(
        tie('expr') as fc.Arbitrary<Expr>,
        fc.array(tie('stmt') as fc.Arbitrary<Stmt>, { minLength: 0, maxLength: 2 }),
        fc.array(tie('stmt') as fc.Arbitrary<Stmt>, { minLength: 0, maxLength: 2 }),
      )
      .map(([cond, body, elseBody]) => ({
        kind: 'if',
        branches: [{ cond, body }],
        elseBody: elseBody.length > 0 ? elseBody : null,
        loc,
      }) as Stmt),
    fc
      .tuple(
        identGen,
        tie('expr') as fc.Arbitrary<Expr>,
        fc.array(tie('stmt') as fc.Arbitrary<Stmt>, { minLength: 0, maxLength: 2 }),
      )
      .map(([variable, iterable, body]) => ({ kind: 'for', variable, iterable, body, loc }) as Stmt),
  ),
}));

const stmtGen: fc.Arbitrary<Stmt> = exprGen.stmt;
const exprArb: fc.Arbitrary<Expr> = exprGen.expr;

const programGen: fc.Arbitrary<Program> = fc
  .array(stmtGen, { minLength: 0, maxLength: 4 })
  .map((statements) => ({ langVersion: LANG_VERSION, statements }));

describe('round-trip: print → parse → print is stable', () => {
  it('holds for arbitrary programs', () => {
    fc.assert(
      fc.property(programGen, (program) => {
        const text1 = printProgram(program);
        const parsed = parse(text1);
        if (!parsed.ok || !parsed.program) {
          throw new Error(`printed program failed to parse: ${JSON.stringify(parsed.errors)}\n---\n${text1}`);
        }
        const text2 = printProgram(parsed.program);
        expect(text2).toBe(text1);
      }),
      { numRuns: 500 },
    );
  });

  it('holds for arbitrary expressions', () => {
    fc.assert(
      fc.property(exprArb, (expr) => {
        const text1 = printExpr(expr);
        const parsed = parse(`let x = ${text1}`);
        if (!parsed.ok) {
          throw new Error(`printed expr failed to parse: ${JSON.stringify(parsed.errors)}: ${text1}`);
        }
        const stmt = parsed.program!.statements[0]!;
        if (stmt.kind !== 'let') throw new Error('unexpected');
        const text2 = printExpr(stmt.value);
        expect(text2).toBe(text1);
      }),
      { numRuns: 500 },
    );
  });
});
