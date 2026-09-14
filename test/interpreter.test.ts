import { describe, expect, it } from 'vitest';
import { SpellLang } from '../src/host.js';
import type { Value } from '../src/ast.js';
import { tInt, tList, tString } from '../src/ast.js';

function makeRuntime(limits?: { fuel?: number; maxResults?: number; maxListLength?: number }) {
  const placed: Value[] = [];
  const rt = new SpellLang({
    callables: [
      {
        name: 'setVoxel',
        args: [
          { name: 'x', type: tInt },
          { name: 'y', type: tInt },
          { name: 'z', type: tInt },
          { name: 'type', type: { kind: 'enum', name: 'VoxelType' } },
        ],
        returnType: { kind: 'none' },
        fuelCost: 1,
        doc: 'Place a single voxel.',
      },
      {
        name: 'boom',
        args: [],
        returnType: { kind: 'none' },
        fuelCost: 0,
        doc: 'Throws inside the implementation (host bug simulation).',
      },
      {
        name: 'badReturn',
        args: [],
        returnType: tInt,
        fuelCost: 1,
        doc: 'Returns the wrong shape (host bug simulation).',
      },
      {
        name: 'shout',
        args: [{ name: 'msg', type: { kind: 'string' } }],
        returnType: { kind: 'none' },
        fuelCost: 1,
        doc: 'Emits an intent.',
      },
      {
        name: 'spawnWave',
        args: [{ name: 'opts', type: { kind: 'record', name: 'SpawnOpts' } }],
        returnType: { kind: 'none' },
        fuelCost: 1,
        doc: 'Spawn a wave from an options record.',
      },
    ],
    types: {
      VoxelType: { kind: 'enum', values: ['STONE', 'TORCH'] },
      SpawnOpts: {
        kind: 'record',
        fields: [
          { name: 'count', type: tInt },
          { name: 'delay', type: { kind: 'optional', inner: tInt } },
          { name: 'mode', type: { kind: 'optional', inner: { kind: 'string' } } },
        ],
      },
    },
    stateShape: { counter: tInt, guests: tList(tString) },
    contextShape: { base: tInt, ids: tList(tString) },
    limits,
  });
  const impl = {
    setVoxel: (args: Value[]) => {
      placed.push(args);
    },
    spawnWave: (args: Value[]) => {
      placed.push(args);
    },
    boom: () => {
      throw new Error('kaput');
    },
    badReturn: () => 'not a number' as Value,
    shout: (args: Value[], h: { emit: (i: Value) => void }) => {
      h.emit({ msg: args[0] });
    },
  };
  return { rt, impl, placed };
}

