/**
 * @fileoverview AST Sanitizer & Normalizer for spelllang.
 * Desugars tolerant syntax (pipelines, placeholders, arrows, implicit returns) into canonical AST.
 */

import * as AST from './ast.js';
import { BUILTIN_NAMES } from './builtins.js';

export class Sanitizer {
    /**
     * @param {Object} [options]
     * @param {Set<string>|Array<string>} [options.hostFunctions]
     */
    constructor(options = {}) {
        this.hostFunctions = new Set(options.hostFunctions || []);
        /** @type {Array<{message: string, line?: number, column?: number, suggestion?: string}>} */
        this.errors = [];
    }

    /**
     * Sanitize and canonicalize the AST.
     * @param {Object} ast Program AST node
     * @returns {{ast: Object, errors: Array<Object>, success: boolean}}
     */
    sanitize(ast) {
        this.errors = [];
        if (!ast || ast.type !== 'Program') {
            return { ast, errors: this.errors, success: true };
        }

        const canonicalBody = ast.body.map(stmt => this.sanitizeStatement(stmt)).filter(Boolean);
        const canonicalAst = AST.createProgram(canonicalBody, ast.loc);

        return {
            ast: canonicalAst,
            errors: this.errors,
            success: this.errors.length === 0
        };
    }

    sanitizeStatement(stmt) {
        if (!stmt) return null;

        switch (stmt.type) {
            case 'VariableDeclaration': {
                // Check variable shadowing
                if (BUILTIN_NAMES.has(stmt.name) || this.hostFunctions.has(stmt.name)) {
                    this.errors.push({
                        message: `Cannot declare variable '${stmt.name}': shadows an existing built-in or host function.`,
                        line: stmt.loc?.start?.line,
                        column: stmt.loc?.start?.column,
                        suggestion: `Rename '${stmt.name}' to something else (e.g. 'my_${stmt.name}').`
                    });
                }
                return AST.createVariableDeclaration(
                    stmt.name,
                    this.sanitizeExpression(stmt.init),
                    stmt.loc
                );
            }

            case 'StateAssignment': {
                return AST.createStateAssignment(
                    stmt.key,
                    this.sanitizeExpression(stmt.value),
                    stmt.loc
                );
            }

            case 'FunctionDeclaration': {
                return this.sanitizeFunction(stmt, true);
            }

            case 'IfStatement': {
                return AST.createIfStatement(
                    this.sanitizeExpression(stmt.test),
                    this.sanitizeBlock(stmt.consequent, false),
                    stmt.alternate ? (stmt.alternate.type === 'IfStatement'
                        ? this.sanitizeStatement(stmt.alternate)
                        : this.sanitizeBlock(stmt.alternate, false)) : null,
                    stmt.loc
                );
            }

            case 'ReturnStatement': {
                return AST.createReturnStatement(
                    stmt.argument ? this.sanitizeExpression(stmt.argument) : null,
                    stmt.loc
                );
            }

            case 'ExpressionStatement': {
                return AST.createExpressionStatement(
                    this.sanitizeExpression(stmt.expression),
                    stmt.loc
                );
            }

            default:
                return stmt;
        }
    }

    sanitizeBlock(block, isFunctionBody = false) {
        if (!block || block.type !== 'BlockStatement') return block;

        const body = block.body.map(stmt => this.sanitizeStatement(stmt)).filter(Boolean);

        // Implicit return handling in functions
        if (isFunctionBody && body.length > 0) {
            const lastIdx = body.length - 1;
            body[lastIdx] = this.ensureImplicitReturn(body[lastIdx]);
        }

        return AST.createBlockStatement(body, block.loc);
    }

    ensureImplicitReturn(stmt) {
        if (!stmt) return stmt;
        if (stmt.type === 'ExpressionStatement') {
            return AST.createReturnStatement(stmt.expression, stmt.loc);
        }
        if (stmt.type === 'IfStatement' && stmt.alternate) {
            this.ensureBlockImplicitReturn(stmt.consequent);
            if (stmt.alternate.type === 'IfStatement') {
                stmt.alternate = this.ensureImplicitReturn(stmt.alternate);
            } else if (stmt.alternate.type === 'BlockStatement') {
                this.ensureBlockImplicitReturn(stmt.alternate);
            }
            return stmt;
        }
        return stmt;
    }

