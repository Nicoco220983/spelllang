/**
 * Task suite for the LLM eval harness (SPELLLANG.md §7).
 *
 * Each task: a natural-language ask, one or more invocations (state is
 * threaded across runs), a semantic checker over the resulting voxel world,
 * and a reference solution used to self-check the harness without an API
 * key. Checkers compare the world state (set of voxels), never intent
 * shapes — building a box with setVoxels or an equivalent loop is equally
 * correct.
 */

import type { CallableDecl, ContextShape, StateShape } from '../../src/ast.js';
import { tEnum, tInt, tString } from '../../src/ast.js';
import { SpellLang } from '../../src/host.js';
import { voxelKey, type EvalTask, type RunOutcome, type Verdict } from './harness.js';

// ---------------------------------------------------------------------------
// Reference voxel-world host registry
// ---------------------------------------------------------------------------

export const VOXEL_TYPES = [
  'STONE',
  'DIRT',
  'PLANKS',
  'WOOD',
  'TORCH',
  'AIR',
  'FLOWER_RED',
  'FLOWER_BLUE',
] as const;

export const CALLABLES: CallableDecl[] = [
  {
    name: 'setVoxel',
    args: [
      { name: 'x', type: tInt, domain: { min: -64, max: 64 } },
      { name: 'y', type: tInt, domain: { min: 0, max: 64 } },
      { name: 'z', type: tInt, domain: { min: -64, max: 64 } },
      {
        name: 'type',
        type: tEnum('VoxelType'),
        domain: { enumValues: [...VOXEL_TYPES] },
      },
    ],
    returnType: { kind: 'none' },
    fuelCost: 1,
    doc: 'Place one voxel of the given type.',
    category: 'world',
  },
  {
    name: 'setVoxels',
    args: [
      { name: 'x1', type: tInt, domain: { min: -64, max: 64 } },
      { name: 'y1', type: tInt, domain: { min: 0, max: 64 } },
      { name: 'z1', type: tInt, domain: { min: -64, max: 64 } },
      { name: 'x2', type: tInt, domain: { min: -64, max: 64 } },
      { name: 'y2', type: tInt, domain: { min: 0, max: 64 } },
      { name: 'z2', type: tInt, domain: { min: -64, max: 64 } },
      {
        name: 'type',
        type: tEnum('VoxelType'),
        domain: { enumValues: [...VOXEL_TYPES] },
      },
    ],
    returnType: { kind: 'none' },
    fuelCost: 8,
    doc: 'Fill an inclusive box (from x1,y1,z1 to x2,y2,z2) with a voxel type.',
    category: 'world',
  },
  {
    name: 'say',
    args: [{ name: 'message', type: tString }],
    returnType: { kind: 'none' },
    fuelCost: 1,
    doc: 'Emit a chat message intent.',
    category: 'chat',
  },
];

export const STATE_SHAPE: StateShape = { count: tInt };

export const CONTEXT_SHAPE: ContextShape = {
  tick: tInt,
  material: tEnum('VoxelType'),
  weather: tString,
};

export function makeRuntime(): SpellLang {
  return new SpellLang({
    types: { VoxelType: { kind: 'enum', values: [...VOXEL_TYPES] } },
    callables: CALLABLES,
    stateShape: STATE_SHAPE,
    contextShape: CONTEXT_SHAPE,
  });
}

/** The EXAMPLE section of the system prompt — must reference only this host. */
export const EXAMPLE = `// Four floors; alternate stone and planks
for floor of range(0, 4) {
    let y = floor * 3
    if floor % 2 == 0 {
        call setVoxels(0, y, 0, 4, y + 2, 4, STONE)
    } else {
        call setVoxels(0, y, 0, 4, y + 2, 4, PLANKS)
    }
}`;

// ---------------------------------------------------------------------------
// Checker helpers
// ---------------------------------------------------------------------------

function voxelMap(entries: [number, number, number, string][]): Record<string, string> {
  const m: Record<string, string> = {};
  for (const [x, y, z, type] of entries) m[voxelKey(x, y, z)] = type;
  return m;
}

function row(x1: number, x2: number, y: number, z: number, type: string): Record<string, string> {
  const entries: [number, number, number, string][] = [];
  for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) entries.push([x, y, z, type]);
  return voxelMap(entries);
}

