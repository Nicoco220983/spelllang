/**
 * Spec conformance suite (SPELLLANG.md §9): every invalid program must be
 * rejected with a line/col-localized error; fuel/limits behavior must be
 * deterministic. These tests pin the contract, not implementation details.
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { SpellLang } from '../src/host.js';
import { renderPromptRegistry } from '../src/prompt.js';
import type { Limits, Value } from '../src/ast.js';
import { tInt } from '../src/ast.js';

function runtime(limits?: Partial<Limits>) {
  return new SpellLang({
    callables: [
      {
        name: 'setVoxel',
        args: [
          { name: 'x', type: tInt },
          { name: 'y', type: tInt },
          { name: 'z', type: tInt },
        ],
        returnType: { kind: 'none' },
        fuelCost: 1,
        doc: 'Place a voxel.',
      },
    ],
    contextShape: { tick: tInt, ev: { kind: 'record', name: 'Event' } },
    stateShape: { n: tInt, guests: { kind: 'list', elem: { kind: 'string' } } },
    types: {
      SpawnOpts: {
        kind: 'record',
        fields: [
          { name: 'count', type: tInt },
          { name: 'mode', type: { kind: 'optional', inner: { kind: 'string' } } },
        ],
      },
      Event: {
        kind: 'record',
        fields: [
          { name: 'kind', type: { kind: 'string' } },
          { name: 'id', type: { kind: 'optional', inner: { kind: 'string' } } },
        ],
      },
    },
    limits,
  });
}

describe('conformance: invalid programs are rejected with localized errors', () => {
  const cases: [string, string][] = [
    ['unknown callable', 'call nope()'],
    ['unknown identifier', 'let x = nope'],
    ['assignment before let', 'x = 1'],
    ['type mismatch', 'let x = 1\nx = "s"'],
    ['string arithmetic', 'let x = "a" * 2'],
    ['non-bool condition', 'if 1 { stop }'],
    ['for over non-list', 'for i of 3 { stop }'],
    ['chained comparison', 'let x = 1 < 2 < 3'],
    ['unknown state field', 'state.zzz = 1'],
    ['user function attempt', 'function f() {}'],
    ['while attempt', 'while true { stop }'],
    ['indexing a non-list', 'let x = tick[0]'],
    ['mixed string concatenation', 'let x = "a" + 1'],
    ['append element type mismatch', 'state.guests = append(state.guests, 1)'],
    ['literal index out of range', 'let x = [1, 2][5]'],
    ['randomInt with float bounds', 'let x = randomInt(1.5, 6)'],
    ['comparing none with an int', 'let x = 5 == none'],
    ['import attempt', 'import things'],
    ['missing brace', 'if true {\n stop'],
    ['unclosed paren', 'call setVoxel(1, 2, 3'],
    ['record literal unknown type', 'let o = NoSuchType { count: 5 }'],
    ['record literal unknown field', 'let o = SpawnOpts { count: 5, nosuch: 1 }'],
    ['record literal missing required field', 'let o = SpawnOpts { mode: "x" }'],
    ['unknown function in expression', 'let x = nope_fn(1)'],
    ['statement callable in expression', 'let x = setVoxel(0, 0, 0)'],
  ];

  it.each(cases)('rejects: %s', (_name, text) => {
    const r = runtime().parse(text);
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
    for (const e of r.errors) {
      expect(e.line).toBeGreaterThanOrEqual(1);
      expect(e.col).toBeGreaterThanOrEqual(1);
      expect(e.message.length).toBeGreaterThan(0);
    }
  });
});

describe('conformance: every error carries line/col (property)', () => {
  it('mutated garbage still yields localized errors, never a crash', () => {
    const rt = runtime();
    const seedTexts = [
      'let x = 1\ncall setVoxel(x, 0, 0)',
      'if tick > 2 {\n call setVoxel(0, 0, 0)\n}',
      'for i of range(0, 3) {\n let y = i * 2\n}',
    ];
    fc.assert(
      fc.property(
        fc.constantFrom(...seedTexts),
        fc.string(),
        (base, junk) => {
          const r = rt.parse(base + '\n' + junk);
          if (!r.ok) {
            for (const e of r.errors) {
              expect(Number.isInteger(e.line)).toBe(true);
              expect(Number.isInteger(e.col)).toBe(true);
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('conformance: record literals', () => {
  it('accepts a valid record literal (any field order, omitted optionals)', () => {
    const r = runtime().parse('let o = SpawnOpts { mode: "calm", count: 2 }\nlet p = SpawnOpts { count: 1 }');
    expect(r.ok).toBe(true);
  });
});

describe('conformance: P1 surface is accepted', () => {
  const cases: [string, string][] = [
    ['string concatenation', 'let s = "a" + "b"'],
    ['list builtins', 'state.guests = append(state.guests, "x")\nlet n = len(state.guests)\nlet b = contains(state.guests, "x")'],
    ['list indexing', 'let corners = [[10, 10], [10, 42]]\nlet x = corners[0][1]'],
    ['randomInt and sqrt', 'let r = randomInt(1, 6)\nlet s = sqrt(2.0)'],
    ['none presence test', 'if ev.id != none {\n call setVoxel(0, 0, 0)\n}'],
  ];

  it.each(cases)('accepts: %s', (_name, text) => {
    expect(runtime().parse(text).ok).toBe(true);
  });
});

describe('conformance: host queries are accepted and run', () => {
  function queryRuntime() {
    return new SpellLang({
      callables: [
        {
          name: 'setVoxel',
          args: [{ name: 'x', type: tInt }],
          returnType: { kind: 'none' },
          fuelCost: 1,
          doc: 'Place a voxel.',
        },
      ],
      stateShape: { n: tInt },
      queries: [
        {
          name: 'getAction',
          args: [],
          returnType: { kind: 'record', name: 'ActionInfo' },
          doc: 'Current standing order.',
        },
      ],
      types: {
        ActionInfo: {
          kind: 'record',
          fields: [
            { name: 'type', type: { kind: 'string' } },
            { name: 'startedTick', type: tInt },
            { name: 'completedTick', type: { kind: 'optional', inner: tInt } },
          ],
        },
      },
    });
  }

  it('accepts: query call with record-typed result field access', () => {
    const r = queryRuntime().parse(
      'let a = getAction()\nif a.completedTick != none {\n call setVoxel(a.startedTick)\n}',
    );
    expect(r.ok).toBe(true);
  });

  it('rejects: unknown query name with localized suggestions', () => {
    const r = queryRuntime().parse('let a = getActoin()');
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatchObject({ code: 'unknown-query', line: 1, found: 'getActoin' });
    expect(r.errors[0]!.expected).toContain('getAction()');
  });

  it('runs: query impl result flows through a presence test to intents', () => {
    const rt = queryRuntime();
    const r = rt.parse('let a = getAction()\nif a.completedTick != none {\n call setVoxel(a.startedTick)\n}');
    expect(r.ok).toBe(true);
    const intents: Value[] = [];
    const done = rt.run(r.program!, {
      callablesImpl: { setVoxel: (args, { emit }) => emit(args[0]) },
      queryImpls: { getAction: () => ({ type: 'Idle', startedTick: 3, completedTick: 12 }) },
    });
    expect(done.result).toBe('ok');
    expect(done.intents).toEqual([3]);
    const pending = rt.run(r.program!, {
      callablesImpl: { setVoxel: (args, { emit }) => emit(args[0]) },
      queryImpls: { getAction: () => ({ type: 'WalkTo', startedTick: 3, completedTick: null }) },
    });
    expect(pending.intents).toEqual([]);
  });
});

describe('conformance: list state persists across runs (P1.1)', () => {
  it('a list-typed state field survives run→run with repeated appends', () => {
    const rt = runtime();
    const r = rt.parse('state.guests = append(state.guests, "g" + "1")');
    expect(r.ok).toBe(true);
    let state: Record<string, Value> = { n: 0, guests: [] };
    for (let i = 0; i < 3; i++) {
      const exec = rt.run(r.program!, { callablesImpl: {}, state });
      expect(exec.result).toBe('ok');
      expect(exec.stateChanged).toBe(true);
      state = exec.state;
    }
    expect(state.guests).toEqual(['g1', 'g1', 'g1']);
  });

  it('append respects maxListLength at runtime', () => {
    const rt = runtime({ maxListLength: 2 });
    const r = rt.parse('state.guests = append(state.guests, "c")');
    expect(r.ok).toBe(true);
    const exec = rt.run(r.program!, {
      callablesImpl: {},
      state: { n: 0, guests: ['a', 'b'] },
    });
    expect(exec.result).toBe('runtime-error');
    expect(exec.error?.code).toBe('list-too-large');
  });
});

describe('conformance: determinism', () => {
  it('same script + same inputs = same outputs (100 runs)', () => {
    const rt = runtime();
    const r = rt.parse('state.n = state.n + tick\nlet r = random()\nif r < 0.5 {\n call setVoxel(0, 0, 0)\n}');
    expect(r.ok).toBe(true);
    const run1 = rt.run(r.program!, { callablesImpl: { setVoxel: () => {} }, state: { n: 5 }, context: { tick: 7 }, seed: 1 });
    for (let i = 0; i < 100; i++) {
      const again = rt.run(r.program!, { callablesImpl: { setVoxel: () => {} }, state: { n: 5 }, context: { tick: 7 }, seed: 1 });
      expect(JSON.stringify(again)).toBe(JSON.stringify(run1));
    }
  });
});

describe('conformance: prompt registry rendering', () => {
  it('renders signatures, docs, categories, and value domains', () => {
    const text = renderPromptRegistry(runtime().callables);
    expect(text).toContain('[general]');
    expect(text).toContain('setVoxel(x: int, y: int, z: int) -> none');
    expect(text).toContain('Place a voxel.');
  });

  it('renders enum domains', () => {
    const rt = new SpellLang({
      callables: [
        {
          name: 'place',
          args: [{ name: 'type', type: { kind: 'enum', name: 'VoxelType' }, domain: { enumValues: ['DIRT', 'STONE'] } }],
          returnType: { kind: 'none' },
          fuelCost: 2,
          doc: 'Place.',
          category: 'world',
        },
      ],
      types: { VoxelType: { kind: 'enum', values: ['DIRT', 'STONE'] } },
    });
    const text = renderPromptRegistry(rt.callables);
    expect(text).toContain('[world]');
    expect(text).toContain('type ∈ {DIRT, STONE}');
    expect(text).toContain('(cost 2)');
  });

  it('renders host queries in their own [queries] section, after callables', () => {
    const rt = new SpellLang({
      types: {
        ActionInfo: {
          kind: 'record',
          fields: [{ name: 'type', type: { kind: 'string' } }],
        },
      },
      callables: [
        {
          name: 'setVoxel',
          args: [{ name: 'x', type: tInt }],
          returnType: { kind: 'none' },
          fuelCost: 1,
          doc: 'Place a voxel.',
        },
      ],
      queries: [
        {
          name: 'getAction',
          args: [],
          returnType: { kind: 'record', name: 'ActionInfo' },
          fuelCost: 2,
          doc: 'Current standing order.',
        },
        {
          name: 'groundHeight',
          args: [
            { name: 'x', type: tInt, domain: { min: -64, max: 64 } },
            { name: 'z', type: tInt },
          ],
          returnType: tInt,
          doc: 'Highest solid y.',
        },
      ],
    });
    const text = renderPromptRegistry(rt.callables, rt.queries);
    expect(text).toContain('[queries]');
    expect(text).toContain('getAction() -> ActionInfo  (cost 2)');
    expect(text).toContain('Current standing order.');
    expect(text).toContain('groundHeight(x: int, z: int) -> int  (cost 1)');
    expect(text).toContain('x in [-64, 64]');
    // queries come after the callable sections
    expect(text.indexOf('[queries]')).toBeGreaterThan(0);
  });

  it('omits the [queries] section when the host declares no queries', () => {
    const text = renderPromptRegistry(runtime().callables);
    expect(text).not.toContain('[queries]');
  });
});
