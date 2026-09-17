/**
 * Host API tests: constructor config validation (fail fast on malformed
 * host input) plus the basic embed flow.
 */

import { describe, expect, it } from 'vitest';
import { tEnum, tInt, tNone, tOptional, tRecord, tString } from '../src/ast.js';
import { SpellLang, type SpellLangConfig } from '../src/host.js';

const GOOD_CONFIG: SpellLangConfig = {
  types: { VoxelType: { kind: 'enum', values: ['STONE', 'DIRT'] } },
  stateShape: { count: tInt },
  contextShape: { tick: tInt },
  callables: [
    {
      name: 'setVoxel',
      args: [
        { name: 'x', type: tInt },
        { name: 'type', type: tEnum('VoxelType') },
      ],
      returnType: tNone,
      fuelCost: 1,
      doc: 'place a voxel',
    },
  ],
};

const ACTION_INFO = {
  kind: 'record' as const,
  fields: [
    { name: 'type', type: tString },
    { name: 'startedTick', type: tInt },
    { name: 'completedTick', type: tOptional(tInt) },
  ],
};

const QUERY_CONFIG: SpellLangConfig = {
  types: { ActionInfo: ACTION_INFO },
  stateShape: { count: tInt },
  queries: [
    {
      name: 'getAction',
      args: [],
      returnType: tRecord('ActionInfo'),
      doc: 'Current standing order.',
    },
  ],
};

describe('host: embed flow', () => {
  it('parse → run → intents', () => {
    const lang = new SpellLang(GOOD_CONFIG);
    const parsed = lang.parse('call setVoxel(1 + 1, STONE)');
    expect(parsed.errors).toEqual([]);
    const result = lang.run(parsed.program!, {
      context: { tick: 0 },
      callablesImpl: {
        setVoxel: (args, { emit }) => emit({ op: 'set', x: args[0], type: args[1] }),
      },
    });
    expect(result.error).toBeUndefined();
    expect(result.intents).toEqual([{ op: 'set', x: 2, type: 'STONE' }]);
  });

  it('empty config is valid', () => {
    expect(() => new SpellLang()).not.toThrow();
  });
});

describe('host: ExecResult contract (P1.9)', () => {
  it('a run without state assignment reports stateChanged: false and returns the input record by reference', () => {
    const lang = new SpellLang(GOOD_CONFIG);
    const parsed = lang.parse('call setVoxel(1, STONE)');
    expect(parsed.ok).toBe(true);
    const state = { count: 7 };
    const result = lang.run(parsed.program!, {
      state,
      callablesImpl: { setVoxel: () => {} },
    });
    expect(result.result).toBe('ok');
    expect(result.stateChanged).toBe(false);
    expect(result.state).toBe(state);
  });

  it('a state assignment reports stateChanged: true with a fresh copy out', () => {
    const lang = new SpellLang(GOOD_CONFIG);
    const parsed = lang.parse('state.count = state.count + 1');
    expect(parsed.ok).toBe(true);
    const state = { count: 7 };
    const result = lang.run(parsed.program!, {
      state,
      callablesImpl: { setVoxel: () => {} },
    });
    expect(result.stateChanged).toBe(true);
    expect(result.state).not.toBe(state);
    expect(result.state.count).toBe(8);
    expect(state.count).toBe(7);
  });

  it('runtime errors carry a statement stack with source locations', () => {
    const lang = new SpellLang(GOOD_CONFIG);
    const parsed = lang.parse('call setVoxel(1 % 0, STONE)');
    expect(parsed.ok).toBe(true);
    const result = lang.run(parsed.program!, { callablesImpl: { setVoxel: () => {} } });
    expect(result.result).toBe('runtime-error');
    expect(result.stateChanged).toBe(false);
    expect(result.error?.stack).toEqual([{ line: 1, col: 1, at: "call 'setVoxel'" }]);
  });
});

