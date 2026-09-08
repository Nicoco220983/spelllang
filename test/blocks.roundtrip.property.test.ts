import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { parse, parseExpression } from '../src/parser.js';
import { printExpr, printProgram } from '../src/printer.js';
import type { Expr, Program, Stmt } from '../src/ast.js';
import { LANG_VERSION } from '../src/ast.js';
import { BUILTINS } from '../src/builtins.js';
import { shouldRenderAsTextField } from '../src/blocks/mapping.js';

/**
 * Block-surface round-trip properties (SPELLLANG.md §8, DESIGN.md §8):
 *
 * 1. Socket-rule idempotence: the text/nested render decision is a pure
 *    function of the AST, so print → parse must preserve it exactly:
 *    shouldRenderAsTextField(parse(printExpr(e))) === shouldRenderAsTextField(e).
 * 2. print → parse → print stays stable for programs containing the
 *    expression shapes the block UI cares about (calls in args, member
 *    chains, nested lists) — complements roundtrip.property.test.ts.
 */

const loc = { line: 1, col: 1 };

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
);
const builtinNameGen = fc.constantFrom(...BUILTINS.map((b) => b.name));
const strGen = fc.string({ minLength: 0, maxLength: 10 }).filter((s) => !/["\\\n\t]/.test(s));

const exprGen: fc.Arbitrary<Expr> = fc.letrec((tie) => ({
  expr: fc.oneof(
    { maxDepth: 5 },
    numGen.map((v) => ({ kind: 'num', value: v, isInt: Number.isInteger(v), loc }) as Expr),
    strGen.map((v) => ({ kind: 'str', value: v, loc }) as Expr),
    fc.boolean().map((v) => ({ kind: 'bool', value: v, loc }) as Expr),
    identGen.map((v) => ({ kind: 'var', name: v, loc }) as Expr),
    identGen.map((v) => ({ kind: 'stateField', field: v, loc }) as Expr),
    fc
      .array(tie('expr') as fc.Arbitrary<Expr>, { minLength: 0, maxLength: 3 })
      .map((elements) => ({ kind: 'list', elements, loc }) as Expr),
    fc
      .tuple(
        tie('expr') as fc.Arbitrary<Expr>,
        fc.constantFrom('+', '-', '*', '/', '%', '==', '!=', '<', '<=', '>', '>=', 'and', 'or'),
        tie('expr') as fc.Arbitrary<Expr>,
      )
      .map(([left, op, right]) => ({ kind: 'binary', op, left, right, loc }) as Expr),
    fc
      .tuple(fc.constantFrom('-', 'not'), tie('expr') as fc.Arbitrary<Expr>)
      .map(([op, operand]) => ({ kind: 'unary', op, operand, loc }) as Expr),
    fc
      .tuple(tie('expr') as fc.Arbitrary<Expr>, identGen)
      .map(([object, field]) => ({ kind: 'member', object, field, loc }) as Expr),
    fc
      .tuple(builtinNameGen, fc.array(tie('expr') as fc.Arbitrary<Expr>, { minLength: 0, maxLength: 3 }))
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
      .tuple(tie('expr') as fc.Arbitrary<Expr>, fc.array(tie('stmt') as fc.Arbitrary<Stmt>, { minLength: 0, maxLength: 2 }))
      .map(([cond, body]) => ({ kind: 'if', branches: [{ cond, body }], elseBody: null, loc }) as Stmt),
    fc
      .tuple(identGen, tie('expr') as fc.Arbitrary<Expr>, fc.array(tie('stmt') as fc.Arbitrary<Stmt>, { minLength: 0, maxLength: 2 }))
      .map(([variable, iterable, body]) => ({ kind: 'for', variable, iterable, body, loc }) as Stmt),
  ),
}));

const exprArb: fc.Arbitrary<Expr> = exprGen.expr;
const programGen: fc.Arbitrary<Program> = fc
  .array(exprGen.stmt, { minLength: 0, maxLength: 4 })
  .map((statements) => ({ langVersion: LANG_VERSION, statements }));

describe('block surface properties', () => {
  it('socket render rule is preserved by print → parse (idempotent)', () => {
    fc.assert(
      fc.property(exprArb, (e) => {
        const text = printExpr(e);
        const parsed = parseExpression(text);
        if (!parsed.ok || !parsed.expr) {
          throw new Error(`printed expr failed to parse: ${JSON.stringify(parsed.errors)}: ${text}`);
        }
        expect(shouldRenderAsTextField(parsed.expr)).toBe(shouldRenderAsTextField(e));
      }),
      { numRuns: 500 },
    );
  });

  it('print → parse → print stays stable for block-relevant programs', () => {
    fc.assert(
      fc.property(programGen, (program) => {
        const text1 = printProgram(program);
        const parsed = parse(text1);
        if (!parsed.ok || !parsed.program) {
          throw new Error(`printed program failed to parse: ${JSON.stringify(parsed.errors)}\n---\n${text1}`);
        }
        expect(printProgram(parsed.program)).toBe(text1);
      }),
      { numRuns: 500 },
    );
  });
});
