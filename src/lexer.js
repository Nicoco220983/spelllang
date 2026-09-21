/**
 * @fileoverview Robust, location-aware Lexer for spelllang.
 */

export const TokenType = {
    // Keywords
    LET: 'LET',
    STATE: 'STATE',
    FN: 'FN',
    RETURN: 'RETURN',
    IF: 'IF',
    ELSE: 'ELSE',
    TRUE: 'TRUE',
    FALSE: 'FALSE',
    NULL: 'NULL',

    // Identifiers & Literals
    IDENT: 'IDENT',
    NUMBER: 'NUMBER',
    STRING: 'STRING',

    // Operators
    PIPE: 'PIPE',             // |>
    ARROW: 'ARROW',           // -> or =>
    ASSIGN: 'ASSIGN',         // =
    EQ: 'EQ',                 // ==
    NEQ: 'NEQ',               // !=
    LTE: 'LTE',               // <=
    GTE: 'GTE',               // >=
    LT: 'LT',                 // <
    GT: 'GT',                 // >
    AND: 'AND',               // && or 'and'
    OR: 'OR',                 // || or 'or'
    NOT: 'NOT',               // ! or 'not'
    PLUS: 'PLUS',             // +
    MINUS: 'MINUS',           // -
    STAR: 'STAR',             // *
    SLASH: 'SLASH',           // /
    PERCENT: 'PERCENT',       // %

    // Punctuation
    DOT: 'DOT',               // .
    COMMA: 'COMMA',           // ,
    COLON: 'COLON',           // :
    SEMICOLON: 'SEMICOLON',   // ;
    LPAREN: 'LPAREN',         // (
    RPAREN: 'RPAREN',         // )
    LBRACKET: 'LBRACKET',     // [
    RBRACKET: 'RBRACKET',     // ]
    LBRACE: 'LBRACE',         // {
    RBRACE: 'RBRACE',         // }

    EOF: 'EOF',
    ILLEGAL: 'ILLEGAL'
};

const KEYWORDS = {
    let: TokenType.LET,
    state: TokenType.STATE,
    fn: TokenType.FN,
    return: TokenType.RETURN,
    if: TokenType.IF,
    else: TokenType.ELSE,
    true: TokenType.TRUE,
    false: TokenType.FALSE,
    null: TokenType.NULL,
    // Silent tolerances
    nil: TokenType.NULL,
    None: TokenType.NULL,
    and: TokenType.AND,
    or: TokenType.OR,
    not: TokenType.NOT
};

export class Lexer {
    /**
     * @param {string} source
     */
    constructor(source) {
        this.source = source;
        this.pos = 0;
        this.line = 1;
        this.column = 1;
        this.errors = [];
    }

    /**
     * Tokenize the full source.
     * @returns {Array<{type: string, value: *, raw: string, line: number, column: number, start: number, end: number}>}
     */
    tokenize() {
        const tokens = [];
        let token;
        do {
            token = this.nextToken();
            tokens.push(token);
        } while (token.type !== TokenType.EOF);
        return tokens;
    }

    peek(offset = 0) {
        const idx = this.pos + offset;
        return idx < this.source.length ? this.source[idx] : null;
    }

    advance() {
        const ch = this.peek();
        this.pos++;
        if (ch === '\n') {
            this.line++;
            this.column = 1;
        } else {
            this.column++;
        }
        return ch;
    }

