import { describe, expect, it } from 'vitest';
import { parseExpression } from '../src/parser.js';
import { printExpr } from '../src/printer.js';
import type { Expr, Program, Stmt } from '../src/ast.js';
import { LANG_VERSION } from '../src/ast.js';
import { validate, type Registry } from '../src/validator.js';
import {
  boolLit,
  defaultCallArgs,
  defaultExprFor,
  getExprSlot,
  getStmt,
  getStmtList,
  listLit,
  moveStmt,
  numLit,
  paletteModel,
  replaceExprSlot,
  replaceStmt,
  shouldRenderAsTextField,
  socketView,
  spliceStmt,
  visibleInScopeLets,
} from '../src/blocks/mapping.js';

const loc = { line: 1, col: 1 };
const expr = (text: string): Expr => {
  const r = parseExpression(text);
  if (!r.ok || !r.expr) throw new Error(`bad test expr: ${text}`);
  return r.expr;
};

const reg: Registry = {
  callables: new Map([
    {
      name: 'setVoxel',
      args: [
        { name: 'type', type: { kind: 'enum', name: 'VoxelType' } },
        { name: 'durability', type: { kind: 'int' } },
        { name: 'color', type: { kind: 'string' }, optional: true },
      ],
      returnType: { kind: 'none' },
      fuelCost: 1,
      doc: '',
      category: 'world',
    },
  ].map((c) => [c.name, c])),
  types: new Map([['VoxelType', { kind: 'enum', values: ['DIRT', 'STONE'] }]]),
  stateShape: { anger: { kind: 'int' } },
  contextShape: {},
  limits: { fuel: 100, callDepth: 8, stateSlots: 16, maxResults: 512, maxListLength: 4096 },
};

describe('shouldRenderAsTextField (DESIGN.md §8)', () => {
  // host callables cannot appear in expressions (parser rejects), so
  // member-on-call cases are built as ASTs directly
  const nearestPos: Expr = {
    kind: 'member',
    object: { kind: 'callBuiltin', name: 'nearest', args: [{ kind: 'var', name: 'goblins', loc }], loc },
    field: 'pos',
    loc,
  };
  const minOfNearest: Expr = {
    kind: 'callBuiltin',
    name: 'min',
    args: [nearestPos, { kind: 'num', value: 1, isInt: true, loc }],
    loc,
  };
  it.each([
    ['1 + 2 * 3', true],
    ['a or b', true],
    ['goblin.hp < 5', true],
    ['state.patience - 1', true],
    ['min(x, 1)', true], // one call
    ['distance(a, b) * 2', true], // one call
    ['min(abs(x), 2)', false], // two calls
    ['[1, min(a, b)]', true], // one call inside a list
    ['[min(a, b), max(c, d)]', false], // two calls inside a list
  ])('%s → %s', (text, expected) => {
    expect(shouldRenderAsTextField(expr(text))).toBe(expected);
  });
  it('member on a call result → nested', () => {
    expect(shouldRenderAsTextField(nearestPos)).toBe(false);
    expect(shouldRenderAsTextField(minOfNearest)).toBe(false);
  });
});

describe('socketView (literal specialization)', () => {
  it('number input for numeric literals', () => {
    expect(socketView(expr('42'), { kind: 'int' }, reg).kind).toBe('number');
    expect(socketView(expr('3.5'), { kind: 'float' }, reg).kind).toBe('number');
  });
  it('enum dropdown with declared values', () => {
    const view = socketView(expr('DIRT'), { kind: 'enum', name: 'VoxelType' }, reg);
    expect(view).toEqual({ kind: 'enum', values: ['DIRT', 'STONE'] });
  });
  it('bool dropdown for bool literals', () => {
    expect(socketView(expr('true'), { kind: 'bool' }, reg).kind).toBe('bool');
  });
  it('nested for complex expressions', () => {
    expect(socketView(expr('min(abs(x), 2)'), { kind: 'float' }, reg).kind).toBe('nested');
  });
  it('text field for general expressions', () => {
    expect(socketView(expr('a + 1'), null, reg).kind).toBe('text');
    expect(socketView(expr('goblin.hp'), null, reg).kind).toBe('text');
  });
});

describe('defaultExprFor / defaultCallArgs', () => {
  it('literal defaults per type', () => {
    expect(defaultExprFor({ kind: 'int' }, reg)).toEqual(numLit(0));
    expect(defaultExprFor({ kind: 'bool' }, reg)).toEqual(boolLit(false));
    expect(defaultExprFor({ kind: 'string' }, reg)).toEqual({ kind: 'str', value: '', loc });
    expect(defaultExprFor({ kind: 'enum', name: 'VoxelType' }, reg)).toEqual({
      kind: 'enum',
      name: 'DIRT',
      loc,
    });
    expect(defaultExprFor({ kind: 'list', elem: { kind: 'int' } }, reg)).toEqual(listLit([]));
    expect(defaultExprFor({ kind: 'record', name: 'Vec' }, reg)).toBeNull();
  });
  it('fresh call args: required defaulted, trailing optional omitted', () => {
    const decl = reg.callables.get('setVoxel')!;
    const args = defaultCallArgs(decl, reg);
    expect(args).toHaveLength(2);
    expect(args[0]).toEqual({ kind: 'enum', name: 'DIRT', loc });
    expect(args[1]).toEqual(numLit(0));
  });
});

