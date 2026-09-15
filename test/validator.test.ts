import { describe, expect, it } from 'vitest';
import { SpellLang } from '../src/host.js';
import type { Type } from '../src/ast.js';
import { tBool, tEnum, tInt, tList, tRecord, tString, type TypeDecl } from '../src/ast.js';

const VOXEL_ENUM: TypeDecl = { kind: 'enum', values: ['AIR', 'DIRT', 'STONE', 'TORCH'] };

const vec3: TypeDecl = {
  kind: 'record',
  fields: [
    { name: 'x', type: tInt },
    { name: 'y', type: tInt },
    { name: 'z', type: tInt },
  ],
};

const spawnOpts: TypeDecl = {
  kind: 'record',
  fields: [
    { name: 'count', type: tInt },
    { name: 'delay', type: { kind: 'optional', inner: tInt } },
    { name: 'mode', type: { kind: 'optional', inner: { kind: 'string' } } },
  ],
};

/** Flattened event union, voxspell-style: presence tests via `e.id != none`. */
const eventDecl: TypeDecl = {
  kind: 'record',
  fields: [
    { name: 'kind', type: tString },
    { name: 'id', type: { kind: 'optional', inner: tString } },
    { name: 'dist', type: { kind: 'optional', inner: { kind: 'float' } } },
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
      {
        name: 'spawnWave',
        args: [{ name: 'opts', type: tRecord('SpawnOpts') }],
        returnType: { kind: 'none' },
        fuelCost: 2,
        doc: 'Spawn a wave.',
        category: 'world',
      },
    ],
    types: {
      VoxelType: VOXEL_ENUM,
      EntityKind: { kind: 'enum', values: ['goblin', 'player'] },
      entity: vec3,
      SpawnOpts: spawnOpts,
      event: eventDecl,
    },
    stateShape: { anger: tInt, awake: tBool, guests: tList(tString) },
    contextShape: {
      player: tRecord('entity'),
      goblins: { kind: 'list', elem: tRecord('entity') } as Type,
      events: tList(tRecord('event')),
      focus: { kind: 'optional', inner: tRecord('entity') } as Type,
    },
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

  it('accepts a record literal with fields in any order and omitted optionals', () => {
    const r = rt.parse('call spawnWave(SpawnOpts { mode: "nightmare", count: 5 })');
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    const r2 = rt.parse('call spawnWave(SpawnOpts { count: 3 })');
    expect(r2.ok).toBe(true);
  });

  it('rejects record literals of unknown record types with suggestions', () => {
    const r = rt.parse('call spawnWave(SpwanOpts { count: 5 })');
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatchObject({
      code: 'unknown-type',
      found: 'SpwanOpts',
    });
    expect(r.errors[0]!.expected).toContain('SpawnOpts');
  });

  it('rejects unknown record fields with declared-name suggestions', () => {
    const r = rt.parse('call spawnWave(SpawnOpts { count: 5, mdoe: "x" })');
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatchObject({
      code: 'unknown-field',
      found: 'mdoe',
    });
    expect(r.errors[0]!.expected).toEqual(['count', 'delay', 'mode']);
  });

  it('rejects record literals missing required fields, listing them', () => {
    const r = rt.parse('call spawnWave(SpawnOpts { mode: "x" })');
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatchObject({
      code: 'missing-fields',
      found: undefined,
    });
    expect(r.errors[0]!.expected).toEqual(['count']);
    expect(r.errors[0]!.message).toContain('count');
  });

  it('rejects duplicate fields and mistyped field values in record literals', () => {
    const dup = rt.parse('call spawnWave(SpawnOpts { count: 5, count: 6 })');
    expect(dup.ok).toBe(false);
    expect(dup.errors.some((e) => e.code === 'duplicate-field')).toBe(true);
    const bad = rt.parse('call spawnWave(SpawnOpts { count: "five" })');
    expect(bad.ok).toBe(false);
    expect(bad.errors[0]).toMatchObject({ code: 'type-mismatch' });
    expect(bad.errors[0]!.message).toContain("field 'count'");
  });
});

