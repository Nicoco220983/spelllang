/**
 * @fileoverview Tolerant, location-aware Parser for spelllang with LLM-friendly diagnostic recovery.
 */

import { TokenType, Lexer } from './lexer.js';
import * as AST from './ast.js';

/**
 * Operator Precedence Table (higher number = tighter binding)
 */
const PRECEDENCE = {
    [TokenType.PIPE]: 10,
    [TokenType.OR]: 20,
    [TokenType.AND]: 30,
    [TokenType.EQ]: 40,
    [TokenType.NEQ]: 40,
    [TokenType.LT]: 50,
    [TokenType.LTE]: 50,
    [TokenType.GT]: 50,
    [TokenType.GTE]: 50,
    [TokenType.PLUS]: 60,
    [TokenType.MINUS]: 60,
    [TokenType.STAR]: 70,
    [TokenType.SLASH]: 70,
    [TokenType.PERCENT]: 70
};

export class Parser {
    /**
     * @param {string} source
     */
    constructor(source) {
        this.source = source;
        this.lexer = new Lexer(source);
        this.tokens = this.lexer.tokenize();
        this.pos = 0;
        /** @type {Array<{line: number, column: number, message: string, snippet?: string, suggestion?: string}>} */
        this.errors = [];
    }

    currentToken() {
        return this.tokens[this.pos] || this.tokens[this.tokens.length - 1];
    }

    peekToken(offset = 1) {
        const idx = this.pos + offset;
        return idx < this.tokens.length ? this.tokens[idx] : this.tokens[this.tokens.length - 1];
    }

    advance() {
        const tok = this.currentToken();
        if (tok.type !== TokenType.EOF) {
            this.pos++;
        }
        return tok;
    }

    match(type) {
        if (this.currentToken().type === type) {
            return this.advance();
        }
        return null;
    }

    expect(type, customMsg = null, suggestion = null) {
        const tok = this.currentToken();
        if (tok.type === type) {
            return this.advance();
        }
        const msg = customMsg || `Expected '${type}' but found '${tok.raw || tok.type}'`;
        this.recordError(tok, msg, suggestion);
        return null;
    }

    recordError(token, message, suggestion = null) {
        const snippet = this.getSnippet(token.line, token.column);
        this.errors.push({
            line: token.line,
            column: token.column,
            message,
            snippet,
            suggestion
        });
    }

    getSnippet(lineNum, column) {
        const lines = this.source.split(/\r?\n/);
        const line = lines[lineNum - 1] || '';
        const padding = ' '.repeat(Math.max(0, column - 1));
        return `${lineNum} | ${line}\n  | ${padding}^`;
    }

    /**
     * Resynchronizes after a parsing error.
     */
    synchronize() {
        this.advance();
        while (this.currentToken().type !== TokenType.EOF) {
            // Semicolon boundary
            if (this.peekToken(-1)?.type === TokenType.SEMICOLON) return;
            // Statement keywords
            switch (this.currentToken().type) {
                case TokenType.LET:
                case TokenType.STATE:
                case TokenType.FN:
                case TokenType.IF:
                case TokenType.RETURN:
                case TokenType.RBRACE:
                    return;
            }
            this.advance();
        }
    }

    /**
     * Parse the complete Program.
     * @returns {{ast: Object, errors: Array<Object>, success: boolean}}
     */
    parse() {
        const body = [];
        while (this.currentToken().type !== TokenType.EOF) {
            // Skip optional stray semicolons
            if (this.match(TokenType.SEMICOLON)) continue;

            try {
                const stmt = this.parseStatement();
                if (stmt) {
                    body.push(stmt);
                }
            } catch (err) {
                this.recordError(this.currentToken(), err.message || 'Unexpected parsing error');
                this.synchronize();
            }
        }

        const ast = AST.createProgram(body);
        return {
            ast,
            errors: this.errors,
            success: this.errors.length === 0
        };
    }

    /* =========================================================================
     * Statements
     * ========================================================================= */

    parseStatement() {
        const tok = this.currentToken();

        // Check for illegal tokens
        if (tok.type === TokenType.ILLEGAL) {
            this.recordError(tok, `Illegal character '${tok.raw}'`);
            this.advance();
            return null;
        }

        if (tok.type === TokenType.LET) {
            return this.parseVariableDeclaration();
        }
        if (tok.type === TokenType.STATE) {
            return this.parseStateAssignment();
        }
        if (tok.type === TokenType.FN) {
            return this.parseFunctionDeclaration();
        }
        if (tok.type === TokenType.IF) {
            return this.parseIfStatement();
        }
        if (tok.type === TokenType.RETURN) {
            return this.parseReturnStatement();
        }

        // Default to ExpressionStatement
        const expr = this.parseExpression();
        if (!expr) return null;
        this.match(TokenType.SEMICOLON);
        return AST.createExpressionStatement(expr);
    }

