/**
 * Spec conformance suite (SPELLLANG.md §9): every invalid program must be
 * rejected with a line/col-localized error; fuel/limits behavior must be
 * deterministic. These tests pin the contract, not implementation details.
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { SpellLang } from '../src/host.js';
import { renderPromptRegistry } from '../src/prompt.js';
import { tInt } from '../src/ast.js';

function runtime() {
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
    contextShape: { tick: tInt },
    stateShape: { n: tInt },
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
    ['indexing attempt', 'let x = tick[0]'],
    ['import attempt', 'import things'],
    ['missing brace', 'if true {\n stop'],
    ['unclosed paren', 'call setVoxel(1, 2, 3'],
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
});