    skipWhitespaceAndComments() {
        while (this.pos < this.source.length) {
            const ch = this.peek();
            // Whitespace
            if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
                this.advance();
                continue;
            }
            // Line comment: //
            if (ch === '/' && this.peek(1) === '/') {
                this.advance();
                this.advance();
                while (this.peek() !== null && this.peek() !== '\n') {
                    this.advance();
                }
                continue;
            }
            // Block comment: /* ... */
            if (ch === '/' && this.peek(1) === '*') {
                this.advance();
                this.advance();
                while (this.peek() !== null) {
                    if (this.peek() === '*' && this.peek(1) === '/') {
                        this.advance();
                        this.advance();
                        break;
                    }
                    this.advance();
                }
                continue;
            }
            break;
        }
    }

    nextToken() {
        this.skipWhitespaceAndComments();

        const startLine = this.line;
        const startColumn = this.column;
        const startPos = this.pos;

        if (this.pos >= this.source.length) {
            return {
                type: TokenType.EOF,
                value: '',
                raw: '',
                line: startLine,
                column: startColumn,
                start: startPos,
                end: startPos
            };
        }

        const ch = this.peek();

        // Pipeline: |>
        if (ch === '|' && this.peek(1) === '>') {
            this.advance();
            this.advance();
            return this._token(TokenType.PIPE, '|>', '|>', startLine, startColumn, startPos);
        }
        // Logical OR: ||
        if (ch === '|' && this.peek(1) === '|') {
            this.advance();
            this.advance();
            return this._token(TokenType.OR, '||', '||', startLine, startColumn, startPos);
        }
        // Logical AND: &&
        if (ch === '&' && this.peek(1) === '&') {
            this.advance();
            this.advance();
            return this._token(TokenType.AND, '&&', '&&', startLine, startColumn, startPos);
        }
        // Arrows: -> or =>
        if (ch === '-' && this.peek(1) === '>') {
            this.advance();
            this.advance();
            return this._token(TokenType.ARROW, '->', '->', startLine, startColumn, startPos);
        }
        if (ch === '=' && this.peek(1) === '>') {
            this.advance();
            this.advance();
            return this._token(TokenType.ARROW, '=>', '=>', startLine, startColumn, startPos);
        }
        // Comparison: ==, !=, <=, >=
        if (ch === '=' && this.peek(1) === '=') {
            this.advance();
            this.advance();
            return this._token(TokenType.EQ, '==', '==', startLine, startColumn, startPos);
        }
        if (ch === '!' && this.peek(1) === '=') {
            this.advance();
            this.advance();
            return this._token(TokenType.NEQ, '!=', '!=', startLine, startColumn, startPos);
        }
        if (ch === '<' && this.peek(1) === '=') {
            this.advance();
            this.advance();
            return this._token(TokenType.LTE, '<=', '<=', startLine, startColumn, startPos);
        }
        if (ch === '>' && this.peek(1) === '=') {
            this.advance();
            this.advance();
            return this._token(TokenType.GTE, '>=', '>=', startLine, startColumn, startPos);
        }

        // Single character operators/punctuation
        switch (ch) {
            case '=': this.advance(); return this._token(TokenType.ASSIGN, '=', '=', startLine, startColumn, startPos);
            case '!': this.advance(); return this._token(TokenType.NOT, '!', '!', startLine, startColumn, startPos);
            case '<': this.advance(); return this._token(TokenType.LT, '<', '<', startLine, startColumn, startPos);
            case '>': this.advance(); return this._token(TokenType.GT, '>', '>', startLine, startColumn, startPos);
            case '+': this.advance(); return this._token(TokenType.PLUS, '+', '+', startLine, startColumn, startPos);
            case '-': this.advance(); return this._token(TokenType.MINUS, '-', '-', startLine, startColumn, startPos);
            case '*': this.advance(); return this._token(TokenType.STAR, '*', '*', startLine, startColumn, startPos);
            case '/': this.advance(); return this._token(TokenType.SLASH, '/', '/', startLine, startColumn, startPos);
            case '%': this.advance(); return this._token(TokenType.PERCENT, '%', '%', startLine, startColumn, startPos);
            case '.': this.advance(); return this._token(TokenType.DOT, '.', '.', startLine, startColumn, startPos);
            case ',': this.advance(); return this._token(TokenType.COMMA, ',', ',', startLine, startColumn, startPos);
            case ':': this.advance(); return this._token(TokenType.COLON, ':', ':', startLine, startColumn, startPos);
            case ';': this.advance(); return this._token(TokenType.SEMICOLON, ';', ';', startLine, startColumn, startPos);
            case '(': this.advance(); return this._token(TokenType.LPAREN, '(', '(', startLine, startColumn, startPos);
            case ')': this.advance(); return this._token(TokenType.RPAREN, ')', ')', startLine, startColumn, startPos);
            case '[': this.advance(); return this._token(TokenType.LBRACKET, '[', '[', startLine, startColumn, startPos);
            case ']': this.advance(); return this._token(TokenType.RBRACKET, ']', ']', startLine, startColumn, startPos);
            case '{': this.advance(); return this._token(TokenType.LBRACE, '{', '{', startLine, startColumn, startPos);
            case '}': this.advance(); return this._token(TokenType.RBRACE, '}', '}', startLine, startColumn, startPos);
        }

        // Numbers: 123, 123.456
        if (isDigit(ch)) {
            return this.readNumber(startLine, startColumn, startPos);
        }

        // Strings: "..." or '...'
        if (ch === '"' || ch === "'") {
            return this.readString(ch, startLine, startColumn, startPos);
        }

        // Identifiers & Keywords: [a-zA-Z_][a-zA-Z0-9_]*
        if (isIdentStart(ch)) {
            return this.readIdentifier(startLine, startColumn, startPos);
        }

        // Illegal character
        const badChar = this.advance();
        return this._token(TokenType.ILLEGAL, badChar, badChar, startLine, startColumn, startPos);
    }

    readNumber(startLine, startColumn, startPos) {
        let raw = '';
        while (isDigit(this.peek())) {
            raw += this.advance();
        }
        if (this.peek() === '.' && isDigit(this.peek(1))) {
            raw += this.advance(); // '.'
            while (isDigit(this.peek())) {
                raw += this.advance();
            }
        }
        const val = parseFloat(raw);
        return this._token(TokenType.NUMBER, val, raw, startLine, startColumn, startPos);
    }

    readString(quote, startLine, startColumn, startPos) {
        this.advance(); // skip opening quote
        let raw = quote;
        let str = '';

        while (this.peek() !== null && this.peek() !== quote) {
            const ch = this.advance();
            raw += ch;
            if (ch === '\\') {
                const esc = this.advance();
                raw += esc;
                switch (esc) {
                    case 'n': str += '\n'; break;
                    case 't': str += '\t'; break;
                    case 'r': str += '\r'; break;
                    case '\\': str += '\\'; break;
                    case "'": str += "'"; break;
                    case '"': str += '"'; break;
                    default: str += esc; break;
                }
            } else {
                str += ch;
            }
        }

        if (this.peek() === quote) {
            raw += this.advance(); // skip closing quote
        }

        return this._token(TokenType.STRING, str, raw, startLine, startColumn, startPos);
    }

    readIdentifier(startLine, startColumn, startPos) {
        let raw = '';
        while (isIdentPart(this.peek())) {
            raw += this.advance();
        }

        const type = KEYWORDS[raw] || TokenType.IDENT;
        let val = raw;
        if (type === TokenType.TRUE) val = true;
        if (type === TokenType.FALSE) val = false;
        if (type === TokenType.NULL) val = null;
        if (type === TokenType.AND) val = '&&';
        if (type === TokenType.OR) val = '||';
        if (type === TokenType.NOT) val = '!';

        return this._token(type, val, raw, startLine, startColumn, startPos);
    }

    _token(type, value, raw, line, column, start) {
        return {
            type,
            value,
            raw,
            line,
            column,
            start,
            end: this.pos
        };
    }
}

function isDigit(ch) {
    return ch !== null && ch >= '0' && ch <= '9';
}

function isIdentStart(ch) {
    return ch !== null && ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_');
}

function isIdentPart(ch) {
    return isIdentStart(ch) || isDigit(ch);
}