describe('host: config validation fails fast', () => {
  it('types as an array throws with a pointed hint', () => {
    expect(
      () =>
        new SpellLang({
          ...GOOD_CONFIG,
          // @ts-expect-error deliberately wrong shape
          types: [{ name: 'VoxelType', kind: 'enum', values: ['STONE'] }],
        }),
    ).toThrow(/types must be a Record<string, TypeDecl>, not an array/);
  });

  it('string where a Type object belongs names the fix', () => {
    expect(
      () =>
        new SpellLang({
          ...GOOD_CONFIG,
          stateShape: {
            // @ts-expect-error deliberately wrong shape
            count: 'int',
          },
        }),
    ).toThrow(/stateShape\.count must be a Type object \(e\.g\. tInt/);
  });

  it('enum decl with non-string values throws', () => {
    expect(
      () =>
        new SpellLang({
          ...GOOD_CONFIG,
          types: { VoxelType: { kind: 'enum', values: [1, 2] } },
        }),
    ).toThrow(/types\.VoxelType\.values must be an array of strings/);
  });

  it('record decl field without a type throws', () => {
    expect(
      () =>
        new SpellLang({
          types: {
            Point: { kind: 'record', fields: [{ name: 'x' }] },
          },
        }),
    ).toThrow(/types\.Point\.fields\[0\]\.type must be a Type object/);
  });

  it('callable with missing fuelCost throws', () => {
    expect(
      () =>
        new SpellLang({
          callables: [
            {
              name: 'noop',
              args: [],
              returnType: tNone,
              doc: 'do nothing',
            },
          ],
        }),
    ).toThrow(/callables\[0\]\.fuelCost must be a non-negative finite number/);
  });

  it('callable arg with bad type throws at the right path', () => {
    expect(
      () =>
        new SpellLang({
          callables: [
            {
              name: 'f',
              args: [{ name: 'x', type: 'int' }],
              returnType: tNone,
              fuelCost: 1,
              doc: 'f',
            },
          ],
        }),
    ).toThrow(/callables\[0\]\.args\[0\]\.type must be a Type object/);
  });

  it('bad limit value throws', () => {
    expect(
      () => new SpellLang({ limits: { fuel: -1 } }),
    ).toThrow(/limits\.fuel must be a non-negative finite number/);
  });
});

describe('host: queries (expression callables)', () => {
  it('parse → run with queryImpls: record-typed result flows into state', () => {
    const lang = new SpellLang(QUERY_CONFIG);
    const parsed = lang.parse('let a = getAction()\nstate.count = a.startedTick');
    expect(parsed.ok).toBe(true);
    const result = lang.run(parsed.program!, {
      state: { count: 0 },
      callablesImpl: {},
      queryImpls: {
        getAction: () => ({ type: 'Wander', startedTick: 7, completedTick: null }),
      },
    });
    expect(result.result).toBe('ok');
    expect(result.stateChanged).toBe(true);
    expect(result.state.count).toBe(7);
  });

  it('a query without a registered implementation is invalid-call at run time', () => {
    const lang = new SpellLang(QUERY_CONFIG);
    const parsed = lang.parse('let a = getAction()');
    expect(parsed.ok).toBe(true);
    const result = lang.run(parsed.program!, { callablesImpl: {}, queryImpls: {} });
    expect(result.result).toBe('invalid-call');
    expect(result.error?.message).toContain("No implementation provided for query 'getAction'");
  });

  it('duplicate query name throws', () => {
    expect(
      () =>
        new SpellLang({
          ...QUERY_CONFIG,
          queries: [
            { name: 'getAction', args: [], returnType: tRecord('ActionInfo'), doc: 'one' },
            { name: 'getAction', args: [], returnType: tRecord('ActionInfo'), doc: 'two' },
          ],
        }),
    ).toThrow(/queries\[1\]\.name 'getAction' is declared more than once/);
  });

  it('a query name cannot shadow a fixed builtin', () => {
    expect(
      () =>
        new SpellLang({
          queries: [{ name: 'min', args: [], returnType: tInt, doc: 'shadow attempt' }],
        }),
    ).toThrow(/queries\[0\]\.name 'min' collides with a fixed builtin/);
  });

  it('bad fuelCost throws at the right path', () => {
    expect(
      () =>
        new SpellLang({
          ...QUERY_CONFIG,
          queries: [
            { name: 'getAction', args: [], returnType: tRecord('ActionInfo'), fuelCost: -1, doc: 'x' },
          ],
        }),
    ).toThrow(/queries\[0\]\.fuelCost must be a non-negative finite number/);
  });

  it('an undeclared record return type throws (closed world)', () => {
    expect(
      () =>
        new SpellLang({
          queries: [{ name: 'getAction', args: [], returnType: tRecord('Nope'), doc: 'x' }],
        }),
    ).toThrow(/queries\[0\]\.returnType references undeclared type 'Nope'/);
  });

  it('an undeclared enum arg type throws (closed world)', () => {
    expect(
      () =>
        new SpellLang({
          types: { ActionInfo: ACTION_INFO },
          queries: [
            {
              name: 'find',
              args: [{ name: 'kind', type: tEnum('EntityKind') }],
              returnType: tRecord('ActionInfo'),
              doc: 'x',
            },
          ],
        }),
    ).toThrow(/queries\[0\]\.args\[0\]\.type references undeclared type 'EntityKind'/);
  });

  it('queries must be an array', () => {
    expect(
      () =>
        new SpellLang({
          // @ts-expect-error deliberately wrong shape
          queries: { getAction: { args: [] } },
        }),
    ).toThrow(/SpellLangConfig\.queries must be an array of QueryDecl/);
  });

  it('registerQuery validates references against types declared so far', () => {
    const lang = new SpellLang({ types: { ActionInfo: ACTION_INFO } });
    lang.registerQuery({ name: 'getAction', args: [], returnType: tRecord('ActionInfo'), doc: 'x' });
    expect(lang.queries.map((q) => q.name)).toEqual(['getAction']);
    // duplicate
    expect(() =>
      lang.registerQuery({ name: 'getAction', args: [], returnType: tRecord('ActionInfo'), doc: 'x' }),
    ).toThrow(/Query 'getAction' is already registered/);
    // builtin collision
    expect(() => lang.registerQuery({ name: 'len', args: [], returnType: tInt, doc: 'x' })).toThrow(
      /collides with a fixed builtin/,
    );
    // undeclared type reference
    expect(() =>
      lang.registerQuery({ name: 'other', args: [], returnType: tRecord('Missing'), doc: 'x' }),
    ).toThrow(/references undeclared type 'Missing'/);
    // a type registered later satisfies the reference
    lang.registerType('Later', { kind: 'record', fields: [{ name: 'n', type: tInt }] });
    lang.registerQuery({ name: 'laterQuery', args: [], returnType: tRecord('Later'), doc: 'x' });
    expect(lang.queries.map((q) => q.name)).toEqual(['getAction', 'laterQuery']);
  });
});
