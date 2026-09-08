// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import type { Program } from '../src/ast.js';
import { LANG_VERSION, tEnum, tInt, tString } from '../src/ast.js';
import type { SpellLangConfig } from '../src/host.js';
import { parse } from '../src/parser.js';
import { SpellLangEditorElement, type EditorChangeDetail } from '../src/blocks/editor.js';
import '../src/blocks/index.js'; // registers <spelllang-editor>

const config: SpellLangConfig = {
  callables: [
    {
      name: 'setVoxel',
      args: [
        { name: 'type', type: tEnum('VoxelType') },
        { name: 'durability', type: tInt },
        { name: 'color', type: tString, optional: true },
      ],
      returnType: { kind: 'none' },
      fuelCost: 1,
      doc: 'Place a voxel.',
      category: 'world',
    },
  ],
  types: { VoxelType: { kind: 'enum', values: ['DIRT', 'STONE'] } },
  stateShape: { anger: tInt },
  contextShape: {},
};

const sampleText = `
let height = 3
call setVoxel(STONE, height + 1)
if height > 2 {
  state.anger = height
} else {
  stop
}
`.trim();

function makeEditor(): SpellLangEditorElement {
  const editor = document.createElement('spelllang-editor') as SpellLangEditorElement;
  editor.config = config;
  const parsed = parse(sampleText);
  if (!parsed.ok || !parsed.program) throw new Error('sample must parse');
  editor.program = parsed.program;
  document.body.append(editor);
  return editor;
}

const socketsOf = (editor: SpellLangEditorElement, path: number[]): HTMLElement[] =>
  Array.from(
    editor.shadowRoot!.querySelectorAll<HTMLElement>(`[data-path='${JSON.stringify(path)}'].socket`),
  );