    ensureBlockImplicitReturn(block) {
        if (!block || block.type !== 'BlockStatement' || block.body.length === 0) return;
        const lastIdx = block.body.length - 1;
        block.body[lastIdx] = this.ensureImplicitReturn(block.body[lastIdx]);
    }

    sanitizeFunction(fnNode, isDeclaration = false) {
        // Normalize params: ensure typeAnnotation is provided (fallback to 'Any')
        const params = (fnNode.params || []).map(p => ({
            name: p.name,
            typeAnnotation: p.typeAnnotation || 'Any'
        }));

        let bodyBlock;
        if (fnNode.body.type === 'BlockStatement') {
            bodyBlock = this.sanitizeBlock(fnNode.body, true);
        } else {
            // Arrow lambda with single expression body
            const returnExpr = this.sanitizeExpression(fnNode.body);
            bodyBlock = AST.createBlockStatement([AST.createReturnStatement(returnExpr)], fnNode.loc);
        }

        if (isDeclaration) {
            return AST.createFunctionDeclaration(
                fnNode.name,
                params,
                bodyBlock,
                null, // strip returnType annotation for canonical AST
                fnNode.loc
            );
        } else {
            return AST.createFunctionExpression(
                params,
                bodyBlock,
                null,
                fnNode.loc
            );
        }
    }

    sanitizeExpression(expr) {
        if (!expr) return null;

        switch (expr.type) {
            case 'PipelineExpression':
                return this.desugarPipeline(expr);

            case 'CallExpression': {
                const callee = this.sanitizeExpression(expr.callee);
                const args = expr.arguments.map(arg => this.sanitizeExpression(arg));
                return AST.createCallExpression(callee, args, expr.loc);
            }

            case 'MemberExpression': {
                const object = this.sanitizeExpression(expr.object);
                const property = expr.computed ? this.sanitizeExpression(expr.property) : expr.property;
                return AST.createMemberExpression(object, property, expr.computed, expr.loc);
            }

            case 'BinaryExpression': {
                const left = this.sanitizeExpression(expr.left);
                const right = this.sanitizeExpression(expr.right);
                return AST.createBinaryExpression(expr.operator, left, right, expr.loc);
            }

            case 'UnaryExpression': {
                const argument = this.sanitizeExpression(expr.argument);
                return AST.createUnaryExpression(expr.operator, argument, expr.prefix, expr.loc);
            }

            case 'FunctionExpression':
                return this.sanitizeFunction(expr, false);

            case 'ArrayLiteral': {
                const elements = expr.elements.map(el => this.sanitizeExpression(el));
                return AST.createArrayLiteral(elements, expr.loc);
            }

            case 'MapLiteral': {
                const properties = expr.properties.map(p => ({
                    key: p.key,
                    value: this.sanitizeExpression(p.value)
                }));
                return AST.createMapLiteral(properties, expr.loc);
            }

            default:
                return expr;
        }
    }

    desugarPipeline(pipelineNode) {
        const left = this.sanitizeExpression(pipelineNode.left);
        const right = pipelineNode.right;

        // Case 1: `left |> .property`
        if (right.type === 'MemberExpression' && right.object?.type === 'Identifier' && right.object.name === '') {
            return AST.createMemberExpression(left, right.property, right.computed, pipelineNode.loc);
        }

        // Case 2: `left |> func(args...)`
        if (right.type === 'CallExpression') {
            const callee = this.sanitizeExpression(right.callee);
            let args = right.arguments.map(arg => this.sanitizeExpression(arg));

            // Check if first arg is placeholder '_': `left |> func(_, b)`
            if (args.length > 0 && args[0].type === 'Identifier' && args[0].name === '_') {
                args[0] = left;
            } else {
                args.unshift(left);
            }

            return AST.createCallExpression(callee, args, pipelineNode.loc);
        }

        // Case 3: `left |> func` (bare identifier function call: `list |> last`)
        if (right.type === 'Identifier') {
            const callee = this.sanitizeExpression(right);
            return AST.createCallExpression(callee, [left], pipelineNode.loc);
        }

        // Case 4: `left |> fn(x) { ... }` (lambda pipe)
        if (right.type === 'FunctionExpression') {
            const fnExpr = this.sanitizeFunction(right, false);
            return AST.createCallExpression(fnExpr, [left], pipelineNode.loc);
        }

        // Fallback: standard call
        return AST.createCallExpression(this.sanitizeExpression(right), [left], pipelineNode.loc);
    }
}
