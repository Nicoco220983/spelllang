/**
 * Fixed core builtin helper registry (expressions only — hosts cannot add
 * or remove these; for expression-callable host functions they register
 * queries instead, see DESIGN.md §3.1). See DESIGN.md §3.
 */

import type { CallableDecl, Type } from './ast.js';
import { tBool, tFloat, tInt, tList, tTypeVar } from './ast.js';

/** Any record value with numeric x, y, z fields (checked at validation). */
export const tVec: Type = { kind: 'vec' };

export const BUILTINS: CallableDecl[] = [
  {
    name: 'min',
    args: [
      { name: 'a', type: tFloat },
      { name: 'b', type: tFloat },
    ],
    returnType: tFloat,
    fuelCost: 1,
    doc: 'Smaller of two numbers.',
  },
  {
    name: 'max',
    args: [
      { name: 'a', type: tFloat },
      { name: 'b', type: tFloat },
    ],
    returnType: tFloat,
    fuelCost: 1,
    doc: 'Larger of two numbers.',
  },
  {
    name: 'abs',
    args: [{ name: 'x', type: tFloat }],
    returnType: tFloat,
    fuelCost: 1,
    doc: 'Absolute value.',
  },
  {
    name: 'floor',
    args: [{ name: 'x', type: tFloat }],
    returnType: tInt,
    fuelCost: 1,
    doc: 'Round down to integer.',
  },
  {
    name: 'ceil',
    args: [{ name: 'x', type: tFloat }],
    returnType: tInt,
    fuelCost: 1,
    doc: 'Round up to integer.',
  },
  {
    name: 'round',
    args: [{ name: 'x', type: tFloat }],
    returnType: tInt,
    fuelCost: 1,
    doc: 'Round to nearest integer (ties away from zero).',
  },
  {
    name: 'distance',
    args: [
      { name: 'a', type: tVec },
      { name: 'b', type: tVec },
    ],
    returnType: tFloat,
    fuelCost: 2,
    doc: 'Euclidean distance between two {x,y,z} points.',
  },
  {
    name: 'random',
    args: [],
    returnType: tFloat,
    fuelCost: 1,
    doc: 'Pseudo-random float in [0,1); seeded per run (deterministic).',
  },
  {
    name: 'range',
    args: [
      { name: 'start', type: tInt },
      { name: 'end', type: tInt },
    ],
    returnType: tList(tInt),
    fuelCost: 1,
    doc: 'List of ints from start (inclusive) to end (exclusive); counts down when start > end.',
  },
  {
    name: 'len',
    args: [{ name: 'list', type: tList(tTypeVar('T')) }],
    returnType: tInt,
    fuelCost: 1,
    doc: 'Number of elements in a list (0 when empty).',
  },
  {
    name: 'append',
    args: [
      { name: 'list', type: tList(tTypeVar('T')) },
      { name: 'x', type: tTypeVar('T') },
    ],
    returnType: tList(tTypeVar('T')),
    fuelCost: 1,
    doc: 'New list with x added at the end; the input list is unchanged.',
  },
  {
    name: 'contains',
    args: [
      { name: 'list', type: tList(tTypeVar('T')) },
      { name: 'x', type: tTypeVar('T') },
    ],
    returnType: tBool,
    fuelCost: 1,
    doc: 'True when x is an element of the list (compares values).',
  },
  {
    name: 'randomInt',
    args: [
      { name: 'min', type: tInt },
      { name: 'max', type: tInt },
    ],
    returnType: tInt,
    fuelCost: 1,
    doc: 'Random int in [min, max] (inclusive); seeded per run (deterministic).',
  },
  {
    name: 'sqrt',
    args: [{ name: 'x', type: tFloat }],
    returnType: tFloat,
    fuelCost: 1,
    doc: 'Square root.',
  },
];

const BUILTIN_NAMES = new Set(BUILTINS.map((b) => b.name));

export function isBuiltin(name: string): boolean {
  return BUILTIN_NAMES.has(name);
}

export function getBuiltin(name: string): CallableDecl | undefined {
  return BUILTINS.find((b) => b.name === name);
}
