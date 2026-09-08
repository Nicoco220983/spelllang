/**
 * spelllang parser: text → AST. Registry-free (bare identifiers parse as
 * `var`; the validator reclassifies). Multi-error: panic-mode recovery at
 * statement boundaries. See DESIGN.md §1, §5.
 */

import type {
  Expr,
  Loc,
  Program,
  SpellError,
  Stmt,
} from './ast.js';
import { LANG_VERSION, program } from './ast.js';
import { isBuiltin } from './builtins.js';

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

type TokenKind =
  | 'ident'
  | 'number'
  | 'string'
  | 'punct'
  | 'nl'
  | 'eof';

interface Token {
  kind: TokenKind;
  text: string;
  loc: Loc;
  /** for numbers */
  isInt?: boolean;
}

const RESERVED = new Set([
  'call',
  'let',
  'if',
  'else',
  'for',
  'of',
  'stop',
  'state',
  'and',
  'or',
  'not',
  'true',
  'false',
]);

const STATEMENT_KEYWORDS = new Set([
  'call',
  'let',
  'if',
  'for',
  'stop',
  'state',
]);

function tokenize(text: string): { tokens: Token[]; errors: SpellError[] } {
  const tokens: Token[] = [];
  const errors: SpellError[] = [];
  let i = 0;
  let line = 1;
  let col = 1;

  const loc = (): Loc => ({ line, col });
  const advance = (): string => {
    const ch = text[i]!;
    i++;
    if (ch === '\n') {
      line++;
      col = 1;
    } else {
      col++;
    }
    return ch;
  };

  while (i < text.length) {
    const ch = text[i]!;

    if (ch === ' ' || ch === '\t' || ch === '\r') {
      advance();
      continue;
    }
    if (ch === '\n') {
      const l = loc();
      advance();
      tokens.push({ kind: 'nl', text: '\n', loc: l });
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') advance();
      continue;
    }
    if (/[0-9]/.test(ch)) {
      const l = loc();
      let num = '';
      let isInt = true;
      while (i < text.length && /[0-9]/.test(text[i]!)) num += advance();
      if (text[i] === '.' && /[0-9]/.test(text[i + 1] ?? '')) {
        isInt = false;
        num += advance();
        while (i < text.length && /[0-9]/.test(text[i]!)) num += advance();
      }
      tokens.push({ kind: 'number', text: num, loc: l, isInt });
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const l = loc();
      let word = '';
      while (i < text.length && /[A-Za-z0-9_]/.test(text[i]!)) word += advance();
      tokens.push({ kind: 'ident', text: word, loc: l });
      continue;
    }
    if (ch === '"') {
      const l = loc();
      advance(); // opening quote
      let value = '';
      let closed = false;
      while (i < text.length) {
        const c = text[i]!;
        if (c === '"') {
          advance();
          closed = true;
          break;
        }
        if (c === '\n') break;
        if (c === '\\') {
          advance();
          const esc = text[i];
          if (esc === 'n') {
            advance();
            value += '\n';
          } else if (esc === 't') {
            advance();
            value += '\t';
          } else if (esc === '"' || esc === '\\') {
            value += advance();
          } else {
            errors.push({
              line: line,
              col: col,
              code: 'invalid-escape',
              message: `Invalid escape sequence '\\${esc ?? ''}'.`,
              expected: ['n', 't', '"', '\\'],
              found: esc ?? 'end of string',
            });
            advance();
          }
          continue;
        }
        value += advance();
      }
      if (!closed) {
        errors.push({
          line: l.line,
          col: l.col,
          code: 'unclosed-string',
          message: 'Unterminated string literal.',
          expected: ['"'],
          found: 'end of input',
        });
      }
      tokens.push({ kind: 'string', text: value, loc: l });
      continue;
    }
    if ('{}()[],;.=!<>+-*/%'.includes(ch)) {
      const l = loc();
      tokens.push({ kind: 'punct', text: advance(), loc: l });
      continue;
    }
    errors.push({
      line: line,
      col: col,
      code: 'unexpected-character',
      message: `Unexpected character '${ch}'.`,
      found: ch,
    });
    advance();
  }

  tokens.push({ kind: 'eof', text: '', loc: loc() });
  return { tokens, errors };
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

class ParseFailure extends Error {
  constructor(public error: SpellError) {
    super(error.message);
  }
}

export interface ParseResult {
  ok: boolean;
  program?: Program;
  errors: SpellError[];
}

export function parse(text: string): ParseResult {
  const { tokens, errors } = tokenize(text);
  const p = new Parser(tokens, errors);
  const statements = p.parseStatements(false);
  p.expectEnd();
  const allErrors = [...errors, ...p.errors];
  if (allErrors.length > 0) return { ok: false, errors: allErrors };
  return { ok: true, program: program(statements), errors: [] };
}

export interface ExprParseResult {
  ok: boolean;
  expr?: Expr;
  errors: SpellError[];
}

/**
 * Parse a single expression (used by the block UI's socket text fields).
 * Registry-free like `parse`: bare identifiers stay `var` until validation.
 */
export function parseExpression(text: string): ExprParseResult {
  const { tokens, errors } = tokenize(text);
  const p = new Parser(tokens, errors);
  p.skipNewlines();
  let expr: Expr;
  try {
    expr = p.parseExpr();
  } catch (e) {
    if (e instanceof ParseFailure) {
      return { ok: false, errors: [...errors, e.error] };
    }
    throw e;
  }
  p.skipNewlines();
  p.expectEnd();
  const allErrors = [...errors, ...p.errors];
  if (allErrors.length > 0) return { ok: false, errors: allErrors };
  return { ok: true, expr, errors: [] };
}

class Parser {
  pos = 0;
  errors: SpellError[] = [];

  constructor(
    private tokens: Token[],
    private lexerErrors: SpellError[],
  ) {}

  // -- token helpers --------------------------------------------------------

  peek(offset = 0): Token {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)]!;
  }

  next(): Token {
    const t = this.peek();
    if (t.kind !== 'eof') this.pos++;
    return t;
  }

  atPunct(text: string): boolean {
    const t = this.peek();
    return t.kind === 'punct' && t.text === text;
  }

  atIdent(text: string): boolean {
    const t = this.peek();
    return t.kind === 'ident' && t.text === text;
  }

  skipNewlines(): void {
    while (this.peek().kind === 'nl') this.next();
  }

  expectPunct(text: string): Token {
    const t = this.peek();
    if (t.kind === 'punct' && t.text === text) return this.next();
    throw new ParseFailure({
      line: t.loc.line,
      col: t.loc.col,
      code: 'unexpected-token',
      message: `Expected '${text}' but found ${describe(t)}.`,
      expected: [text],
      found: t.text,
    });
  }

  expectIdent(): Token {
    const t = this.peek();
    if (t.kind === 'ident' && !RESERVED.has(t.text)) return this.next();
    throw new ParseFailure({
      line: t.loc.line,
      col: t.loc.col,
      code: 'expected-identifier',
      message: `Expected an identifier but found ${describe(t)}.`,
      found: t.text,
    });
  }

  expectEnd(): void {
    this.skipNewlines();
    const t = this.peek();
    if (t.kind !== 'eof') {
      this.errors.push({
        line: t.loc.line,
        col: t.loc.col,
        code: 'unexpected-token',
        message: `Unexpected ${describe(t)} after end of program.`,
        found: t.text,
      });
    }
  }

  /** Require a statement terminator (';' or newline); consume it. */
  expectTerminator(): void {
    const t = this.peek();
    if (t.kind === 'punct' && t.text === ';') {
      this.next();
      this.skipNewlines();
      return;
    }
    if (t.kind === 'nl') {
      this.skipNewlines();
      return;
    }
    if (t.kind === 'eof' || (t.kind === 'punct' && t.text === '}')) return;
    throw new ParseFailure({
      line: t.loc.line,
      col: t.loc.col,
      code: 'unexpected-token',
      message: `Expected end of statement but found ${describe(t)}.`,
      expected: [';', 'newline'],
      found: t.text,
    });
  }

  // -- statements -----------------------------------------------------------

  parseStatements(untilRBrace: boolean): Stmt[] {
    const stmts: Stmt[] = [];
    for (;;) {
      this.skipNewlines();
      const t = this.peek();
      if (t.kind === 'eof') {
        if (untilRBrace) {
          this.errors.push({
            line: t.loc.line,
            col: t.loc.col,
            code: 'unclosed-brace',
            message: "Unclosed '{' — reached end of input.",
            expected: ['}'],
          });
        }
        return stmts;
      }
      if (this.atPunct('}')) {
        if (untilRBrace) return stmts;
        // stray } at top level: report and skip
        this.errors.push({
          line: t.loc.line,
          col: t.loc.col,
          code: 'unexpected-token',
          message: "Unexpected '}'.",
          found: '}',
        });
        this.next();
        continue;
      }
      try {
        stmts.push(this.parseStatement());
      } catch (e) {
        if (!(e instanceof ParseFailure)) throw e;
        this.errors.push(e.error);
        this.synchronize();
      }
    }
  }

  /** Panic-mode recovery: skip to the next plausible statement boundary. */
  private synchronize(): void {
    for (;;) {
      const t = this.peek();
      if (t.kind === 'eof') return;
      if (t.kind === 'punct' && t.text === '}') return; // let block parser close
      if (t.kind === 'punct' && t.text === ';') {
        this.next();
        this.skipNewlines();
        return;
      }
      if (t.kind === 'nl') {
        this.next();
        // resume only if the next token can start a statement
        const n = this.peek();
        if (
          n.kind === 'eof' ||
          (n.kind === 'punct' && (n.text === '}' || n.text === ';')) ||
          (n.kind === 'ident' && STATEMENT_KEYWORDS.has(n.text))
        ) {
          return;
        }
        continue;
      }
      this.next();
    }
  }

  parseStatement(): Stmt {
    const t = this.peek();
    if (t.kind === 'ident') {
      switch (t.text) {
        case 'call':
          return this.parseCall();
        case 'let':
          return this.parseLet();
        case 'if':
          return this.parseIf();
        case 'for':
          return this.parseFor();
        case 'stop': {
          this.next();
          const loc = t.loc;
          this.expectTerminator();
          return { kind: 'stop', loc };
        }
        case 'state':
          return this.parseStateAssign();
      }
    }
    if (t.kind === 'ident' && !RESERVED.has(t.text)) {
      return this.parseAssign();
    }
    throw new ParseFailure({
      line: t.loc.line,
      col: t.loc.col,
      code: 'expected-statement',
      message: `Expected a statement (call, let, if, for, stop, state) but found ${describe(t)}.`,
      expected: ['call', 'let', 'if', 'for', 'stop'],
      found: t.text,
    });
  }

  parseCall(): Stmt {
    const kw = this.next(); // 'call'
    const name = this.expectIdent();
    this.expectPunct('(');
    const args = this.parseArgs();
    this.expectPunct(')');
    const loc = kw.loc;
    this.expectTerminator();
    return { kind: 'call', name: name.text, args, loc };
  }

  parseLet(): Stmt {
    const kw = this.next(); // 'let'
    const name = this.expectIdent();
    this.expectPunct('=');
    const value = this.parseExpr();
    const loc = kw.loc;
    this.expectTerminator();
    return { kind: 'let', name: name.text, value, loc };
  }

  parseAssign(): Stmt {
    const name = this.next();
    this.expectPunct('=');
    const value = this.parseExpr();
    const loc = name.loc;
    this.expectTerminator();
    return { kind: 'assign', name: name.text, value, loc };
  }

  parseStateAssign(): Stmt {
    const kw = this.next(); // 'state'
    this.expectPunct('.');
    const field = this.expectIdent();
    this.expectPunct('=');
    const value = this.parseExpr();
    const loc = kw.loc;
    this.expectTerminator();
    return { kind: 'stateAssign', field: field.text, value, loc };
  }

  parseIf(): Stmt {
    const kw = this.next(); // 'if'
    const branches: { cond: Expr; body: Stmt[] }[] = [];
    const cond = this.parseExpr();
    const body = this.parseBlock();
    branches.push({ cond, body });
    let elseBody: Stmt[] | null = null;
    for (;;) {
      // `else` may sit on the same line as `}` or on the following line;
      // it is unambiguous (reserved word), so skip newlines to find it.
      // If there is no else, rewind so expectTerminator sees the newlines.
      const mark = this.pos;
      this.skipNewlines();
      if (!this.atIdent('else')) {
        this.pos = mark;
        break;
      }
      this.next();
      if (this.atIdent('if')) {
        this.next();
        const c = this.parseExpr();
        const b = this.parseBlock();
        branches.push({ cond: c, body: b });
        continue;
      }
      elseBody = this.parseBlock();
      break;
    }
    const loc = kw.loc;
    this.expectTerminator();
    return { kind: 'if', branches, elseBody, loc };
  }

  parseFor(): Stmt {
    const kw = this.next(); // 'for'
    const variable = this.expectIdent();
    if (!this.atIdent('of')) {
      const t = this.peek();
      throw new ParseFailure({
        line: t.loc.line,
        col: t.loc.col,
        code: 'unexpected-token',
        message: `Expected 'of' but found ${describe(t)}.`,
        expected: ['of'],
        found: t.text,
      });
    }
    this.next(); // 'of'
    const iterable = this.parseExpr();
    const body = this.parseBlock();
    const loc = kw.loc;
    this.expectTerminator();
    return { kind: 'for', variable: variable.text, iterable, body, loc };
  }

  parseBlock(): Stmt[] {
    this.expectPunct('{');
    const body = this.parseStatements(true);
    this.expectPunct('}');
    return body;
  }

  parseArgs(): Expr[] {
    const args: Expr[] = [];
    this.skipNewlines();
    if (this.atPunct(')')) return args;
    for (;;) {
      args.push(this.parseExpr());
      this.skipNewlines();
      if (this.atPunct(',')) {
        this.next();
        this.skipNewlines();
        if (this.atPunct(')') || this.atPunct(']')) return args; // trailing comma
        continue;
      }
      return args;
    }
  }

  // -- expressions ----------------------------------------------------------

  parseExpr(): Expr {
    return this.parseOr();
  }

  parseOr(): Expr {
    let left = this.parseAnd();
    while (this.atIdent('or')) {
      const op = this.next();
      const right = this.parseAnd();
      left = { kind: 'binary', op: 'or', left, right, loc: op.loc };
    }
    return left;
  }

  parseAnd(): Expr {
    let left = this.parseNot();
    while (this.atIdent('and')) {
      const op = this.next();
      const right = this.parseNot();
      left = { kind: 'binary', op: 'and', left, right, loc: op.loc };
    }
    return left;
  }

  parseNot(): Expr {
    if (this.atIdent('not')) {
      const op = this.next();
      const operand = this.parseNot();
      return { kind: 'unary', op: 'not', operand, loc: op.loc };
    }
    return this.parseCmp();
  }

  parseCmp(): Expr {
    const left = this.parseAdd();
    const op = this.tryReadComparisonOp();
    if (!op) return left;
    const right = this.parseAdd();
    return { kind: 'binary', op: op.text, left, right, loc: op.loc };
  }

  private tryReadComparisonOp(): { text: string; loc: Loc } | null {
    const t = this.peek();
    if (t.kind !== 'punct') return null;
    const two = t.text + (this.peek(1).text ?? '');
    if (two === '==' || two === '!=' || two === '<=' || two === '>=') {
      this.next();
      this.next();
      return { text: two, loc: t.loc };
    }
    if (t.text === '<' || t.text === '>') {
      this.next();
      return { text: t.text, loc: t.loc };
    }
    return null;
  }

  parseAdd(): Expr {
    let left = this.parseMul();
    for (;;) {
      const t = this.peek();
      if (t.kind === 'punct' && (t.text === '+' || t.text === '-')) {
        this.next();
        const right = this.parseMul();
        left = { kind: 'binary', op: t.text, left, right, loc: t.loc };
        continue;
      }
      return left;
    }
  }

  parseMul(): Expr {
    let left = this.parseUnary();
    for (;;) {
      const t = this.peek();
      if (t.kind === 'punct' && (t.text === '*' || t.text === '/' || t.text === '%')) {
        this.next();
        const right = this.parseUnary();
        left = { kind: 'binary', op: t.text, left, right, loc: t.loc };
        continue;
      }
      return left;
    }
  }

  parseUnary(): Expr {
    const t = this.peek();
    if (t.kind === 'punct' && t.text === '-') {
      this.next();
      const operand = this.parseUnary();
      return { kind: 'unary', op: '-', operand, loc: t.loc };
    }
    return this.parsePostfix();
  }

  parsePostfix(): Expr {
    let expr = this.parsePrimary();
    for (;;) {
      const t = this.peek();
      if (t.kind === 'punct' && t.text === '.') {
        this.next();
        const field = this.expectIdent();
        expr = { kind: 'member', object: expr, field: field.text, loc: t.loc };
        continue;
      }
      // builtin call: IDENT '(' immediately (primary was a bare var)
      if (
        t.kind === 'punct' &&
        t.text === '(' &&
        expr.kind === 'var' &&
        isBuiltin(expr.name)
      ) {
        this.next();
        const args = this.parseArgs();
        this.expectPunct(')');
        expr = { kind: 'callBuiltin', name: expr.name, args, loc: t.loc };
        continue;
      }
      if (t.kind === 'punct' && t.text === '(') {
        throw new ParseFailure({
          line: t.loc.line,
          col: t.loc.col,
          code: 'unexpected-token',
          message:
            "Only builtin helpers (min, max, abs, floor, ceil, round, distance, random, range) can be called in expressions; host callables are 'call' statements.",
          expected: ['operator', 'end of expression'],
          found: '(',
        });
      }
      return expr;
    }
  }

  parsePrimary(): Expr {
    const t = this.peek();
    if (t.kind === 'number') {
      this.next();
      return {
        kind: 'num',
        value: Number(t.text),
        isInt: t.isInt ?? true,
        loc: t.loc,
      };
    }
    if (t.kind === 'string') {
      this.next();
      return { kind: 'str', value: t.text, loc: t.loc };
    }
    if (t.kind === 'ident') {
      if (t.text === 'true' || t.text === 'false') {
        this.next();
        return { kind: 'bool', value: t.text === 'true', loc: t.loc };
      }
      if (t.text === 'state') {
        this.next();
        this.expectPunct('.');
        const field = this.expectIdent();
        return { kind: 'stateField', field: field.text, loc: t.loc };
      }
      if (RESERVED.has(t.text)) {
        throw new ParseFailure({
          line: t.loc.line,
          col: t.loc.col,
          code: 'expected-expression',
          message: `Expected an expression but found reserved word '${t.text}'.`,
          found: t.text,
        });
      }
      this.next();
      return { kind: 'var', name: t.text, loc: t.loc };
    }
    if (t.kind === 'punct' && t.text === '(') {
      this.next();
      this.skipNewlines();
      const expr = this.parseExpr();
      this.skipNewlines();
      this.expectPunct(')');
      return expr;
    }
    if (t.kind === 'punct' && t.text === '[') {
      return this.parseListLiteral();
    }
    throw new ParseFailure({
      line: t.loc.line,
      col: t.loc.col,
      code: 'expected-expression',
      message: `Expected an expression but found ${describe(t)}.`,
      found: t.text,
    });
  }

  parseListLiteral(): Expr {
    const open = this.expectPunct('[');
    const elements: Expr[] = [];
    this.skipNewlines();
    if (this.atPunct(']')) {
      this.next();
      return { kind: 'list', elements, loc: open.loc };
    }
    for (;;) {
      elements.push(this.parseExpr());
      this.skipNewlines();
      if (this.atPunct(',')) {
        this.next();
        this.skipNewlines();
        if (this.atPunct(']')) break; // trailing comma
        continue;
      }
      break;
    }
    this.expectPunct(']');
    return { kind: 'list', elements, loc: open.loc };
  }
}

function describe(t: Token): string {
  switch (t.kind) {
    case 'eof':
      return 'end of input';
    case 'nl':
      return 'newline';
    case 'number':
      return `number '${t.text}'`;
    case 'string':
      return 'string literal';
    case 'ident':
      return `'${t.text}'`;
    default:
      return `'${t.text}'`;
  }
}