    parseVariableDeclaration() {
        const letTok = this.advance(); // consume 'let'
        const identTok = this.expect(TokenType.IDENT, 'Expected variable name after let');
        if (!identTok) {
            this.synchronize();
            return null;
        }

        this.expect(TokenType.ASSIGN, "Expected '=' in variable declaration", "Assign an initial value like 'let x = 10'");
        const init = this.parseExpression();
        this.match(TokenType.SEMICOLON);

        return AST.createVariableDeclaration(identTok.value, init, {
            start: { line: letTok.line, column: letTok.column }
        });
    }

    parseStateAssignment() {
        const stateTok = this.advance(); // consume 'state'
        this.expect(TokenType.DOT, "Expected '.' after 'state'", "Access state properties like 'state.key'");
        const keyTok = this.expect(TokenType.IDENT, 'Expected property name on state');
        if (!keyTok) {
            this.synchronize();
            return null;
        }

        this.expect(TokenType.ASSIGN, "Expected '=' in state assignment", "Assign a value like 'state.key = value'");
        const val = this.parseExpression();
        this.match(TokenType.SEMICOLON);

        return AST.createStateAssignment(keyTok.value, val, {
            start: { line: stateTok.line, column: stateTok.column }
        });
    }

    parseFunctionDeclaration() {
        const fnTok = this.advance(); // consume 'fn'
        const nameTok = this.expect(TokenType.IDENT, 'Expected function name after fn');
        if (!nameTok) {
            this.synchronize();
            return null;
        }

        this.expect(TokenType.LPAREN, "Expected '(' after function name");
        const params = this.parseParameterList();
        this.expect(TokenType.RPAREN, "Expected ')' after parameter list");

        // Silent tolerance: Rust-style return type annotation '-> Type'
        let returnType = null;
        if (this.currentToken().type === TokenType.ARROW) {
            this.advance(); // consume ->
            const retTypeTok = this.expect(TokenType.IDENT, 'Expected return type after ->');
            if (retTypeTok) returnType = retTypeTok.value;
        }

        const body = this.parseBlock();

        return AST.createFunctionDeclaration(nameTok.value, params, body, returnType, {
            start: { line: fnTok.line, column: fnTok.column }
        });
    }

    parseParameterList() {
        const params = [];
        if (this.currentToken().type === TokenType.RPAREN) {
            return params;
        }

        while (true) {
            const pTok = this.expect(TokenType.IDENT, 'Expected parameter name');
            if (!pTok) break;

            let typeAnnotation = 'Any';
            // Optional type annotation: `arg: Type`
            if (this.match(TokenType.COLON)) {
                const typeTok = this.expect(TokenType.IDENT, 'Expected type after :');
                if (typeTok) {
                    typeAnnotation = typeTok.value;
                }
            }

            params.push({ name: pTok.value, typeAnnotation });

            if (!this.match(TokenType.COMMA)) {
                break;
            }
        }
        return params;
    }

    parseBlock() {
        const lbrace = this.expect(TokenType.LBRACE, "Expected '{' to start block");
        const body = [];

        while (this.currentToken().type !== TokenType.RBRACE && this.currentToken().type !== TokenType.EOF) {
            if (this.match(TokenType.SEMICOLON)) continue;
            const stmt = this.parseStatement();
            if (stmt) {
                body.push(stmt);
            }
        }

        this.expect(TokenType.RBRACE, "Expected '}' to close block");
        return AST.createBlockStatement(body, lbrace ? { start: { line: lbrace.line, column: lbrace.column } } : undefined);
    }

    parseIfStatement() {
        const ifTok = this.advance(); // consume 'if'
        const test = this.parseExpression();
        const consequent = this.parseBlock();

        let alternate = null;
        if (this.match(TokenType.ELSE)) {
            if (this.currentToken().type === TokenType.IF) {
                alternate = this.parseIfStatement();
            } else {
                alternate = this.parseBlock();
            }
        }

        return AST.createIfStatement(test, consequent, alternate, {
            start: { line: ifTok.line, column: ifTok.column }
        });
    }

