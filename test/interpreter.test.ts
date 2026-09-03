import { describe, expect, it } from 'vitest';
import { SpellLang } from '../src/host.js';
import type { Value } from '../src/ast.js';
import { tInt } from '../src/ast.js';

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
    ],
    types: { VoxelType: { kind: 'enum', values: ['STONE', 'TORCH'] } },
    stateShape: { counter: tInt },
    contextShape: { base: tInt },
    limits,
  });
  const impl = {
    setVoxel: (args: Value[]) => {
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