function compareVoxels(actual: Map<string, string>, expected: Record<string, string>): Verdict {
  const missing: string[] = [];
  for (const [k, v] of Object.entries(expected)) {
    if (actual.get(k) !== v) missing.push(`${k} expected ${v}, got ${actual.get(k) ?? 'nothing'}`);
  }
  const extra = [...actual.keys()].filter((k) => !(k in expected));
  if (missing.length === 0 && extra.length === 0) return { pass: true, reason: 'ok' };
  return {
    pass: false,
    reason: `world mismatch — missing/wrong: ${missing.join('; ') || 'none'}; unexpected: ${extra.join('; ') || 'none'}`,
  };
}

/** Checker over the LAST run's world. */
function lastRunWorld(expected: Record<string, string>): (outcomes: RunOutcome[]) => Verdict {
  return (outcomes) => compareVoxels(outcomes[outcomes.length - 1]!.voxels, expected);
}

const C = (tick: number, material: string, weather: string) => ({ tick, material, weather });

// ---------------------------------------------------------------------------
// Tasks — ordered from literal placement to multi-run persistent state
// ---------------------------------------------------------------------------

export const TASKS: EvalTask[] = [
  {
    id: 'single-voxel',
    prompt: 'Place exactly one STONE voxel at coordinates (2, 0, 3).',
    initialState: { count: 0 },
    runs: [{ context: C(0, 'STONE', 'clear') }],
    reference: 'call setVoxel(2, 0, 3, STONE)',
    check: lastRunWorld(voxelMap([[2, 0, 3, 'STONE']])),
  },
  {
    id: 'computed-coords',
    prompt:
      'Place one TORCH voxel at x = 3 * 4, y = 10 - 7, z = 9 % 4. ' +
      'Compute the coordinates inside the call using arithmetic expressions.',
    initialState: { count: 0 },
    runs: [{ context: C(0, 'STONE', 'clear') }],
    reference: 'call setVoxel(3 * 4, 10 - 7, 9 % 4, TORCH)',
    check: lastRunWorld(voxelMap([[12, 3, 1, 'TORCH']])),
  },
  {
    id: 'row-loop',
    prompt:
      'Place 6 PLANKS voxels in a straight row along the x axis, from (0, 0, 0) ' +
      'to (5, 0, 0). Use a for loop over range().',
    initialState: { count: 0 },
    runs: [{ context: C(0, 'STONE', 'clear') }],
    reference: 'for i of range(0, 6) {\n  call setVoxel(i, 0, 0, PLANKS)\n}',
    check: lastRunWorld(row(0, 5, 0, 0, 'PLANKS')),
  },
  {
    id: 'box-fill',
    prompt:
      'Fill the inclusive box from (0, 0, 0) to (2, 3, 1) entirely with DIRT ' +
      '(that is 24 voxels: x 0..2, y 0..3, z 0..1).',
    initialState: { count: 0 },
    runs: [{ context: C(0, 'STONE', 'clear') }],
    reference: 'call setVoxels(0, 0, 0, 2, 3, 1, DIRT)',
    check: (outcomes) => {
      const entries: [number, number, number, string][] = [];
      for (let x = 0; x <= 2; x++)
        for (let y = 0; y <= 3; y++) for (let z = 0; z <= 1; z++) entries.push([x, y, z, 'DIRT']);
      return compareVoxels(outcomes[outcomes.length - 1]!.voxels, voxelMap(entries));
    },
  },
  {
    id: 'platform-3x3',
    prompt:
      'Build a 3x3 platform of STONE one block above ground: every position ' +
      '(x, 1, z) with x and z each in -1..1. Use nested for loops over range().',
    initialState: { count: 0 },
    runs: [{ context: C(0, 'STONE', 'clear') }],
    reference:
      'for x of range(-1, 2) {\n  for z of range(-1, 2) {\n    call setVoxel(x, 1, z, STONE)\n  }\n}',
    check: (outcomes) => {
      const entries: [number, number, number, string][] = [];
      for (let x = -1; x <= 1; x++)
        for (let z = -1; z <= 1; z++) entries.push([x, 1, z, 'STONE']);
      return compareVoxels(outcomes[outcomes.length - 1]!.voxels, voxelMap(entries));
    },
  },
  {
    id: 'tick-parity',
    prompt:
      'This script runs every tick. On even ticks place a STONE voxel at ' +
      '(0, 0, 0); on odd ticks place a DIRT voxel at (0, 0, 0). ' +
      'The current tick number is the context field tick.',
    initialState: { count: 0 },
    runs: [{ context: C(4, 'STONE', 'clear') }, { context: C(5, 'STONE', 'clear') }],
    reference:
      'if tick % 2 == 0 {\n  call setVoxel(0, 0, 0, STONE)\n} else {\n  call setVoxel(0, 0, 0, DIRT)\n}',
    check: (outcomes) => {
      const v0 = compareVoxels(outcomes[0]!.voxels, voxelMap([[0, 0, 0, 'STONE']]));
      if (!v0.pass) return { pass: false, reason: `run #1: ${v0.reason}` };
      const v1 = compareVoxels(outcomes[1]!.voxels, voxelMap([[0, 0, 0, 'DIRT']]));
      if (!v1.pass) return { pass: false, reason: `run #2: ${v1.reason}` };
      return { pass: true, reason: 'ok' };
    },
  },
  {
    id: 'weather-string',
    prompt:
      'If the context field weather is exactly "rain", place a DIRT voxel at ' +
      '(0, 0, 0). Otherwise place a STONE voxel at (0, 0, 0).',
    initialState: { count: 0 },
    runs: [{ context: C(0, 'STONE', 'rain') }, { context: C(0, 'STONE', 'clear') }],
    reference:
      'if weather == "rain" {\n  call setVoxel(0, 0, 0, DIRT)\n} else {\n  call setVoxel(0, 0, 0, STONE)\n}',
    check: (outcomes) => {
      const v0 = compareVoxels(outcomes[0]!.voxels, voxelMap([[0, 0, 0, 'DIRT']]));
      if (!v0.pass) return { pass: false, reason: `run #1: ${v0.reason}` };
      const v1 = compareVoxels(outcomes[1]!.voxels, voxelMap([[0, 0, 0, 'STONE']]));
      if (!v1.pass) return { pass: false, reason: `run #2: ${v1.reason}` };
      return { pass: true, reason: 'ok' };
    },
  },
  {
    id: 'context-material',
    prompt:
      'Place one voxel of the material given by the context field material ' +
      'at (1, 2, 1). Do not hardcode a material name; use the context field.',
    initialState: { count: 0 },
    runs: [{ context: C(0, 'PLANKS', 'clear') }],
    reference: 'call setVoxel(1, 2, 1, material)',
    check: lastRunWorld(voxelMap([[1, 2, 1, 'PLANKS']])),
  },
  {
    id: 'stop-guard',
    prompt:
      'Loop with i over range(0, 10) and place a WOOD voxel at (i, 0, 0) each ' +
      'iteration, but stop the script as soon as i is greater than 3 — so ' +
      'exactly 4 voxels are placed, at x = 0, 1, 2, 3.',
    initialState: { count: 0 },
    runs: [{ context: C(0, 'STONE', 'clear') }],
    reference: 'for i of range(0, 10) {\n  if i > 3 {\n    stop\n  }\n  call setVoxel(i, 0, 0, WOOD)\n}',
    check: lastRunWorld(row(0, 3, 0, 0, 'WOOD')),
  },
  {
    id: 'state-counter',
    prompt:
      'This script is re-invoked every tick with its previous state. Each run, ' +
      'increment the persistent counter state.count by 1, then place that many ' +
      'STONE voxels in a row along the x axis at y = 0, z = 0 (run 1 places 1 ' +
      'voxel, run 2 places 2, run 3 places 3).',
    initialState: { count: 0 },
    runs: [{ context: C(1, 'STONE', 'clear') }, { context: C(2, 'STONE', 'clear') }, { context: C(3, 'STONE', 'clear') }],
    reference:
      'state.count = state.count + 1\nfor i of range(0, state.count) {\n  call setVoxel(i, 0, 0, STONE)\n}',
    check: (outcomes) => {
      for (let i = 0; i < outcomes.length; i++) {
        const v = compareVoxels(outcomes[i]!.voxels, row(0, i, 0, 0, 'STONE'));
        if (!v.pass) return { pass: false, reason: `run #${i + 1}: ${v.reason}` };
      }
      const final = outcomes[outcomes.length - 1]!.state.count;
      if (final !== outcomes.length) {
        return { pass: false, reason: `final state.count = ${String(final)}, expected ${outcomes.length}` };
      }
      return { pass: true, reason: 'ok' };
    },
  },
];