    parseReturnStatement() {
        const retTok = this.advance(); // consume 'return'
        let arg = null;
        if (this.currentToken().type !== TokenType.SEMICOLON &&
            this.currentToken().type !== TokenType.RBRACE &&
            this.currentToken().type !== TokenType.EOF) {
            arg = this.parseExpression();
        }
        this.match(TokenType.SEMICOLON);
        return AST.createReturnStatement(arg, {
            start: { line: retTok.line, column: retTok.column }
        });
    }

    /* =========================================================================
     * Expressions (Pratt Parsing)
     * ========================================================================= */

    parseExpression(minPrecedence = 0) {
        let left = this.parsePrefix();
        if (!left) return null;

        while (true) {
            const tok = this.currentToken();

            // Detect illegal infix 'contains'
            if (tok.type === TokenType.IDENT && tok.value === 'contains') {
                this.recordError(
                    tok,
                    "Unsupported infix operator 'contains'.",
                    "Use pipeline or function call: 'left |> contains(right)' or 'contains(left, right)'"
                );
                this.advance();
                const right = this.parseExpression(minPrecedence);
                left = AST.createCallExpression(AST.createIdentifier('contains'), [left, right]);
                continue;
            }

            const prec = PRECEDENCE[tok.type];
            if (!prec || prec < minPrecedence) {
                break;
            }

            // Binary Operator or Pipeline
            this.advance(); // consume operator

            if (tok.type === TokenType.PIPE) {
                // Pipeline operator |>
                // Special tolerance: |> .property or |> ["property"]
                if (this.match(TokenType.DOT)) {
                    const propTok = this.expect(TokenType.IDENT, 'Expected property name after .');
                    left = AST.createMemberExpression(left, AST.createIdentifier(propTok ? propTok.value : ''), false);
                    continue;
                }
                const right = this.parseExpression(prec + 1); // left-associative
                left = AST.createPipelineExpression(left, right);
            } else {
                // Standard Binary Expression
                const right = this.parseExpression(prec + 1); // left-associative
                left = AST.createBinaryExpression(tok.value, left, right);
            }
        }

        return left;
    }

    parsePrefix() {
        const tok = this.currentToken();

        // Unary: !, -
        if (tok.type === TokenType.NOT || tok.type === TokenType.MINUS) {
            this.advance();
            const operand = this.parseExpression(80);
            return AST.createUnaryExpression(tok.value, operand, true);
        }

        return this.parsePrimary();
    }