describe('statement paths and edits', () => {
  const program: Program = {
    langVersion: LANG_VERSION,
    statements: [
      { kind: 'let', name: 'a', value: numLit(1), loc },
      {
        kind: 'if',
        branches: [
          { cond: expr('a > 0'), body: [{ kind: 'stop', loc }] },
          { cond: boolLit(false), body: [] },
        ],
        elseBody: [{ kind: 'stop', loc }],
        loc,
      },
      { kind: 'for', variable: 'i', iterable: expr('range(0, 3)'), body: [], loc },
    ],
  };

  it('getStmtList / getStmt resolve nested paths', () => {
    expect(getStmtList(program, [0])).toBe(program.statements);
    expect(getStmt(program, [2])?.kind).toBe('for');
    expect(getStmt(program, [1, 'body:0', 0])?.kind).toBe('stop');
    expect(getStmt(program, [1, 'body:1', 0])).toBeNull();
    expect(getStmt(program, [1, 'else', 0])?.kind).toBe('stop');
    expect(getStmt(program, [2, 'body:0', 3])).toBeNull();
  });

  it('spliceStmt / replaceStmt do not mutate the original', () => {
    const next = spliceStmt(program, [0], 1);
    expect(next.statements).toHaveLength(2);
    expect(program.statements).toHaveLength(3);
    const replaced = replaceStmt(next, [0], { kind: 'stop', loc });
    expect(replaced.statements[0]?.kind).toBe('stop');
  });

  it('moveStmt moves between lists and adjusts same-list indexes', () => {
    const moved = moveStmt(program, [0], [1, 'body:1', 0]);
    expect(moved.statements).toHaveLength(2);
    const ifStmt = moved.statements[0]!;
    expect(ifStmt.kind).toBe('if');
    if (ifStmt.kind === 'if') {
      expect(ifStmt.branches[1]?.body[0]?.kind).toBe('let');
    }
    // move within the root list (insert-before semantics)
    const identity = moveStmt(program, [0], [1]); // inserting 0 before 1 = no-op
    expect(identity.statements[0]?.kind).toBe('let');
    const reordered = moveStmt(program, [0], [2]); // let jumps past the if
    expect(reordered.statements[0]?.kind).toBe('if');
    expect(reordered.statements[1]?.kind).toBe('let');
    expect(reordered.statements[2]?.kind).toBe('for');
  });

  it('visibleInScopeLets collects enclosing scope and loop variables', () => {
    expect(visibleInScopeLets(program, [1, 'body:0', 0])).toContain('a');
    expect(visibleInScopeLets(program, [2, 'body:0', 0])).toContain('i');
    expect(visibleInScopeLets(program, [2])).not.toContain('i');
  });
});

describe('expression slots', () => {
  const stmt: Stmt = {
    kind: 'call',
    name: 'setVoxel',
    args: [expr('min(abs(x), 2)'), numLit(0)],
    loc,
  };

  it('getExprSlot resolves nested selectors', () => {
    expect(getExprSlot(stmt, ['arg:0'])?.kind).toBe('callBuiltin');
    expect(getExprSlot(stmt, ['arg:0', 'arg:0'])?.kind).toBe('callBuiltin'); // abs
    expect(getExprSlot(stmt, ['arg:0', 'arg:1'])?.kind).toBe('num');
  });

  it('replaceExprSlot rebuilds the spine immutably', () => {
    const next = replaceExprSlot(stmt, ['arg:0', 'arg:1'], numLit(9));
    // compare printed forms: parsed and generated nodes differ only in loc
    expect(printExpr(getExprSlot(next, ['arg:0', 'arg:1'])!)).toBe('9');
    expect(printExpr(getExprSlot(stmt, ['arg:0', 'arg:1'])!)).toBe('2');
  });
});

describe('paletteModel', () => {
  it('groups core blocks and callables by category', () => {
    const groups = paletteModel(reg);
    const names = groups.map((g) => g.name);
    expect(names).toEqual(['Control', 'Variables', 'State', 'world']);
    const state = groups.find((g) => g.name === 'State')!;
    expect(state.items.map((i) => i.id)).toEqual(['state:anger']);
    const world = groups.find((g) => g.name === 'world')!;
    expect(world.items[0]!.id).toBe('call:setVoxel');
  });

  it('omits the State group without a state shape', () => {
    const groups = paletteModel({ ...reg, stateShape: {} });
    expect(groups.map((g) => g.name)).not.toContain('State');
  });

  it('palette-made statements validate against the registry', () => {
    const groups = paletteModel(reg);
    const made = groups.flatMap((g) => g.items).map((i) => i.make(reg));
    const program: Program = { langVersion: LANG_VERSION, statements: made };
    const errors = validate(program, reg);
    expect(errors).toEqual([]);
  });
});
