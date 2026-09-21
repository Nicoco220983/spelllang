/**
 * @fileoverview Main entry point for spelllang compiler, sanitizer, transpiler, and runtime.
 */

import { Lexer, TokenType } from './lexer.js';
import { Parser } from './parser.js';
import { Sanitizer } from './sanitizer.js';
import { Transpiler } from './transpiler.js';
import { BUILTINS, BUILTIN_NAMES } from './builtins.js';
import { generatePrompt } from './prompt.js';
import * as AST from './ast.js';

export {
    Lexer,
    TokenType,
    Parser,
    Sanitizer,
    Transpiler,
    BUILTINS,
    BUILTIN_NAMES,
    generatePrompt,
    AST
};

/**
 * Parses spelllang source code into a raw AST.
 * @param {string} source
 * @returns {{ast: Object, errors: Array<Object>, success: boolean}}
 */
export function parse(source) {
    const parser = new Parser(source);
    return parser.parse();
}

/**
 * Sanitizes and normalizes an AST.
 * @param {Object} ast
 * @param {Object} [options]
 * @returns {{ast: Object, errors: Array<Object>, success: boolean}}
 */
export function sanitize(ast, options = {}) {
    const sanitizer = new Sanitizer(options);
    return sanitizer.sanitize(ast);
}

/**
 * Formats errors into a self-healing diagnostic report for LLMs.
 * @param {Array<Object>} errors
 * @param {string} [source]
 * @returns {string}
 */
export function formatErrorReport(errors, source = '') {
    if (!errors || errors.length === 0) return 'No errors detected.';

    const lines = source.split(/\r?\n/);
    const count = errors.length;
    let report = `SpellLang Compilation Failed (${count} error${count > 1 ? 's' : ''} detected):\n\n`;

    errors.forEach((err, idx) => {
        report += `[Error ${idx + 1}]`;
        if (err.line != null) {
            report += ` Line ${err.line}`;
            if (err.column != null) report += `, Col ${err.column}`;
        }
        report += `:\n`;

        if (err.line != null && lines[err.line - 1] !== undefined) {
            const codeLine = lines[err.line - 1];
            const col = Math.max(1, err.column || 1);
            const padding = ' '.repeat(col - 1);
            report += `  ${err.line} | ${codeLine}\n`;
            report += `    | ${padding}^\n`;
        }

        report += `  Message: ${err.message}\n`;
        if (err.suggestion) {
            report += `  Fix: ${err.suggestion}\n`;
        }
        report += '\n';
    });

    return report.trim();
}

/**
 * Compiles spelllang source into a runnable JavaScript function.
 * @param {string} source
 * @param {Object} [options]
 * @param {Array<string>} [options.hostFunctions]
 * @param {Object} [options.builtins]
 * @returns {{success: boolean, ast?: Object, js?: string, run?: Function, errors: Array<Object>, formattedReport?: string}}
 */
export function compile(source, options = {}) {
    const hostFunctions = options.hostFunctions || [];
    const builtins = options.builtins || BUILTINS;

    // 1. Parse
    const parseResult = parse(source);
    if (!parseResult.success) {
        return {
            success: false,
            errors: parseResult.errors,
            formattedReport: formatErrorReport(parseResult.errors, source)
        };
    }

    // 2. Sanitize & Normalize
    const sanitizeResult = sanitize(parseResult.ast, { hostFunctions });
    if (!sanitizeResult.success) {
        return {
            success: false,
            errors: sanitizeResult.errors,
            formattedReport: formatErrorReport(sanitizeResult.errors, source)
        };
    }

    // 3. Transpile
    const transpiler = new Transpiler({ hostFunctions });
    const js = transpiler.transpile(sanitizeResult.ast);
    const run = transpiler.compile(sanitizeResult.ast, builtins);

    return {
        success: true,
        ast: sanitizeResult.ast,
        js,
        run,
        errors: []
    };
}

/**
 * Compiles and executes spelllang code directly with given context and state.
 * @param {string} source
 * @param {Object} [options]
 * @param {Object} [options.context] Host functions/callbacks
 * @param {Object} [options.state] Persistent state object
 * @returns {Object} Updated state
 */
export function run(source, options = {}) {
    const context = options.context || {};
    const state = options.state || {};
    const hostFunctions = Object.keys(context);

    const compiled = compile(source, { hostFunctions });
    if (!compiled.success) {
        const err = new Error(compiled.formattedReport);
        err.diagnostics = compiled.errors;
        throw err;
    }

    return compiled.run(context, state);
}
