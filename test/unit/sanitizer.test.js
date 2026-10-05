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

test('sanitizer: normalizes variadic calls to list builtins into array literals', () => {
    const code = `
    let x = min(a, b)
    let y = max(1, 2, 3)
    let z = sum(10, 20)
    let p = a |> min(b)
    let singleList = min([a, b])
    `;
    const parsed = parse(code);
    assert.equal(parsed.success, true);

    const sanitized = sanitize(parsed.ast);
    assert.equal(sanitized.success, true);

    // x = min([a, b])
    const stmtX = sanitized.ast.body[0];
    assert.equal(stmtX.init.type, 'CallExpression');
    assert.equal(stmtX.init.callee.name, 'min');
    assert.equal(stmtX.init.arguments.length, 1);
    assert.equal(stmtX.init.arguments[0].type, 'ArrayLiteral');
    assert.equal(stmtX.init.arguments[0].elements.length, 2);

    // y = max([1, 2, 3])
    const stmtY = sanitized.ast.body[1];
    assert.equal(stmtY.init.type, 'CallExpression');
    assert.equal(stmtY.init.callee.name, 'max');
    assert.equal(stmtY.init.arguments.length, 1);
    assert.equal(stmtY.init.arguments[0].type, 'ArrayLiteral');
    assert.equal(stmtY.init.arguments[0].elements.length, 3);

    // z = sum([10, 20])
    const stmtZ = sanitized.ast.body[2];
    assert.equal(stmtZ.init.type, 'CallExpression');
    assert.equal(stmtZ.init.callee.name, 'sum');
    assert.equal(stmtZ.init.arguments.length, 1);
    assert.equal(stmtZ.init.arguments[0].type, 'ArrayLiteral');
    assert.equal(stmtZ.init.arguments[0].elements.length, 2);

    // p = min([a, b]) from pipeline desugaring
    const stmtP = sanitized.ast.body[3];
    assert.equal(stmtP.init.type, 'CallExpression');
    assert.equal(stmtP.init.callee.name, 'min');
    assert.equal(stmtP.init.arguments.length, 1);
    assert.equal(stmtP.init.arguments[0].type, 'ArrayLiteral');
    assert.equal(stmtP.init.arguments[0].elements.length, 2);

    // singleList remains min([a, b]) with elements length 2 (not nested)
    const stmtSingle = sanitized.ast.body[4];
    assert.equal(stmtSingle.init.type, 'CallExpression');
    assert.equal(stmtSingle.init.callee.name, 'min');
    assert.equal(stmtSingle.init.arguments.length, 1);
    assert.equal(stmtSingle.init.arguments[0].type, 'ArrayLiteral');
    assert.equal(stmtSingle.init.arguments[0].elements.length, 2);
});

