/**
 * @fileoverview AST Node definitions and factory functions for spelllang.
 */

/**
 * @typedef {Object} SourceLocation
 * @property {number} line
 * @property {number} column
 */

/**
 * @typedef {Object} NodeLoc
 * @property {SourceLocation} [start]
 * @property {SourceLocation} [end]
 */

/**
 * Creates a Program node.
 * @param {Array<Object>} body
 * @param {NodeLoc} [loc]
 */
export function createProgram(body, loc) {
    return { type: 'Program', body, loc };
}

/**
 * Creates a VariableDeclaration node (`let name = init`).
 * @param {string} name
 * @param {Object} init
 * @param {NodeLoc} [loc]
 */
export function createVariableDeclaration(name, init, loc) {
    return { type: 'VariableDeclaration', name, init, loc };
}

/**
 * Creates a StateAssignment node (`state.key = value`).
 * @param {string} key
 * @param {Object} value
 * @param {NodeLoc} [loc]
 */
export function createStateAssignment(key, value, loc) {
    return { type: 'StateAssignment', key, value, loc };
}

/**
 * Creates a FunctionDeclaration node (`fn name(params) { body }`).
 * @param {string} name
 * @param {Array<{name: string, typeAnnotation?: string}>} params
 * @param {Object} body BlockStatement
 * @param {string} [returnType]
 * @param {NodeLoc} [loc]
 */
export function createFunctionDeclaration(name, params, body, returnType, loc) {
    return { type: 'FunctionDeclaration', name, params, body, returnType, loc };
}

/**
 * Creates an anonymous FunctionExpression / lambda.
 * @param {Array<{name: string, typeAnnotation?: string}>} params
 * @param {Object} body
 * @param {string} [returnType]
 * @param {NodeLoc} [loc]
 */
export function createFunctionExpression(params, body, returnType, loc) {
    return { type: 'FunctionExpression', params, body, returnType, loc };
}

/**
 * Creates a BlockStatement node.
 * @param {Array<Object>} body
 * @param {NodeLoc} [loc]
 */
export function createBlockStatement(body, loc) {
    return { type: 'BlockStatement', body, loc };
}

/**
 * Creates a ReturnStatement node.
 * @param {Object|null} argument
 * @param {NodeLoc} [loc]
 */
export function createReturnStatement(argument, loc) {
    return { type: 'ReturnStatement', argument, loc };
}

/**
 * Creates an IfStatement node.
 * @param {Object} test
 * @param {Object} consequent
 * @param {Object|null} [alternate]
 * @param {NodeLoc} [loc]
 */
export function createIfStatement(test, consequent, alternate = null, loc) {
    return { type: 'IfStatement', test, consequent, alternate, loc };
}

/**
 * Creates an ExpressionStatement node.
 * @param {Object} expression
 * @param {NodeLoc} [loc]
 */
export function createExpressionStatement(expression, loc) {
    return { type: 'ExpressionStatement', expression, loc };
}

/**
 * Creates a PipelineExpression node (`left |> right`).
 * @param {Object} left
 * @param {Object} right
 * @param {NodeLoc} [loc]
 */
export function createPipelineExpression(left, right, loc) {
    return { type: 'PipelineExpression', left, right, loc };
}

/**
 * Creates a CallExpression node (`callee(args...)`).
 * @param {Object} callee
 * @param {Array<Object>} args
 * @param {NodeLoc} [loc]
 */
export function createCallExpression(callee, args, loc) {
    return { type: 'CallExpression', callee, arguments: args, loc };
}

/**
 * Creates a MemberExpression node (`object.property` or `object[property]`).
 * @param {Object} object
 * @param {Object} property
 * @param {boolean} computed
 * @param {NodeLoc} [loc]
 */
export function createMemberExpression(object, property, computed = false, loc) {
    return { type: 'MemberExpression', object, property, computed, loc };
}

/**
 * Creates a BinaryExpression node (`left op right`).
 * @param {string} operator
 * @param {Object} left
 * @param {Object} right
 * @param {NodeLoc} [loc]
 */
export function createBinaryExpression(operator, left, right, loc) {
    return { type: 'BinaryExpression', operator, left, right, loc };
}

/**
 * Creates a UnaryExpression node (`op argument`).
 * @param {string} operator
 * @param {Object} argument
 * @param {boolean} [prefix=true]
 * @param {NodeLoc} [loc]
 */
export function createUnaryExpression(operator, argument, prefix = true, loc) {
    return { type: 'UnaryExpression', operator, argument, prefix, loc };
}

/**
 * Creates an Identifier node.
 * @param {string} name
 * @param {NodeLoc} [loc]
 */
export function createIdentifier(name, loc) {
    return { type: 'Identifier', name, loc };
}

/**
 * Creates a NumberLiteral node.
 * @param {number} value
 * @param {string} raw
 * @param {NodeLoc} [loc]
 */
export function createNumberLiteral(value, raw, loc) {
    return { type: 'NumberLiteral', value, raw, loc };
}

/**
 * Creates a StringLiteral node.
 * @param {string} value
 * @param {string} raw
 * @param {NodeLoc} [loc]
 */
export function createStringLiteral(value, raw, loc) {
    return { type: 'StringLiteral', value, raw, loc };
}

/**
 * Creates a BooleanLiteral node.
 * @param {boolean} value
 * @param {NodeLoc} [loc]
 */
export function createBooleanLiteral(value, loc) {
    return { type: 'BooleanLiteral', value, loc };
}

/**
 * Creates a NullLiteral node.
 * @param {NodeLoc} [loc]
 */
export function createNullLiteral(loc) {
    return { type: 'NullLiteral', value: null, loc };
}

/**
 * Creates an ArrayLiteral node.
 * @param {Array<Object>} elements
 * @param {NodeLoc} [loc]
 */
export function createArrayLiteral(elements, loc) {
    return { type: 'ArrayLiteral', elements, loc };
}

/**
 * Creates a MapLiteral node.
 * @param {Array<{key: string, value: Object}>} properties
 * @param {NodeLoc} [loc]
 */
export function createMapLiteral(properties, loc) {
    return { type: 'MapLiteral', properties, loc };
}
