import test from 'node:test';
import assert from 'node:assert/strict';
import { parse, sanitize } from '../../src/index.js';

test('sanitizer: desugars pipeline into canonical call expressions', () => {
    const code = `
    let a = list |> filter(isError) |> tail(10)
    let b = list |> tail(_, 5)
    let c = list |> last
    `;
    const parsed = parse(code);
    assert.equal(parsed.success, true);

    const sanitized = sanitize(parsed.ast);
    assert.equal(sanitized.success, true);

    // a = tail(filter(list, isError), 10)
    const stmtA = sanitized.ast.body[0];
    assert.equal(stmtA.init.type, 'CallExpression');
    assert.equal(stmtA.init.callee.name, 'tail');
    assert.equal(stmtA.init.arguments[0].type, 'CallExpression');
    assert.equal(stmtA.init.arguments[0].callee.name, 'filter');

    // b = tail(list, 5) with '_' stripped
    const stmtB = sanitized.ast.body[1];
    assert.equal(stmtB.init.type, 'CallExpression');
    assert.equal(stmtB.init.callee.name, 'tail');
    assert.equal(stmtB.init.arguments[0].name, 'list');
    assert.equal(stmtB.init.arguments[1].value, 5);

    // c = last(list)
    const stmtC = sanitized.ast.body[2];
    assert.equal(stmtC.init.type, 'CallExpression');
    assert.equal(stmtC.init.callee.name, 'last');
    assert.equal(stmtC.init.arguments[0].name, 'list');
});

test('sanitizer: pipeline chained property access desugaring', () => {
    const code = `
    let forecast = getWeather() |> .forecast
    `;
    const parsed = parse(code);
    assert.equal(parsed.success, true);

    const sanitized = sanitize(parsed.ast);
    assert.equal(sanitized.success, true);

    const stmt = sanitized.ast.body[0];
    assert.equal(stmt.init.type, 'MemberExpression');
    assert.equal(stmt.init.property.name, 'forecast');
});

test('sanitizer: implicit return desugaring in functions', () => {
    const code = `
    fn add(a: Num, b: Num) {
        a + b
    }
    `;
    const parsed = parse(code);
    const sanitized = sanitize(parsed.ast);
    assert.equal(sanitized.success, true);

    const fnDecl = sanitized.ast.body[0];
    const lastStmt = fnDecl.body.body[0];
    assert.equal(lastStmt.type, 'ReturnStatement');
    assert.equal(lastStmt.argument.type, 'BinaryExpression');
});

test('sanitizer: prevents variable shadowing of built-ins and host functions', () => {
    const code = `
    let filter = 123
    let getSensors = "conflict"
    `;
    const parsed = parse(code);
    const sanitized = sanitize(parsed.ast, { hostFunctions: ['getSensors'] });

    assert.equal(sanitized.success, false);
    assert.equal(sanitized.errors.length, 2);
    assert.match(sanitized.errors[0].message, /Cannot declare variable 'filter'/);
    assert.match(sanitized.errors[1].message, /Cannot declare variable 'getSensors'/);
});