describe('interpreter', () => {
  it('runs a generation script and collects effects', () => {
    const { rt, impl, placed } = makeRuntime();
    const r = rt.parse('for i of range(0, 3) {\n  call setVoxel(i, 0, 0, STONE)\n}');
    expect(r.ok).toBe(true);
    const exec = rt.run(r.program!, { callablesImpl: impl });
    expect(exec.result).toBe('ok');
    expect(placed).toEqual([
      [0, 0, 0, 'STONE'],
      [1, 0, 0, 'STONE'],
      [2, 0, 0, 'STONE'],
    ]);
  });

  it('reports out-of-fuel at a node boundary, deterministically', () => {
    const { rt, impl } = makeRuntime({ fuel: 10 });
    const r = rt.parse('for i of range(0, 100) {\n  call setVoxel(i, 0, 0, STONE)\n}');
    expect(r.ok).toBe(true);
    const e1 = rt.run(r.program!, { callablesImpl: impl });
    const e2 = rt.run(r.program!, { callablesImpl: impl });
    expect(e1.result).toBe('out-of-fuel');
    expect(e2.result).toBe('out-of-fuel');
    expect(e1.fuelUsed).toBe(e2.fuelUsed);
    expect(e1.intents).toEqual(e2.intents);
  });

  it('is deterministic: same seed, same random sequence', () => {
    const { rt, impl } = makeRuntime();
    const r = rt.parse('state.counter = floor(random() * 1000000)');
    expect(r.ok).toBe(true);
    const e1 = rt.run(r.program!, { callablesImpl: impl, seed: 42, state: { counter: 0 } });
    const e2 = rt.run(r.program!, { callablesImpl: impl, seed: 42, state: { counter: 0 } });
    const e3 = rt.run(r.program!, { callablesImpl: impl, seed: 43, state: { counter: 0 } });
    expect(e1.state).toEqual(e2.state);
    expect(e1.state).not.toEqual(e3.state);
  });

  it('persists state across runs when the host passes it back', () => {
    const { rt, impl } = makeRuntime();
    const r = rt.parse('state.counter = state.counter + 1');
    expect(r.ok).toBe(true);
    const e1 = rt.run(r.program!, { callablesImpl: impl, state: { counter: 0 } });
    const e2 = rt.run(r.program!, { callablesImpl: impl, state: e1.state });
    const e3 = rt.run(r.program!, { callablesImpl: impl, state: e2.state });
    expect(e3.state.counter).toBe(3);
  });

  it('does not mutate the host-provided state object (deep copy boundary)', () => {
    const { rt, impl } = makeRuntime();
    const r = rt.parse('state.counter = 99');
    expect(r.ok).toBe(true);
    const hostState = { counter: 0 };
    rt.run(r.program!, { callablesImpl: impl, state: hostState });
    expect(hostState.counter).toBe(0);
  });

  it('runs stop immediately', () => {
    const { rt, impl, placed } = makeRuntime();
    const r = rt.parse('call setVoxel(0, 0, 0, STONE)\nstop\ncall setVoxel(1, 0, 0, STONE)');
    expect(r.ok).toBe(true);
    const exec = rt.run(r.program!, { callablesImpl: impl });
    expect(exec.result).toBe('ok');
    expect(placed).toHaveLength(1);
  });

  it('short-circuits and/or without evaluating the right side', () => {
    const { rt, impl } = makeRuntime();
    // 1/0 would be a runtime error if evaluated
    const r = rt.parse('let a = false and (1 / 0 > 0)\nlet b = true or (1 / 0 > 0)');
    expect(r.ok).toBe(true);
    const exec = rt.run(r.program!, { callablesImpl: impl });
    expect(exec.result).toBe('ok');
  });

  it('division by zero is a runtime-error', () => {
    const { rt, impl } = makeRuntime();
    const r = rt.parse('let x = 1 / 0');
    expect(r.ok).toBe(true);
    const exec = rt.run(r.program!, { callablesImpl: impl });
    expect(exec.result).toBe('runtime-error');
    expect(exec.error?.code).toBe('division-by-zero');
  });

  it('range beyond maxListLength is a runtime-error', () => {
    const { rt, impl } = makeRuntime({ maxListLength: 10 });
    const r = rt.parse('for i of range(0, 50) {\n stop\n}');
    expect(r.ok).toBe(true);
    const exec = rt.run(r.program!, { callablesImpl: impl });
    expect(exec.result).toBe('runtime-error');
    expect(exec.error?.code).toBe('list-too-large');
  });

  it('missing callable implementation is invalid-call', () => {
    const { rt } = makeRuntime();
    const r = rt.parse('call setVoxel(0, 0, 0, STONE)');
    expect(r.ok).toBe(true);
    const exec = rt.run(r.program!, { callablesImpl: {} });
    expect(exec.result).toBe('invalid-call');
  });

  it('a throwing implementation is invalid-call (host bug), not runtime-error', () => {
    const { rt, impl } = makeRuntime();
    const r = rt.parse('call boom()');
    expect(r.ok).toBe(true);
    const exec = rt.run(r.program!, { callablesImpl: impl });
    expect(exec.result).toBe('invalid-call');
  });

  it('a wrong-shape return is invalid-call', () => {
    const { rt, impl } = makeRuntime();
    const r = rt.parse('call badReturn()');
    expect(r.ok).toBe(true);
    const exec = rt.run(r.program!, { callablesImpl: impl });
    expect(exec.result).toBe('invalid-call');
  });

  it('enforces maxResults on intents', () => {
    const { rt, impl } = makeRuntime({ maxResults: 3 });
    const r = rt.parse('for i of range(0, 10) {\n  call shout("hi")\n}');
    expect(r.ok).toBe(true);
    const exec = rt.run(r.program!, { callablesImpl: impl });
    expect(exec.result).toBe('runtime-error');
    expect(exec.error?.code).toBe('too-many-results');
    expect(exec.intents).toHaveLength(3);
  });

  it('context values are readable, loop vars are scoped', () => {
    const { rt, impl, placed } = makeRuntime();
    const r = rt.parse('for i of range(0, 2) {\n  call setVoxel(base + i, 0, 0, TORCH)\n}');
    expect(r.ok).toBe(true);
    const exec = rt.run(r.program!, { callablesImpl: impl, context: { base: 10 } });
    expect(exec.result).toBe('ok');
    expect(placed).toEqual([
      [10, 0, 0, 'TORCH'],
      [11, 0, 0, 'TORCH'],
    ]);
  });

  it('evaluates record literals, filling omitted optional fields with none', () => {
    const { rt, impl, placed } = makeRuntime();
    const r = rt.parse('call spawnWave(SpawnOpts { mode: "nightmare", count: 5 })');
    expect(r.ok).toBe(true);
    const exec = rt.run(r.program!, { callablesImpl: impl });
    expect(exec.result).toBe('ok');
    expect(placed).toEqual([[{ count: 5, delay: null, mode: 'nightmare' }]]);
  });

  it('fills all omitted optional fields with none', () => {
    const { rt, impl, placed } = makeRuntime();
    const r = rt.parse('call spawnWave(SpawnOpts { count: 3 })');
    expect(r.ok).toBe(true);
    const exec = rt.run(r.program!, { callablesImpl: impl });
    expect(exec.result).toBe('ok');
    expect(placed).toEqual([[{ count: 3, delay: null, mode: null }]]);
  });

  it('round is ties-away-from-zero', () => {
    const { rt, impl } = makeRuntime();
    const r = rt.parse('let a = round(0.5)\nlet b = round(-0.5)');
    expect(r.ok).toBe(true);
    const exec = rt.run(r.program!, { callablesImpl: impl });
    // last two lets shadow; check via state? use arithmetic instead
    void exec;
    const r2 = rt.parse('state.counter = round(0.5) + round(-0.5)');
    const e2 = rt.run(r2.program!, { callablesImpl: impl, state: { counter: 0 } });
    expect(e2.state.counter).toBe(1 + -1);
  });
});

