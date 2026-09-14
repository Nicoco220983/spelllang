/**
 * Host API tests: constructor config validation (fail fast on malformed
 * host input) plus the basic embed flow.
 */

import { describe, expect, it } from 'vitest';
import { tEnum, tInt, tNone } from '../src/ast.js';
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
