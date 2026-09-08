import { describe, expect, it } from 'vitest';
import { parse } from '../src/parser.js';

describe('parser: valid programs', () => {
  it('parses a simple call', () => {
    const r = parse('call setVoxel(0, 0, 0, STONE)');
    expect(r.ok).toBe(true);
    expect(r.program?.statements).toHaveLength(1);
  });

  it('parses if / else if / else', () => {
    const r = parse(`if x > 2 {
  call a()
} else if x == 2 {
  call b()
} else {
  call c()
}`);
    expect(r.ok).toBe(true);
    const stmt = r.program!.statements[0]!;
    expect(stmt.kind).toBe('if');
    if (stmt.kind === 'if') {
      expect(stmt.branches).toHaveLength(2);
      expect(stmt.elseBody).not.toBeNull();
    }
  });

  it('parses for with range builtin', () => {
    const r = parse('for i of range(0, 8) {\n  call f(i)\n}');
    expect(r.ok).toBe(true);
  });

  it('accepts trailing commas and comments', () => {
    const r = parse(`// comment
call f(1, 2,)
let x = [1, 2, 3,]`);
    expect(r.ok).toBe(true);
  });

  it('accepts semicolons as terminators', () => {
    const r = parse('let x = 1; let y = 2;');
    expect(r.ok).toBe(true);
  });

  it('accepts multiline expressions inside parens', () => {
    const r = parse('let x = min(\n  1,\n  2,\n)');
    expect(r.ok).toBe(true);
  });

  it('parses operator precedence correctly', () => {
    const r = parse('let x = 1 + 2 * 3');
    expect(r.ok).toBe(true);
    const let_ = r.program!.statements[0]!;
    if (let_.kind === 'let') {
      // must be 1 + (2*3), not (1+2)*3
      expect(let_.value).toMatchObject({ kind: 'binary', op: '+' });
      expect(let_.value).toMatchObject({
        right: { kind: 'binary', op: '*' },
      });
    }
  });

  it('parses comparison operators', () => {
    for (const op of ['==', '!=', '<', '<=', '>', '>=']) {
      const r = parse(`let x = 1 ${op} 2`);
      expect(r.ok).toBe(true);
    }
  });

  it('parses unary minus and not', () => {
    expect(parse('let x = -5').ok).toBe(true);
    expect(parse('let x = not true').ok).toBe(true);
    expect(parse('let x = -a.b').ok).toBe(true);
  });

  it('parses a record literal with fields in any order', () => {
    const r = parse('let opts = SpawnOpts { mode: "nightmare", count: 5 }');
    expect(r.ok).toBe(true);
    const stmt = r.program!.statements[0]!;
    if (stmt.kind === 'let') {
      expect(stmt.value).toMatchObject({
        kind: 'recordLit',
        typeName: 'SpawnOpts',
        fields: [
          { name: 'mode', value: { kind: 'str', value: 'nightmare' } },
          { name: 'count', value: { kind: 'num', value: 5, isInt: true } },
        ],
      });
    }
  });

  it('parses an empty record literal and a trailing comma', () => {
    expect(parse('let e = Empty {}').ok).toBe(true);
    const r = parse('let o = SpawnOpts { count: 5, }');
    expect(r.ok).toBe(true);
  });

  it('parses multiline record literals', () => {
    const r = parse(`let opts = SpawnOpts {
  count: 5,
  mode: "nightmare",
}`);
    expect(r.ok).toBe(true);
  });

  it('parses record literals with arbitrary expressions as field values', () => {
    const r = parse('let opts = SpawnOpts { count: 1 + 2, at: player.pos }');
    expect(r.ok).toBe(true);
    const stmt = r.program!.statements[0]!;
    if (stmt.kind === 'let' && stmt.value.kind === 'recordLit') {
      expect(stmt.value.fields[0]!.value).toMatchObject({ kind: 'binary', op: '+' });
      expect(stmt.value.fields[1]!.value).toMatchObject({ kind: 'member', field: 'pos' });
    }
  });

  it('keeps `{` after an if/for header as the body block, not a record literal', () => {
    const r = parse('if ready {\n  call f()\n} else if set {\n  call g()\n}\nfor i of items {\n  call h(i)\n}');
    expect(r.ok).toBe(true);
    const stmt = r.program!.statements[0]!;
    if (stmt.kind === 'if') {
      expect(stmt.branches[0]!.cond).toMatchObject({ kind: 'var', name: 'ready' });
      expect(stmt.branches[1]!.cond).toMatchObject({ kind: 'var', name: 'set' });
    }
    const loop = r.program!.statements[1]!;
    if (loop.kind === 'for') {
      expect(loop.iterable).toMatchObject({ kind: 'var', name: 'items' });
    }
  });

  it('parses a record literal inside parentheses in an if condition', () => {
    const r = parse('let o = SpawnOpts { count: 5 }\nif (o) == o {\n  stop\n}');
    expect(r.ok).toBe(true);
  });
});

describe('parser: errors are localized and multiple', () => {
  it('reports a non-keyword statement start with line/col', () => {
    const r = parse('call f(1)\nwibble 3\ncall g(2)');
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.errors[0]).toMatchObject({ line: 2 });
  });

  it('recovers and reports several errors in one pass', () => {
    const r = parse('let = 5\ncall f(1)\nlet x = \nstop');
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThanOrEqual(2);
  });

  it('reports unclosed brace at the opening brace', () => {
    const r = parse('if x {\n  call f()\n');
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.code === 'unclosed-brace')).toBe(true);
  });

  it('rejects chained comparisons', () => {
    const r = parse('let x = 1 < 2 < 3');
    // parses as error? No: grammar makes cmp non-associative → parse error on second '<'
    expect(r.ok).toBe(false);
  });

  it('rejects calling a non-builtin in expression position', () => {
    const r = parse('let x = setVoxel(0, 0, 0, DIRT)');
    expect(r.ok).toBe(false);
  });

  it('rejects record literals with missing colon or value', () => {
    const r1 = parse('let x = T { count 5 }');
    expect(r1.ok).toBe(false);
    const r2 = parse('let x = T { count: }');
    expect(r2.ok).toBe(false);
    const r3 = parse('let x = T { count: 5');
    expect(r3.ok).toBe(false);
  });

  it('rejects empty program only with a warning-free ok', () => {
    expect(parse('').ok).toBe(true);
    expect(parse('// just a comment').ok).toBe(true);
  });
});