    parsePrimary() {
        let node = null;
        const tok = this.currentToken();

        switch (tok.type) {
            case TokenType.NUMBER:
                this.advance();
                node = AST.createNumberLiteral(tok.value, tok.raw);
                break;

            case TokenType.STRING:
                this.advance();
                node = AST.createStringLiteral(tok.value, tok.raw);
                break;

            case TokenType.TRUE:
            case TokenType.FALSE:
                this.advance();
                node = AST.createBooleanLiteral(tok.value);
                break;

            case TokenType.NULL:
                this.advance();
                node = AST.createNullLiteral();
                break;

            case TokenType.STATE: {
                this.advance(); // consume state
                this.expect(TokenType.DOT, "Expected '.' after state");
                const prop = this.expect(TokenType.IDENT, 'Expected state property name');
                node = AST.createMemberExpression(
                    AST.createIdentifier('state'),
                    AST.createIdentifier(prop ? prop.value : ''),
                    false
                );
                break;
            }

            case TokenType.IDENT: {
                const name = tok.value;
                this.advance();

                // Check for single argument arrow function: `id -> expr` or `id => expr`
                if (this.currentToken().type === TokenType.ARROW) {
                    this.advance(); // consume -> or =>
                    const bodyExpr = this.parseExpression(0);
                    return AST.createFunctionExpression(
                        [{ name, typeAnnotation: 'Any' }],
                        AST.createBlockStatement([AST.createReturnStatement(bodyExpr)])
                    );
                }

                node = AST.createIdentifier(name);
                break;
            }

            case TokenType.LPAREN: {
                this.advance(); // consume '('
                // Check if this is an arrow function with params: `(a, b) -> expr`
                // We'll peek ahead or try parse
                if (this.isArrowParamList()) {
                    const params = this.parseParameterList();
                    this.expect(TokenType.RPAREN, "Expected ')' after parameter list");
                    this.expect(TokenType.ARROW, "Expected '->' or '=>' in arrow function");
                    let body;
                    if (this.currentToken().type === TokenType.LBRACE) {
                        body = this.parseBlock();
                    } else {
                        const expr = this.parseExpression(0);
                        body = AST.createBlockStatement([AST.createReturnStatement(expr)]);
                    }
                    return AST.createFunctionExpression(params, body);
                }

                // Normal grouped expression: `(expr)`
                node = this.parseExpression(0);
                this.expect(TokenType.RPAREN, "Expected ')'");
                break;
            }

            case TokenType.LBRACKET: {
                // Array Literal: [a, b, c]
                this.advance();
                const elements = [];
                if (this.currentToken().type !== TokenType.RBRACKET) {
                    while (true) {
                        elements.push(this.parseExpression(0));
                        if (!this.match(TokenType.COMMA)) break;
                    }
                }
                this.expect(TokenType.RBRACKET, "Expected ']'");
                node = AST.createArrayLiteral(elements);
                break;
            }

            case TokenType.LBRACE: {
                // Map Literal: { a: 1, b: 2 }
                this.advance();
                const properties = [];
                if (this.currentToken().type !== TokenType.RBRACE) {
                    while (true) {
                        let key;
                        if (this.currentToken().type === TokenType.STRING || this.currentToken().type === TokenType.IDENT) {
                            key = this.advance().value;
                        } else {
                            this.recordError(this.currentToken(), 'Expected map key (identifier or string)');
                            break;
                        }
                        this.expect(TokenType.COLON, "Expected ':' after map key");
                        const val = this.parseExpression(0);
                        properties.push({ key, value: val });
                        if (!this.match(TokenType.COMMA)) break;
                    }
                }
                this.expect(TokenType.RBRACE, "Expected '}'");
                node = AST.createMapLiteral(properties);
                break;
            }

            case TokenType.FN: {
                // Anonymous function expression: fn(params) [-> Type] { body }
                this.advance();
                this.expect(TokenType.LPAREN, "Expected '(' after fn");
                const params = this.parseParameterList();
                this.expect(TokenType.RPAREN, "Expected ')'");

                // Silent tolerance: return type
                let returnType = null;
                if (this.currentToken().type === TokenType.ARROW) {
                    this.advance();
                    const retTypeTok = this.expect(TokenType.IDENT, 'Expected return type');
                    if (retTypeTok) returnType = retTypeTok.value;
                }

                const body = this.parseBlock();
                node = AST.createFunctionExpression(params, body, returnType);
                break;
            }

            default:
                this.recordError(tok, `Unexpected token '${tok.raw || tok.type}'`);
                this.advance();
                return null;
        }

        // Postfix operators: function calls `()`, member access `.` or `[]`
        return this.parsePostfix(node);
    }

    parsePostfix(baseNode) {
        let node = baseNode;

        while (true) {
            // Function Call: `node(args...)`
            if (this.match(TokenType.LPAREN)) {
                const args = [];
                if (this.currentToken().type !== TokenType.RPAREN) {
                    while (true) {
                        args.push(this.parseExpression(0));
                        if (!this.match(TokenType.COMMA)) break;
                    }
                }
                this.expect(TokenType.RPAREN, "Expected ')' after arguments");
                node = AST.createCallExpression(node, args);
                continue;
            }

            // Dot Member Access: `node.property`
            if (this.match(TokenType.DOT)) {
                const prop = this.expect(TokenType.IDENT, 'Expected property name after .');
                node = AST.createMemberExpression(node, AST.createIdentifier(prop ? prop.value : ''), false);
                continue;
            }

            // Bracket Member Access: `node[property]`
            if (this.match(TokenType.LBRACKET)) {
                const propExpr = this.parseExpression(0);
                this.expect(TokenType.RBRACKET, "Expected ']' after member expression");
                node = AST.createMemberExpression(node, propExpr, true);
                continue;
            }

            break;
        }

        return node;
    }

    isArrowParamList() {
        // Lookahead to see if this `(...)` is followed by `->` or `=>`
        let depth = 1;
        let i = 0;
        while (depth > 0) {
            const tok = this.peekToken(i);
            if (tok.type === TokenType.EOF) return false;
            if (tok.type === TokenType.LPAREN) depth++;
            if (tok.type === TokenType.RPAREN) depth--;
            i++;
        }
        const nextTok = this.peekToken(i);
        return nextTok.type === TokenType.ARROW;
    }
}
