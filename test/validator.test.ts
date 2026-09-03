import { describe, expect, it } from 'vitest';
import { SpellLang } from '../src/host.js';
import type { Type } from '../src/ast.js';
import { tBool, tEnum, tInt, tRecord, type TypeDecl } from '../src/ast.js';

const VOXEL_ENUM: TypeDecl = { kind: 'enum', values: ['AIR', 'DIRT', 'STONE', 'TORCH'] };

const vec3: TypeDecl = {
  kind: 'record',
  fields: [
    { name: 'x', type: tInt },
    { name: 'y', type: tInt },
    { name: 'z', type: tInt },
  ],
};

function makeRuntime() {
  return new SpellLang({
    callables: [
      {
        name: 'setVoxel',
        args: [
          { name: 'x', type: tInt, domain: { min: -64, max: 64 } },
          { name: 'y', type: tInt, domain: { min: -64, max: 64 } },
          { name: 'z', type: tInt, domain: { min: -64, max: 64 } },
          { name: 'type', type: tEnum('VoxelType'), domain: { enumValues: ['AIR', 'DIRT', 'STONE'] } },
        ],
        returnType: { kind: 'none' },
        fuelCost: 1,
        doc: 'Place a single voxel.',
        category: 'world',
      },
      {
        name: 'nearest',
        args: [{ name: 'kind', type: tEnum('EntityKind'), domain: { enumValues: ['goblin', 'player'] } }],
        returnType: { kind: 'optional', inner: tRecord('entity') },
        fuelCost: 4,
        doc: 'Nearest entity of a kind, or none.',
        category: 'query',
      },
    ],
    types: {
      VoxelType: VOXEL_ENUM,
      EntityKind: { kind: 'enum', values: ['goblin', 'player'] },
      entity: vec3,
    },
    stateShape: { anger: tInt, awake: tBool },
    contextShape: { player: tRecord('entity'), goblins: { kind: 'list', elem: tRecord('entity') } as Type },
  });
}

describe('validator', () => {
  const rt = makeRuntime();

  it('accepts a valid program', () => {
    const r = rt.parse(`let p = player
if distance(p, player) < 5 {
  call setVoxel(0, 0, 0, STONE)
}`);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('rejects unknown callables with candidates', () => {
    const r = rt.parse('call setVoxelz(0, 0, 0, STONE)');
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatchObject({
      code: 'unknown-callable',
      line: 1,
      found: 'setVoxelz',
    });
    expect(r.errors[0]!.expected).toContain('setVoxel');
  });

  it('rejects enum values out of domain (statically)', () => {
    const r = rt.parse('call setVoxel(0, 0, 0, TORCH)');
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatchObject({ code: 'enum-out-of-domain', line: 1 });
  });

  it('rejects out-of-range numeric args', () => {
    const r = rt.parse('call setVoxel(0, 0, 999, STONE)');
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatchObject({ code: 'out-of-range' });
  });

  it('rejects arity mismatches', () => {
    const r = rt.parse('call setVoxel(0, 0, STONE)');
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatchObject({ code: 'arity-mismatch' });
  });

  it('rejects type mismatches in arithmetic', () => {
    const r = rt.parse('let x = "a" + 1');
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatchObject({ code: 'type-mismatch' });
  });

  it('rejects assignment before declaration', () => {
    const r = rt.parse('x = 5');
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatchObject({ code: 'unknown-identifier' });
  });

  it('rejects let rebinding to a different type', () => {
    const r = rt.parse('let x = 1\nx = "hello"');
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatchObject({ code: 'type-mismatch' });
  });

  it('rejects unknown state fields', () => {
    const r = rt.parse('state.fury = 1');
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatchObject({ code: 'unknown-state-field' });
  });

  it('rejects unknown context values and unknown bare identifiers', () => {
    const r = rt.parse('let x = dragons');
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatchObject({ code: 'unknown-identifier' });
  });

  it('rejects non-bool conditions', () => {
    const r = rt.parse('if 5 {\n stop\n}');
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatchObject({ code: 'type-mismatch' });
  });

  it('rejects for over non-list', () => {
    const r = rt.parse('for i of 5 {\n stop\n}');
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatchObject({ code: 'type-mismatch' });
  });

  it('rejects % on floats', () => {
    const r = rt.parse('let x = 5.0 % 2');
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatchObject({ code: 'type-mismatch' });
  });

  it('rejects unknown record fields', () => {
    const r = rt.parse('let d = player.nosuchfield');
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatchObject({ code: 'unknown-field' });
  });

  it('collects multiple errors in one pass', () => {
    const r = rt.parse('let x = "a" + 1\ny = 2\ncall nope()');
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThanOrEqual(3);
  });

  it('accepts state reads and writes with matching types', () => {
    const r = rt.parse('state.anger = state.anger + 1\nstate.awake = state.anger < 5');
    expect(r.errors).toEqual([]);
  });

  it('accepts distance on records with x,y,z', () => {
    const r = rt.parse('let d = distance(player, goblins)');
    // goblins is a list — should fail; distance(player, ???) needs two vecs
    expect(r.ok).toBe(false);
    const ok = rt.parse('let d = distance(player, player)');
    expect(ok.ok).toBe(true);
    void r;
  });
});
