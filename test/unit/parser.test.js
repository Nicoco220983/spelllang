import test from 'node:test';
import assert from 'node:assert/strict';
import { parse, formatErrorReport } from '../../src/index.js';

test('parser: parses basic statements and expressions', () => {
    const code = `
    let threshold = 50
    state.count = state.count + 1
    if threshold > 20 {
        state.active = true
    }
    `;
    const res = parse(code);
    assert.equal(res.success, true);
    assert.equal(res.ast.body.length, 3);
    assert.equal(res.ast.body[0].type, 'VariableDeclaration');
    assert.equal(res.ast.body[1].type, 'StateAssignment');
    assert.equal(res.ast.body[2].type, 'IfStatement');
});

test('parser: silent tolerance for and / or / not', () => {
    const code = `
    if not isArmed and count > 0 or hasError {
        state.status = "alert"
    }
    `;
    const res = parse(code);
    assert.equal(res.success, true);
    const ifStmt = res.ast.body[0];
    assert.equal(ifStmt.type, 'IfStatement');
});

test('parser: silent tolerance for null / nil / None', () => {
    const code = `
    let a = null
    let b = nil
    let c = None
    if a == nil && b == None {
        state.empty = true
    }
    `;
    const res = parse(code);
    assert.equal(res.success, true);
    assert.equal(res.ast.body[0].init.type, 'NullLiteral');
    assert.equal(res.ast.body[1].init.type, 'NullLiteral');
    assert.equal(res.ast.body[2].init.type, 'NullLiteral');
});

test('parser: silent tolerance for arrow functions', () => {
    const code = `
    let result = list |> filter(s -> s.value > 0) |> map((x, y) => x + y)
    `;
    const res = parse(code);
    assert.equal(res.success, true);
});

test('parser: silent tolerance for Rust-style return type', () => {
    const code = `
    fn add(a: Num, b: Num) -> Num {
        a + b
    }
    `;
    const res = parse(code);
    assert.equal(res.success, true);
    assert.equal(res.ast.body[0].type, 'FunctionDeclaration');
    assert.equal(res.ast.body[0].returnType, 'Num');
});

test('parser: error detection for infix contains with self-healing suggestion', () => {
    const code = `
    let check = id contains "ac_unit"
    `;
    const res = parse(code);
    assert.equal(res.success, false);
    assert.equal(res.errors.length, 1);
    assert.match(res.errors[0].message, /Unsupported infix operator 'contains'/);
    assert.match(res.errors[0].suggestion, /left \|> contains\(right\)/);

    const report = formatErrorReport(res.errors, code);
    assert.match(report, /SpellLang Compilation Failed/);
    assert.match(report, /contains/);
});
