/**
 * @fileoverview Pure JavaScript Transpiler for spelllang.
 * Generates executable JavaScript code from a canonical spelllang AST.
 */

import { BUILTIN_NAMES } from './builtins.js';

export class Transpiler {
    /**
     * @param {Object} [options]
     * @param {Array<string>} [options.hostFunctions]
     */
    constructor(options = {}) {
        this.hostFunctions = options.hostFunctions || [];
    }

    /**
     * Transpiles a canonical AST into executable JS source string.
     * @param {Object} ast Canonical Program node
     * @returns {string} Executable JS code
     */
    transpile(ast) {
        if (!ast || ast.type !== 'Program') {
            return '';
        }
        return ast.body.map(stmt => this.transpileStatement(stmt)).join('\n');
    }

    /**
     * Creates an executable Function from a canonical AST.
     * @param {Object} ast
     * @param {Object} [builtins]
     * @returns {Function} Callable runner: (context, state) => void
     */
    compile(ast, builtins = {}) {
        const scriptBody = this.transpile(ast);

        // Dynamically build runner with context and state injected
        const fnSource = `
"use strict";
return function runSpell(context, state) {
    context = context || {};
    state = state || {};

    // Destructure built-ins into local scope
    ${Array.from(BUILTIN_NAMES).map(name => `const ${name} = __builtins.${name};`).join(' ')}

    // Destructure host environment context into local scope
    ${this.hostFunctions.map(name => `const ${name} = context.${name} ? context.${name}.bind(context) : context.${name};`).join(' ')}

    // If any context function was not explicitly declared in options, fallback via with or scope lookup
    // Execute generated script
    ${scriptBody}

    return state;
};
`;
        try {
            const factory = new Function('__builtins', fnSource);
            return factory(builtins);
        } catch (err) {
            throw new Error(`Failed to compile script to JS function: ${err.message}\nGenerated Code:\n${scriptBody}`);
        }
    }

    transpileStatement(stmt, indent = '') {
        if (!stmt) return '';

        switch (stmt.type) {
            case 'VariableDeclaration':
                return `${indent}let ${stmt.name} = ${this.transpileExpression(stmt.init)};`;

            case 'StateAssignment':
                return `${indent}state.${stmt.key} = ${this.transpileExpression(stmt.value)};`;

            case 'FunctionDeclaration': {
                const params = (stmt.params || []).map(p => p.name).join(', ');
                const body = this.transpileBlock(stmt.body, indent);
                return `${indent}function ${stmt.name}(${params}) ${body}`;
            }

            case 'IfStatement': {
                const test = this.transpileExpression(stmt.test);
                const consequent = this.transpileBlock(stmt.consequent, indent);
                let out = `${indent}if (${test}) ${consequent}`;
                if (stmt.alternate) {
                    if (stmt.alternate.type === 'IfStatement') {
                        out += ` else ${this.transpileStatement(stmt.alternate, '').trim()}`;
                    } else {
                        out += ` else ${this.transpileBlock(stmt.alternate, indent)}`;
                    }
                }
                return out;
            }

            case 'ReturnStatement': {
                const arg = stmt.argument ? ` ${this.transpileExpression(stmt.argument)}` : '';
                return `${indent}return${arg};`;
            }

            case 'ExpressionStatement':
                return `${indent}${this.transpileExpression(stmt.expression)};`;

            default:
                return '';
        }
    }

    transpileBlock(block, indent = '') {
        if (!block || block.type !== 'BlockStatement') return '{}';
        const innerIndent = indent + '    ';
        const stmts = block.body.map(s => this.transpileStatement(s, innerIndent)).join('\n');
        return `{\n${stmts}\n${indent}}`;
    }

    transpileExpression(expr) {
        if (!expr) return 'undefined';

        switch (expr.type) {
            case 'NumberLiteral':
                return String(expr.value);

            case 'StringLiteral':
                return JSON.stringify(expr.value);

            case 'BooleanLiteral':
                return expr.value ? 'true' : 'false';

            case 'NullLiteral':
                return 'null';

            case 'Identifier':
                return expr.name;

            case 'BinaryExpression': {
                const left = this.transpileExpression(expr.left);
                const right = this.transpileExpression(expr.right);
                return `(${left} ${expr.operator} ${right})`;
            }

            case 'UnaryExpression': {
                const arg = this.transpileExpression(expr.argument);
                return `(${expr.operator}${arg})`;
            }

            case 'CallExpression': {
                const callee = this.transpileExpression(expr.callee);
                const args = (expr.arguments || []).map(a => this.transpileExpression(a)).join(', ');
                return `${callee}(${args})`;
            }

            case 'MemberExpression': {
                const obj = this.transpileExpression(expr.object);
                if (expr.computed) {
                    const prop = this.transpileExpression(expr.property);
                    return `${obj}[${prop}]`;
                }
                const propName = expr.property.name || expr.property.value;
                return `${obj}.${propName}`;
            }

            case 'FunctionExpression': {
                const params = (expr.params || []).map(p => p.name).join(', ');
                const body = this.transpileBlock(expr.body, '');
                return `(function(${params}) ${body})`;
            }

            case 'ArrayLiteral': {
                const elements = (expr.elements || []).map(e => this.transpileExpression(e)).join(', ');
                return `[${elements}]`;
            }

            case 'MapLiteral': {
                const props = (expr.properties || [])
                    .map(p => `${JSON.stringify(p.key)}: ${this.transpileExpression(p.value)}`)
                    .join(', ');
                return `({ ${props} })`;
            }

            default:
                return 'undefined';
        }
    }
}
