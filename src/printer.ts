/**
 * spelllang printer: AST → canonical text. Deterministic and parse-stable:
 * print(parse(print(ast))) === print(ast). See DESIGN.md §2.
 */

import type { Expr, Program, Stmt } from './ast.js';

export function printProgram(program: Program): string {
  return program.statements.map((s) => printStmt(s, '')).join('\n');
}

function printStmt(stmt: Stmt, indent: string): string {
  switch (stmt.kind) {
    case 'call':
      return `${indent}call ${stmt.name}(${stmt.args.map(printExpr).join(', ')})`;
    case 'let':
      return `${indent}let ${stmt.name} = ${printExpr(stmt.value)}`;
    case 'assign':
      return `${indent}${stmt.name} = ${printExpr(stmt.value)}`;
    case 'stateAssign':
      return `${indent}state.${stmt.field} = ${printExpr(stmt.value)}`;
    case 'if': {
      const parts: string[] = [];
      stmt.branches.forEach((branch, i) => {
        const kw = i === 0 ? 'if' : 'else if';
        parts.push(
          `${indent}${kw} ${printExpr(branch.cond)} {`,
          ...branch.body.map((s) => printStmt(s, indent + '  ')),
          `${indent}}`,
        );
      });
      if (stmt.elseBody) {
        parts.push(
          `${indent}else {`,
          ...stmt.elseBody.map((s) => printStmt(s, indent + '  ')),
          `${indent}}`,
        );
      }
      return parts.join('\n');
    }
    case 'for':
      return [
        `${indent}for ${stmt.variable} of ${printExpr(stmt.iterable)} {`,
        ...stmt.body.map((s) => printStmt(s, indent + '  ')),
        `${indent}}`,
      ].join('\n');
    case 'stop':
      return `${indent}stop`;
  }
}

// precedence levels (matches parser, DESIGN.md §1.2)
const PREC = {
  or: 1,
  and: 2,
  cmp: 4,
  add: 5,
  mul: 6,
  unary: 7,
  postfix: 8,
  primary: 9,
} as const;

function exprPrec(expr: Expr): number {
  switch (expr.kind) {
    case 'binary':
      switch (expr.op) {
        case 'or':
          return PREC.or;
        case 'and':
          return PREC.and;
        case '==':
        case '!=':
        case '<':
        case '<=':
        case '>':
        case '>=':
          return PREC.cmp;
        case '+':
        case '-':
          return PREC.add;
        default:
          return PREC.mul;
      }
    case 'unary':
      // `not` binds looser than comparisons (not a == b = not (a == b)),
      // tighter than `and`; `-` binds tighter than * /.
      return expr.op === 'not' ? 3 : PREC.unary;
    case 'member':
    case 'callBuiltin':
      return PREC.postfix;
    default:
      return PREC.primary;
  }
}

/** Print expr, parenthesizing if its precedence is below `min`. */
function printExprAt(expr: Expr, min: number): string {
  const s = printExpr(expr);
  return exprPrec(expr) < min ? `(${s})` : s;
}

export function printExpr(expr: Expr): string {
  switch (expr.kind) {
    case 'num': {
      if (expr.isInt) return String(expr.value);
      // floats that happen to be integral must keep a decimal point,
      // otherwise they re-parse as ints
      return Number.isInteger(expr.value) ? `${expr.value}.0` : String(expr.value);
    }
    case 'str':
      return `"${expr.value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t')}"`;
    case 'bool':
      return String(expr.value);
    case 'enum':
      return expr.name;
    case 'list':
      return `[${expr.elements.map(printExpr).join(', ')}]`;
    case 'var':
      return expr.name;
    case 'stateField':
      return `state.${expr.field}`;
    case 'contextField':
      return expr.field;
    case 'member':
      return `${printExprAt(expr.object, PREC.postfix)}.${expr.field}`;
    case 'binary': {
      const prec = exprPrec(expr);
      // left-assoc: right side needs strictly tighter binding;
      // comparisons are non-associative: both sides get parens at same level
      const rightMin = expr.op === '==' || expr.op === '!=' ? prec + 1 : prec + 1;
      const leftMin =
        expr.op === '==' || expr.op === '!=' || expr.op === '<' || expr.op === '<=' || expr.op === '>' || expr.op === '>='
          ? prec + 1
          : prec;
      return `${printExprAt(expr.left, leftMin)} ${expr.op} ${printExprAt(expr.right, rightMin)}`;
    }
    case 'unary': {
      if (expr.op === 'not') {
        // `not` binds looser than arithmetic (not a + b = not (a + b)),
        // so its operand must print tighter than comparisons.
        return `not ${printExprAt(expr.operand, PREC.cmp + 1)}`;
      }
      // unary minus cannot be followed by `not` in the grammar
      const operand =
        expr.operand.kind === 'unary' && expr.operand.op === 'not'
          ? `(${printExpr(expr.operand)})`
          : printExprAt(expr.operand, PREC.unary);
      return `- ${operand}`;
    }
    case 'callBuiltin':
      return `${expr.name}(${expr.args.map(printExpr).join(', ')})`;
  }
}