describe('<spelllang-editor>', () => {
  it('registers the custom element', () => {
    expect(customElements.get('spelllang-editor')).toBe(SpellLangEditorElement);
  });

  it('renders blocks with sockets and C-block nesting', () => {
    const editor = makeEditor();
    const blocks = editor.shadowRoot!.querySelectorAll('[data-path]');
    expect(blocks.length).toBeGreaterThan(0);
    // let height = 3 → one socket
    expect(socketsOf(editor, [0])).toHaveLength(1);
    // call setVoxel(STONE, height + 1) → two arg sockets
    expect(socketsOf(editor, [1])).toHaveLength(2);
    // if block: nested lists for branch and else
    expect(editor.shadowRoot!.querySelectorAll("[data-list='[2,\"body:0\"]']").length).toBe(1);
    expect(editor.shadowRoot!.querySelectorAll("[data-list='[2,\"else\"]']").length).toBe(1);
    // enum arg renders a select with both values
    const enumSelect = socketsOf(editor, [1])[0]!.querySelector('select')!;
    expect(Array.from(enumSelect.options).map((o) => o.value)).toEqual(['DIRT', 'STONE']);
  });

  it('shows the palette from the callable registry', () => {
    const editor = makeEditor();
    const labels = Array.from(editor.shadowRoot!.querySelectorAll('.palette .item')).map(
      (b) => (b as HTMLElement).textContent,
    );
    expect(labels).toContain('call setVoxel(…)');
    expect(labels).toContain('if … else');
    expect(labels).toContain('state.anger = …');
  });

  it('commits an enum dropdown change and emits change with a valid program', () => {
    const editor = makeEditor();
    const seen: EditorChangeDetail[] = [];
    editor.addEventListener('change', (e) => seen.push((e as CustomEvent<EditorChangeDetail>).detail));
    const select = socketsOf(editor, [1])[0]!.querySelector('select')!;
    select.value = 'DIRT';
    select.dispatchEvent(new Event('change'));
    expect(seen).toHaveLength(1);
    expect(seen[0]!.errors).toEqual([]);
    expect(seen[0]!.text).toContain('setVoxel(DIRT, height + 1)');
    expect(seen[0]!.program.statements[1]).toEqual(editor.program.statements[1]);
  });

  it('commits socket text through the expression parser', () => {
    const editor = makeEditor();
    const input = socketsOf(editor, [0])[0]!.querySelector('input')!; // height value
    input.value = '2 + 1';
    input.dispatchEvent(new Event('change'));
    expect(editor.text).toContain('let height = 2 + 1');
  });

  it('rejects invalid socket text: red field, AST untouched, error surfaced', () => {
    const editor = makeEditor();
    const seen: EditorChangeDetail[] = [];
    editor.addEventListener('change', (e) => seen.push((e as CustomEvent<EditorChangeDetail>).detail));
    const before = editor.text;
    const input = socketsOf(editor, [0])[0]!.querySelector('input')!;
    input.value = 'height +* 1';
    input.dispatchEvent(new Event('change'));
    expect(editor.text).toBe(before); // not committed
    expect(input.closest('.socket')!.classList.contains('invalid')).toBe(true);
    expect(seen).toHaveLength(0); // no change event for a rejected commit
  });

  it('surfaces validation errors in the change detail and error bar', () => {
    const editor = makeEditor();
    const seen: EditorChangeDetail[] = [];
    editor.addEventListener('change', (e) => seen.push((e as CustomEvent<EditorChangeDetail>).detail));
    const input = socketsOf(editor, [0])[0]!.querySelector('input')!;
    input.value = 'unknown_thing';
    input.dispatchEvent(new Event('change'));
    expect(seen[0]!.errors.map((e) => e.code)).toContain('unknown-identifier');
    expect(editor.shadowRoot!.querySelector('.errors')?.textContent).toContain('unknown-identifier');
  });

  it('adds an optional call arg and removes it again', () => {
    const editor = makeEditor();
    const add = Array.from(socketsOf(editor, [1])[1]!.parentElement!.querySelectorAll('button')).find(
      (b) => b.textContent === '+ color',
    );
    add!.dispatchEvent(new Event('click'));
    expect(editor.text).toContain('setVoxel(STONE, height + 1, "")');
    const rm = Array.from(socketsOf(editor, [1])[2]!.querySelectorAll('button')).find(
      (b) => b.textContent === '−',
    );
    rm!.dispatchEvent(new Event('click'));
    expect(editor.text).toContain('setVoxel(STONE, height + 1)');
  });

  it('adds and removes else-if branches', () => {
    const editor = makeEditor();
    const addElseIf = Array.from(editor.shadowRoot!.querySelectorAll('button')).find(
      (b) => b.textContent === '+ else if',
    );
    addElseIf!.dispatchEvent(new Event('click'));
    expect(editor.program.statements[2]!.kind).toBe('if');
    const ifStmt = editor.program.statements[2]!;
    if (ifStmt.kind === 'if') {
      expect(ifStmt.branches).toHaveLength(2);
      expect(ifStmt.elseBody).not.toBeNull(); // untouched
    }
    // remove the branch again via its ✕ control
    const rm = editor.shadowRoot!.querySelectorAll("[data-path='[2]'] .adder")[0] as HTMLButtonElement;
    rm.dispatchEvent(new Event('click'));
    const back = editor.program.statements[2]!;
    if (back.kind === 'if') expect(back.branches).toHaveLength(1);
  });

  it('reorders and deletes statements via controls', () => {
    const editor = makeEditor();
    editor.moveStmtTo([0], [2]); // move `let` to before index 2
    expect(editor.program.statements[0]!.kind).toBe('call');
    expect(editor.program.statements[1]!.kind).toBe('let');
    expect(editor.program.statements[2]!.kind).toBe('if');
    const block = editor.shadowRoot!.querySelector("[data-path='[2]']")!;
    const del = Array.from(block.querySelectorAll('.ctl button')).find((b) => b.textContent === '✕');
    del!.dispatchEvent(new Event('click'));
    expect(editor.program.statements).toHaveLength(2);
  });

  it('appends palette blocks that validate', () => {
    const editor = makeEditor();
    editor.appendFromPalette('stop');
    editor.appendFromPalette('call:setVoxel');
    expect(editor.program.statements).toHaveLength(5);
    expect(editor.validationErrors).toEqual([]);
  });

  it('starts empty and stays valid', () => {
    const editor = document.createElement('spelllang-editor') as SpellLangEditorElement;
    editor.config = config;
    expect(editor.text).toBe('');
    expect(editor.validationErrors).toEqual([]);
    expect(editor.program).toEqual({ langVersion: LANG_VERSION, statements: [] } as Program);
  });

  it('fails fast on malformed config', () => {
    const editor = document.createElement('spelllang-editor') as SpellLangEditorElement;
    expect(() => {
      editor.config = { callables: [{ name: 'x' }] as never };
    }).toThrow();
  });
});