describe('validator: P1 additions (concat, list builtins, indexing, none)', () => {
  const rt = makeRuntime();

  it('accepts string concatenation and chaining', () => {
    const r = rt.parse('let s = "a" + "b"\nlet t = s + "c"');
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('rejects `-` on strings and mixed `+` operands', () => {
    expect(rt.parse('let x = "a" - "b"').errors[0]).toMatchObject({ code: 'type-mismatch' });
    expect(rt.parse('let x = "a" + 1').errors[0]).toMatchObject({ code: 'type-mismatch' });
  });

  it('accepts append/len/contains on a list-typed state field', () => {
    const r = rt.parse(
      'state.guests = append(state.guests, "ada")\nlet n = len(state.guests)\nlet b = contains(state.guests, "ada")',
    );
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('rejects append/contains element type mismatches against the bound element type', () => {
    expect(rt.parse('state.guests = append(state.guests, 1)').errors[0]).toMatchObject({
      code: 'type-mismatch',
    });
    expect(rt.parse('let b = contains(state.guests, 2)').errors[0]).toMatchObject({
      code: 'type-mismatch',
    });
  });

  it('rejects append/len/contains on non-lists', () => {
    for (const text of ['let x = append(1, 2)', 'let n = len(1)', 'let b = contains(1, 2)']) {
      const r = rt.parse(text);
      expect(r.ok).toBe(false);
      expect(r.errors[0]).toMatchObject({ code: 'type-mismatch' });
    }
  });

  it('accepts randomInt with int bounds and sqrt with numbers', () => {
    const r = rt.parse('let x = randomInt(1, 6)\nlet y = sqrt(16.0)\nlet z = sqrt(9)');
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('rejects randomInt with float bounds and sqrt with strings', () => {
    expect(rt.parse('let x = randomInt(1.5, 6)').errors[0]).toMatchObject({ code: 'type-mismatch' });
    expect(rt.parse('let y = sqrt("a")').errors[0]).toMatchObject({ code: 'type-mismatch' });
  });

  it('accepts list indexing, nested lists, and index-of-member', () => {
    const r = rt.parse(
      'let g = goblins[0]\nlet c = [[1, 2], [3, 4]]\nlet x = c[1][0]\nlet y = goblins[0].x',
    );
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('rejects indexing a non-list, a float index, and a literal out-of-range index', () => {
    expect(rt.parse('let x = player[0]').errors[0]).toMatchObject({ code: 'type-mismatch' });
    expect(rt.parse('let i = 1.5\nlet x = goblins[i]').errors[0]).toMatchObject({
      code: 'type-mismatch',
    });
    expect(rt.parse('let x = [1, 2][5]').errors[0]).toMatchObject({ code: 'index-out-of-range' });
  });

  it('accepts optional presence tests: optional vs none and none vs none', () => {
    const r = rt.parse('let top = focus == none\nif focus != none {\n  let p = focus\n  stop\n}');
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('accepts optional-field presence tests on flattened event records', () => {
    const r = rt.parse('for e of events {\n  if e.id != none {\n    call setVoxel(0, 0, 0, STONE)\n  }\n}');
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  describe('optional-field narrowing (x != none unwraps x in the branch)', () => {
    // guests: list<string> in stateShape; consumption via the append builtin.
    const src = (cond: string, body: string) =>
      `for e of events {\n  if ${cond} {\n    ${body}\n    stop\n  }\n}`;

    it('unwraps the field for consumption inside the guarded branch', () => {
      const r = rt.parse(src('e.id != none', 'state.guests = append(state.guests, e.id)'));
      expect(r.errors).toEqual([]);
      expect(r.ok).toBe(true);
    });

    it('unwraps when none is on the left side', () => {
      const r = rt.parse(src('none != e.id', 'state.guests = append(state.guests, e.id)'));
      expect(r.errors).toEqual([]);
      expect(r.ok).toBe(true);
    });

    it('unwraps context optionals (focus) for member reads', () => {
      const r = rt.parse('if focus != none {\n  let p = focus\n  call setVoxel(p.x, p.y, p.z, STONE)\n}');
      expect(r.errors).toEqual([]);
      expect(r.ok).toBe(true);
    });

    it('does not unwrap outside the guarded branch', () => {
      const r = rt.parse('let q = focus\ncall setVoxel(q.x, 0, 0, STONE)');
      expect(r.ok).toBe(false);
      expect(r.errors[0]).toMatchObject({ code: 'type-mismatch' });
    });

    it('does not unwrap in the else branch', () => {
      const r = rt.parse(
        'if focus != none {\n  let p = focus\n} else {\n  let q = focus\n  call setVoxel(q.x, 0, 0, STONE)\n}',
      );
      expect(r.ok).toBe(false);
      expect(r.errors[0]).toMatchObject({ code: 'type-mismatch' });
    });

    it('rejects a redundant == none re-test on a narrowed value (dead test)', () => {
      const r = rt.parse('if focus != none {\n  let missing = focus == none\n}');
      expect(r.ok).toBe(false);
      expect(r.errors[0]).toMatchObject({ code: 'type-mismatch' });
    });

    it('a shadowing let keeps its own declared type', () => {
      // Inner binding is a fresh non-optional record; the mask makes the
      // outer narrowing stop at the shadow (defensive: an optional-typed
      // shadow is not expressible with today's builtins).
      const r = rt.parse('if focus != none {\n  let focus = player\n  call setVoxel(focus.x, 0, 0, STONE)\n}');
      expect(r.errors).toEqual([]);
      expect(r.ok).toBe(true);
    });

    it('sibling statements in the branch keep the narrowing', () => {
      const r = rt.parse(
        'if focus != none {\n  for g of goblins {\n    call setVoxel(g.x, 0, 0, STONE)\n  }\n  let p = focus\n  call setVoxel(p.x, p.y, p.z, STONE)\n}',
      );
      expect(r.errors).toEqual([]);
      expect(r.ok).toBe(true);
    });

    it('unwraps through let bindings made inside the guarded branch', () => {
      const r = rt.parse(src('e.id != none', 'let who = e.id\n    state.guests = append(state.guests, who)'));
      expect(r.errors).toEqual([]);
      expect(r.ok).toBe(true);
    });

    it('unwraps across and-chains inside the condition itself', () => {
      // `e.dist != none and e.dist < 6.0` — the right operand of `and` is
      // only evaluated when the left held, so the test unwraps for it.
      const r = rt.parse(
        'for e of events {\n  if e.id != none and e.dist != none and e.dist < 6.0 and contains(state.guests, e.id) == false {\n    state.guests = append(state.guests, e.id)\n    stop\n  }\n}',
      );
      expect(r.errors).toEqual([]);
      expect(r.ok).toBe(true);
    });

    it('does not unwrap across or-chains (left false proves nothing)', () => {
      const r = rt.parse('let b = focus == none or focus.x > 3');
      expect(r.ok).toBe(false);
      expect(r.errors[0]).toMatchObject({ code: 'type-mismatch' });
    });
  });

  it('rejects comparing none with a non-optional value', () => {
    expect(rt.parse('let b = 5 == none').errors[0]).toMatchObject({ code: 'type-mismatch' });
  });
});