describe('interpreter: P1 additions', () => {
  it('concatenates strings with +', () => {
    const { rt, impl } = makeRuntime();
    const r = rt.parse('call shout("Welcome, " + "Ada" + "!")');
    expect(r.ok).toBe(true);
    const exec = rt.run(r.program!, { callablesImpl: impl });
    expect(exec.result).toBe('ok');
    expect(exec.intents).toEqual([{ msg: 'Welcome, Ada!' }]);
  });

  it('append returns a new list and leaves the input unchanged', () => {
    const { rt, impl } = makeRuntime();
    const r = rt.parse('let xs = [1, 2]\nlet ys = append(xs, 3)\nstate.counter = len(xs) * 10 + len(ys)');
    expect(r.ok).toBe(true);
    const exec = rt.run(r.program!, { callablesImpl: impl, state: { counter: 0 } });
    expect(exec.result).toBe('ok');
    expect(exec.state.counter).toBe(23);
  });

  it('append honors maxListLength at runtime', () => {
    const { rt, impl } = makeRuntime({ maxListLength: 2 });
    const r = rt.parse('state.guests = append(state.guests, "c")');
    expect(r.ok).toBe(true);
    const exec = rt.run(r.program!, { callablesImpl: impl, state: { counter: 0, guests: ['a', 'b'] } });
    expect(exec.result).toBe('runtime-error');
    expect(exec.error?.code).toBe('list-too-large');
  });

  it('contains finds values by equality and misses absent ones', () => {
    const { rt, impl } = makeRuntime();
    const r = rt.parse(
      'if contains([1, 2, 3], 2) {\n  state.counter = 1\n}\nif contains([1, 2, 3], 9) {\n  state.counter = 2\n}',
    );
    expect(r.ok).toBe(true);
    const exec = rt.run(r.program!, { callablesImpl: impl, state: { counter: 0 } });
    expect(exec.result).toBe('ok');
    expect(exec.state.counter).toBe(1);
  });

  it('len reports list length (0 when empty)', () => {
    const { rt, impl } = makeRuntime();
    const r = rt.parse('state.counter = len([]) + len(ids)');
    expect(r.ok).toBe(true);
    const exec = rt.run(r.program!, { callablesImpl: impl, context: { base: 0, ids: ['a', 'b', 'c'] } });
    expect(exec.state.counter).toBe(3);
  });

  it('reads list elements by index, including nested lists', () => {
    const { rt, impl } = makeRuntime();
    const r = rt.parse('let c = [[10, 10], [10, 42]]\nstate.counter = c[1][1] + c[0][0]');
    expect(r.ok).toBe(true);
    const exec = rt.run(r.program!, { callablesImpl: impl, state: { counter: 0 } });
    expect(exec.result).toBe('ok');
    expect(exec.state.counter).toBe(52);
  });

  it('index out of range is a runtime-error (too high and negative)', () => {
    const { rt, impl } = makeRuntime();
    const high = rt.parse('let xs = [1]\nstate.counter = xs[3]');
    const e1 = rt.run(high.program!, { callablesImpl: impl, state: { counter: 0 } });
    expect(e1.result).toBe('runtime-error');
    expect(e1.error?.code).toBe('index-out-of-range');
    const neg = rt.parse('let xs = [1]\nlet i = 0 - 1\nstate.counter = xs[i]');
    const e2 = rt.run(neg.program!, { callablesImpl: impl, state: { counter: 0 } });
    expect(e2.result).toBe('runtime-error');
    expect(e2.error?.code).toBe('index-out-of-range');
  });

  it('randomInt is deterministic per seed and stays within inclusive bounds', () => {
    const { rt, impl } = makeRuntime();
    const r = rt.parse('for i of range(0, 500) {\n  state.counter = randomInt(1, 6)\n}');
    expect(r.ok).toBe(true);
    const e1 = rt.run(r.program!, { callablesImpl: impl, seed: 42, state: { counter: 0 } });
    const e2 = rt.run(r.program!, { callablesImpl: impl, seed: 42, state: { counter: 0 } });
    expect(e1.state).toEqual(e2.state);
    expect(e1.state.counter).toBeGreaterThanOrEqual(1);
    expect(e1.state.counter).toBeLessThanOrEqual(6);
  });

  it('randomInt with min > max is a runtime-error', () => {
    const { rt, impl } = makeRuntime();
    const r = rt.parse('state.counter = randomInt(6, 1)');
    expect(r.ok).toBe(true);
    const exec = rt.run(r.program!, { callablesImpl: impl, state: { counter: 0 } });
    expect(exec.result).toBe('runtime-error');
    expect(exec.error?.code).toBe('invalid-range');
  });

  it('sqrt computes square roots', () => {
    const { rt, impl } = makeRuntime();
    const r = rt.parse('state.counter = round(sqrt(2) * 100)');
    expect(r.ok).toBe(true);
    const exec = rt.run(r.program!, { callablesImpl: impl, state: { counter: 0 } });
    expect(exec.state.counter).toBe(141);
  });

  it('stateChanged is false when no state field was assigned; state comes back by reference', () => {
    const { rt, impl } = makeRuntime();
    const r = rt.parse('call shout("hi")');
    expect(r.ok).toBe(true);
    const hostState = { counter: 0, guests: [] as Value[] };
    const exec = rt.run(r.program!, { callablesImpl: impl, state: hostState });
    expect(exec.result).toBe('ok');
    expect(exec.stateChanged).toBe(false);
    expect(exec.state).toBe(hostState);
  });

  it('stateChanged is true after an assignment; the input record is not mutated', () => {
    const { rt, impl } = makeRuntime();
    const r = rt.parse('state.counter = 99');
    expect(r.ok).toBe(true);
    const hostState = { counter: 0, guests: [] as Value[] };
    const exec = rt.run(r.program!, { callablesImpl: impl, state: hostState });
    expect(exec.stateChanged).toBe(true);
    expect(exec.state).not.toBe(hostState);
    expect(hostState.counter).toBe(0);
    expect(exec.state.counter).toBe(99);
  });

  it('error stack traces carry source locations, innermost frame first', () => {
    const { rt, impl } = makeRuntime();
    const r = rt.parse('for i of range(0, 3) {\n  if i == 1 {\n    let x = 1 / 0\n  }\n}');
    expect(r.ok).toBe(true);
    const exec = rt.run(r.program!, { callablesImpl: impl });
    expect(exec.result).toBe('runtime-error');
    expect(exec.error?.code).toBe('division-by-zero');
    expect(exec.error?.stack).toEqual([
      { line: 3, col: 5, at: "let 'x'" },
      { line: 2, col: 3, at: 'if' },
      { line: 1, col: 1, at: "for 'i'" },
    ]);
  });

  it('out-of-fuel carries an error with a statement stack', () => {
    const { rt, impl } = makeRuntime({ fuel: 5 });
    const r = rt.parse('for i of range(0, 100) {\n  call shout("x")\n}');
    expect(r.ok).toBe(true);
    const exec = rt.run(r.program!, { callablesImpl: impl });
    expect(exec.result).toBe('out-of-fuel');
    expect(exec.error?.code).toBe('out-of-fuel');
    expect(exec.error?.stack?.[0]).toMatchObject({ line: 2, col: 3, at: "call 'shout'" });
    expect(exec.error?.stack?.at(-1)).toMatchObject({ line: 1, col: 1, at: "for 'i'" });
  });
});
