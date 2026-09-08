/**
 * `<spelllang-editor>` — zero-dependency block editor custom element.
 *
 * The AST is the single source of truth (see mapping.ts): every edit produces
 * a new AST, the program is re-validated, the DOM re-renders, and a `change`
 * event carries `{ program, text, errors }`. Blocks are addressed by
 * statement paths (`data-path`) and sockets by expression selector chains
 * (`data-sel`); see mapping.ts for both formats.
 *
 * Hosts configure the editor through the same `SpellLangConfig` used for
 * `new SpellLang(...)`:
 *
 * ```js
 * const editor = document.createElement('spelllang-editor');
 * editor.config = { callables, types, stateShape, contextShape };
 * editor.program = parsedProgram;
 * editor.addEventListener('change', (e) => save(e.detail.program, e.detail.errors));
 * ```
 */

import type {
  CallableDecl,
  Expr,
  Program,
  SpellError,
  Stmt,
  Type,
} from '../ast.js';
import type { Registry } from '../validator.js';
import { DEFAULT_LIMITS, LANG_VERSION } from '../ast.js';
import { getBuiltin } from '../builtins.js';
import { SpellLang, type SpellLangConfig } from '../host.js';
import { parseExpression } from '../parser.js';
import { printExpr, printProgram } from '../printer.js';
import * as M from './mapping.js';
import type { ExprSel, ListKey, PaletteItem, StmtPath } from './mapping.js';
import { BLOCK_CSS } from './css.js';

export interface EditorChangeDetail {
  program: Program;
  text: string;
  errors: SpellError[];
}

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const BINARY_OPS = ['+', '-', '*', '/', '%', '==', '!=', '<', '<=', '>', '>=', 'and', 'or'];

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function buildRegistry(config: SpellLangConfig): Registry {
  return {
    callables: new Map((config.callables ?? []).map((c) => [c.name, c])),
    types: new Map(Object.entries(config.types ?? {})),
    stateShape: config.stateShape ?? {},
    contextShape: config.contextShape ?? {},
    limits: { ...DEFAULT_LIMITS, ...config.limits },
  };
}

// The blocks subpath is importable in non-DOM environments (mapping.ts is
// pure and hosts may use it server-side); only instantiating the element
// requires a real DOM.
const HTMLElementBase: typeof HTMLElement =
  typeof HTMLElement === 'undefined'
    ? (class {} as unknown as typeof HTMLElement)
    : HTMLElement;

export class SpellLangEditorElement extends HTMLElementBase {
  private _program: Program = { langVersion: LANG_VERSION, statements: [] };
  private _config: SpellLangConfig | null = null;
  private runtime: SpellLang | null = null;
  private reg: Registry = buildRegistry({});
  private palette: M.PaletteGroup[] = [];
  private errors: SpellError[] = [];
  private root: ShadowRoot;
  /** active statement drag, if any */
  private drag: { from: StmtPath } | null = null;

  constructor() {
    super();
    if (typeof this.attachShadow !== 'function') {
      throw new Error(
        '<spelllang-editor> requires a DOM environment; the pure block-mapping helpers work everywhere.',
      );
    }
    this.root = this.attachShadow({ mode: 'open' });
  }

  // -- host-facing properties -------------------------------------------------

  /** Host configuration (same shape as `new SpellLang(...)`). Re-validates and re-renders. */
  set config(config: SpellLangConfig | null) {
    this._config = config ? structuredClone(config) : null;
    this.runtime = config ? new SpellLang(config) : null;
    this.reg = buildRegistry(config ?? {});
    this.palette = M.paletteModel(this.reg);
    this.validateAndRender();
  }

  get config(): SpellLangConfig | null {
    return this._config ? structuredClone(this._config) : null;
  }

  /** The edited program (deep copy; safe to persist). */
  set program(program: Program) {
    this._program = structuredClone(program);
    this.validateAndRender();
  }

  get program(): Program {
    return structuredClone(this._program);
  }

  /** Canonical text of the current program. */
  get text(): string {
    return printProgram(this._program);
  }

  /** Validation errors for the current program (empty when no config set). */
  get validationErrors(): SpellError[] {
    return [...this.errors];
  }

  // -- commit pipeline ----------------------------------------------------------

  private validateAndRender(): void {
    this.errors = this.runtime ? this.runtime.validate(this._program) : [];
    this.render();
  }

  private commit(next: Program): void {
    this._program = next;
    this.validateAndRender();
    this.dispatchEvent(
      new CustomEvent<EditorChangeDetail>('change', {
        detail: {
          program: structuredClone(next),
          text: printProgram(next),
          errors: [...this.errors],
        },
        bubbles: true,
        composed: true,
      }),
    );
  }

  // -- rendering ----------------------------------------------------------------

  private render(): void {
    this.root.innerHTML = `<style>${BLOCK_CSS}</style>`;
    const root = el('div', 'root');
    root.append(this.renderPalette());
    const canvas = el('div', 'canvas');
    if (this.errors.length > 0) {
      const bar = el('div', 'errors');
      bar.style.cssText =
        'background: var(--sl-danger); color:#fff; border-radius:6px; padding:6px 10px; margin-bottom:8px; font-size:12px;';
      for (const e of this.errors.slice(0, 5)) {
        bar.append(el('div', undefined, `${e.line}:${e.col} ${e.code}: ${e.message}`));
      }
      if (this.errors.length > 5) bar.append(el('div', undefined, `… ${this.errors.length - 5} more`));
      canvas.append(bar);
    }
    canvas.append(this.renderStmtList(this._program.statements, []));
    root.append(canvas);
    this.root.append(root);
  }

  private renderPalette(): HTMLElement {
    const palette = el('div', 'palette');
    palette.append(el('h3', undefined, 'Blocks'));
    for (const group of this.palette) {
      palette.append(el('h3', undefined, group.name));
      for (const item of group.items) {
        const btn = el('button', `item ${paletteClass(item)}`, item.label);
        btn.addEventListener('click', () => this.appendFromPalette(item.id));
        palette.append(btn);
      }
    }
    return palette;
  }

  private renderStmtList(list: Stmt[], path: StmtPath): HTMLElement {
    const div = el('div', `stmt-list${list.length === 0 ? ' empty' : ''}`);
    div.dataset.list = JSON.stringify(path);
    if (list.length === 0) div.append(el('div', undefined, 'drop blocks here'));
    list.forEach((stmt, i) => div.append(this.renderStmt(stmt, [...path, i])));
    return div;
  }

  private renderStmt(stmt: Stmt, path: StmtPath): HTMLElement {
    switch (stmt.kind) {
      case 'call':
        return this.renderCall(stmt, path);
      case 'let':
      case 'assign':
        return this.renderLetAssign(stmt, path);
      case 'stateAssign':
        return this.renderStateAssign(stmt, path);
      case 'if':
        return this.renderIf(stmt, path);
      case 'for':
        return this.renderFor(stmt, path);
      case 'stop': {
        const block = this.blockShell('stop', path, 'stop');
        return block;
      }
    }
  }

  /** Common block wrapper: drag handle + content row + ↑↓✕ controls.
   *
   * The head has two flex zones: `.head-main` holds the handle and all
   * statement-specific content (added by the renderers after this call);
   * it wraps freely. `.ctl` (appended here, so it precedes that content in
   * DOM order) lives in a no-wrap sibling zone pinned to the block's right
   * edge via `flex: 1` on `.head-main`, so the buttons stay at the right of
   * the content's first row instead of wrapping below it. */
  private blockShell(cls: string, path: StmtPath, label: string): HTMLElement {
    const block = el('div', `block ${cls}`);
    block.dataset.path = JSON.stringify(path);
    const head = el('div', 'head');
    const main = el('div', 'head-main');
    const handle = el('span', 'drag-handle', '⋮⋮');
    handle.title = 'drag to move';
    main.append(handle);
    if (label) main.append(el('span', 'label', label));
    head.append(main);
    const ctl = el('span', 'ctl');
    const mk = (text: string, title: string, fn: () => void) => {
      const b = el('button', undefined, text);
      b.title = title;
      b.addEventListener('click', fn);
      ctl.append(b);
    };
    mk('↑', 'move up', () => this.moveBy(path, -1));
    mk('↓', 'move down', () => this.moveBy(path, +1));
    mk('✕', 'delete', () => this.deleteStmt(path));
    head.append(ctl);
    block.append(head);
    this.attachDrag(handle, block, path);
    return block;
  }

  private renderCall(stmt: Extract<Stmt, { kind: 'call' }>, path: StmtPath): HTMLElement {
    const decl = this.reg.callables.get(stmt.name) ?? null;
    const block = this.blockShell('call', path, `call ${stmt.name}`);
    const head = block.querySelector('.head-main')!;
    stmt.args.forEach((arg, i) => {
      const expected = decl?.args[i]?.type ?? null;
      head.append(this.renderSocket(stmt, path, [`arg:${i}`], arg, expected, decl?.args[i]?.name));
    });
    // optional args: add control for the first omitted trailing optional
    const nextIndex = stmt.args.length;
    const nextArg = decl?.args[nextIndex];
    if (nextArg?.optional) {
      const add = el('button', 'adder', `+ ${nextArg.name}`);
      add.title = 'add optional argument';
      add.addEventListener('click', () => {
        const fresh = M.defaultExprFor(nextArg.type, this.reg) ?? M.numLit(0);
        this.updateStmt(path, { ...stmt, args: [...stmt.args, fresh] });
      });
      head.append(add);
    }
    // remove control on a trailing optional arg
    const lastIndex = stmt.args.length - 1;
    const lastDecl = decl?.args[lastIndex];
    if (lastIndex >= 0 && lastDecl?.optional) {
      const headEl = block.querySelector('.head-main')!;
      const socket = headEl.querySelectorAll('.socket')[lastIndex];
      const rm = el('button', 'adder', '−');
      rm.title = `remove optional argument ${lastDecl.name}`;
      rm.addEventListener('click', () =>
        this.updateStmt(path, { ...stmt, args: stmt.args.slice(0, -1) }),
      );
      socket?.append(rm);
    }
    return block;
  }

  private renderLetAssign(
    stmt: Extract<Stmt, { kind: 'let' | 'assign' }>,
    path: StmtPath,
  ): HTMLElement {
    const block = this.blockShell('variables', path, stmt.kind);
    const head = block.querySelector('.head-main')!;
    if (stmt.kind === 'let') {
      head.append(this.varField(stmt.name, (name) => this.renameVar(path, name)));
    } else {
      head.append(this.assignTargetSelect(path, stmt.name));
    }
    head.append(el('span', 'label', '='));
    head.append(this.renderSocket(stmt, path, ['value'], stmt.value, null));
    return block;
  }

  private renderStateAssign(
    stmt: Extract<Stmt, { kind: 'stateAssign' }>,
    path: StmtPath,
  ): HTMLElement {
    const block = this.blockShell('state', path, 'state');
    const head = block.querySelector('.head-main')!;
    const select = el('select', 'var-field') as HTMLSelectElement;
    for (const field of Object.keys(this.reg.stateShape)) {
      const opt = el('option', undefined, field) as HTMLOptionElement;
      opt.value = field;
      select.append(opt);
    }
    select.value = stmt.field;
    select.addEventListener('change', () =>
      this.updateStmt(path, { ...stmt, field: select.value } as Stmt),
    );
    head.append(select, el('span', 'label', '='));
    head.append(
      this.renderSocket(stmt, path, ['value'], stmt.value, this.reg.stateShape[stmt.field] ?? null),
    );
    return block;
  }

  private renderIf(stmt: Extract<Stmt, { kind: 'if' }>, path: StmtPath): HTMLElement {
    const block = this.blockShell('control', path, '');
    const full = stmt as Stmt;
    const head = block.querySelector('.head-main')!;
    stmt.branches.forEach((branch, b) => {
      if (b === 0) {
        // first branch shares the head row: ⋮⋮ if [cond]
        head.append(el('span', 'label', 'if'));
        head.append(this.renderSocket(full, path, ['cond:0'], branch.cond, { kind: 'bool' }));
      } else {
        const row = el('div');
        row.append(
          el('span', 'label', 'else if'),
          this.renderSocket(full, path, [`cond:${b}`], branch.cond, { kind: 'bool' }),
        );
        const rm = el('button', 'adder', '✕');
        rm.title = 'remove this branch';
        rm.addEventListener('click', () => {
          const branches = stmt.branches.filter((_, j) => j !== b);
          this.updateStmt(path, { ...stmt, branches } as Stmt);
        });
        row.append(rm);
        block.append(row);
      }
      block.append(this.renderStmtList(branch.body, [...path, `body:${b}` as ListKey]));
    });
    if (stmt.elseBody !== null) {
      const row = el('div', 'else-label', 'else');
      const rm = el('button', 'adder', '✕');
      rm.title = 'remove else';
      rm.addEventListener('click', () => this.updateStmt(path, { ...stmt, elseBody: null } as Stmt));
      row.append(rm);
      block.append(row, this.renderStmtList(stmt.elseBody, [...path, 'else']));
    }
    const adders = el('div');
    const addElseIf = el('button', 'adder', '+ else if');
    addElseIf.addEventListener('click', () => this.addElseIf(path));
    adders.append(addElseIf);
    if (stmt.elseBody === null) {
      const addElse = el('button', 'adder', '+ else');
      addElse.addEventListener('click', () =>
        this.updateStmt(path, { ...stmt, elseBody: [] } as Stmt),
      );
      adders.append(addElse);
    }
    block.append(adders);
    return block;
  }

  private renderFor(stmt: Extract<Stmt, { kind: 'for' }>, path: StmtPath): HTMLElement {
    const block = this.blockShell('control', path, 'for');
    const head = block.querySelector('.head-main')!;
    head.append(
      this.varField(stmt.variable, (name) => this.updateStmt(path, { ...stmt, variable: name } as Stmt)),
      el('span', 'label', 'of'),
      this.renderSocket(stmt, path, ['iterable'], stmt.iterable, null),
    );
    block.append(this.renderStmtList(stmt.body, [...path, 'body:0' as ListKey]));
    return block;
  }

  // -- sockets ------------------------------------------------------------------

  /**
   * Render one expression socket. `stmt`/`path` address the containing
   * statement, `sel` the expression slot within it, `expected` the declared
   * type (null when unconstrained).
   */
  private renderSocket(
    stmt: Stmt,
    path: StmtPath,
    sel: ExprSel[],
    expr: Expr,
    expected: Type | null,
    name?: string,
  ): HTMLElement {
    const socket = el('span', 'socket');
    socket.dataset.path = JSON.stringify(path);
    socket.dataset.sel = JSON.stringify(sel);
    if (name) socket.append(el('span', 'socket-name', name));
    const view = M.socketView(expr, expected, this.reg);
    switch (view.kind) {
      case 'nested':
        socket.append(this.renderNestedExpr(stmt, path, sel, expr));
        break;
      case 'number':
      case 'text': {
        const input = el('input') as HTMLInputElement;
        input.type = 'text';
        if (view.kind === 'number') input.inputMode = 'decimal';
        input.value = printExpr(expr);
        input.addEventListener('change', () => {
          if (!this.commitSocketText(path, sel, input.value)) {
            socket.classList.add('invalid');
            input.title = 'not a valid expression';
          }
        });
        socket.append(input);
        break;
      }
      case 'enum':
      case 'bool': {
        const select = el('select') as HTMLSelectElement;
        const values = view.kind === 'enum' ? view.values : ['true', 'false'];
        const current = printExpr(expr);
        for (const v of values) {
          const opt = el('option', undefined, v) as HTMLOptionElement;
          opt.value = v;
          select.append(opt);
        }
        if (!values.includes(current)) {
          const opt = el('option', undefined, current) as HTMLOptionElement;
          opt.value = current;
          select.append(opt);
        }
        select.value = current;
        select.addEventListener('change', () => {
          const next: Expr =
            view.kind === 'enum'
              ? M.enumLit(select.value)
              : M.boolLit(select.value === 'true');
          this.commitSocketExpr(path, sel, next);
        });
        socket.append(select);
        break;
      }
    }
    return socket;
  }

  /** Text-field commit: parse the text; on success replace the socket expr. */
  commitSocketText(path: StmtPath, sel: ExprSel[], text: string): boolean {
    const parsed = parseExpression(text);
    if (!parsed.ok || !parsed.expr) return false;
    this.commitSocketExpr(path, sel, parsed.expr);
    return true;
  }

  commitSocketExpr(path: StmtPath, sel: ExprSel[], expr: Expr): void {
    const stmt = M.getStmt(this._program, path);
    if (!stmt) return;
    const nextStmt = M.replaceExprSlot(stmt, sel, expr);
    this.commit(M.replaceStmt(this._program, path, nextStmt));
  }

  // -- nested expression blocks ---------------------------------------------------

  private renderNestedExpr(stmt: Stmt, path: StmtPath, sel: ExprSel[], expr: Expr): HTMLElement {
    switch (expr.kind) {
      case 'callBuiltin': {
        const block = el('span', 'expr-block');
        block.append(el('span', 'label', expr.name));
        const decl: CallableDecl | undefined = getBuiltin(expr.name);
        expr.args.forEach((arg, i) => {
          block.append(
            this.renderSocket(stmt, path, [...sel, `arg:${i}`], arg, decl?.args[i]?.type ?? null, decl?.args[i]?.name),
          );
        });
        return block;
      }
      case 'member': {
        const block = el('span', 'expr-block');
        block.append(this.renderSocket(stmt, path, [...sel, 'object'], expr.object, null));
        block.append(el('span', 'op', '.'));
        const field = el('input') as HTMLInputElement;
        field.className = 'var-field';
        field.style.maxWidth = '90px';
        field.value = expr.field;
        field.addEventListener('change', () => {
          const name = field.value.trim();
          if (!IDENT_RE.test(name)) return;
          const current = M.getExprSlot(M.getStmt(this._program, path)!, sel);
          if (current?.kind === 'member') {
            this.commitSocketExpr(path, sel.slice(0, -1), { ...current, field: name });
          }
        });
        block.append(field);
        return block;
      }
      case 'binary': {
        const block = el('span', 'expr-block');
        block.append(this.renderSocket(stmt, path, [...sel, 'left'], expr.left, null));
        const op = el('select') as HTMLSelectElement;
        for (const o of BINARY_OPS) {
          const opt = el('option', undefined, o) as HTMLOptionElement;
          opt.value = o;
          op.append(opt);
        }
        op.value = expr.op;
        op.addEventListener('change', () => {
          const current = M.getExprSlot(M.getStmt(this._program, path)!, sel);
          if (current?.kind === 'binary') {
            this.commitSocketExpr(path, sel.slice(0, -1), { ...current, op: op.value });
          }
        });
        block.append(op);
        block.append(this.renderSocket(stmt, path, [...sel, 'right'], expr.right, null));
        return block;
      }
      case 'unary': {
        const block = el('span', 'expr-block');
        block.append(el('span', 'op', expr.op === 'not' ? 'not' : '−'));
        block.append(this.renderSocket(stmt, path, [...sel, 'operand'], expr.operand, null));
        return block;
      }
      case 'list': {
        const block = el('span', 'expr-block list');
        block.append(el('span', 'op', '['));
        expr.elements.forEach((elem, i) => {
          block.append(this.renderSocket(stmt, path, [...sel, `elem:${i}`], elem, null));
          const rm = el('button', 'adder', '−');
          rm.addEventListener('click', () =>
            this.commitSocketExpr(path, sel, { ...expr, elements: expr.elements.filter((_, j) => j !== i) }),
          );
          block.append(rm);
        });
        block.append(el('span', 'op', ']'));
        const add = el('button', 'adder', '+ item');
        add.addEventListener('click', () =>
          this.commitSocketExpr(path, sel, { ...expr, elements: [...expr.elements, M.numLit(0)] }),
        );
        block.append(add);
        return block;
      }
      default:
        // unreachable per shouldRenderAsTextField, but never render wrong
        return this.renderSocket(stmt, path, sel, expr, null);
    }
  }

  // -- fields -----------------------------------------------------------------

  private varField(value: string, onCommit: (name: string) => void): HTMLInputElement {
    const input = el('input') as HTMLInputElement;
    input.className = 'var-field';
    input.value = value;
    input.addEventListener('change', () => {
      const name = input.value.trim();
      if (IDENT_RE.test(name)) {
        onCommit(name);
      } else {
        input.classList.add('invalid');
        input.title = 'invalid name';
      }
    });
    return input;
  }

  private assignTargetSelect(path: StmtPath, current: string): HTMLSelectElement {
    const select = el('select') as HTMLSelectElement;
    select.className = 'var-field';
    const names = M.visibleInScopeLets(this._program, path);
    if (!names.includes(current)) names.unshift(current);
    for (const name of names) {
      const opt = el('option', undefined, name) as HTMLOptionElement;
      opt.value = name;
      select.append(opt);
    }
    select.value = current;
    select.addEventListener('change', () => {
      const stmt = M.getStmt(this._program, path);
      if (stmt?.kind === 'assign') this.updateStmt(path, { ...stmt, name: select.value });
    });
    return select;
  }

  // -- statement edit operations (all path-based, all re-validate + re-render) ---

  private updateStmt(path: StmtPath, next: Stmt): void {
    this.commit(M.replaceStmt(this._program, path, next));
  }

  private renameVar(path: StmtPath, name: string): void {
    const stmt = M.getStmt(this._program, path);
    if (stmt?.kind === 'let') this.updateStmt(path, { ...stmt, name });
  }

  private deleteStmt(path: StmtPath): void {
    this.commit(M.spliceStmt(this._program, path, 1));
  }

  private moveBy(path: StmtPath, delta: -1 | 1): void {
    const { list, index } = M.splitPath(path);
    this.moveStmtTo(path, [...list, index + delta]);
  }

  /** Move the statement at `from` to `to` (destination index, insert-before semantics). */
  moveStmtTo(from: StmtPath, to: StmtPath): void {
    this.commit(M.moveStmt(this._program, from, to));
  }

  private addElseIf(path: StmtPath): void {
    const stmt = M.getStmt(this._program, path);
    if (stmt?.kind !== 'if') return;
    this.updateStmt(path, {
      ...stmt,
      branches: [...stmt.branches, { cond: M.boolLit(true), body: [] }],
    });
  }

  /** Append a fresh statement for the palette item to the end of the program. */
  appendFromPalette(itemId: string): void {
    const item: PaletteItem | undefined = this.palette
      .flatMap((g) => g.items)
      .find((i) => i.id === itemId);
    if (!item) return;
    const stmt = item.make(this.reg);
    this.commit(M.spliceStmt(this._program, [this._program.statements.length], 0, stmt));
  }

  // -- drag & drop (pointer events, zero deps) -----------------------------------

  private attachDrag(handle: HTMLElement, block: HTMLElement, path: StmtPath): void {
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.drag = { from: path };
      block.classList.add('dragging');
      block.style.opacity = '0.45';
      handle.setPointerCapture(e.pointerId);
      const lists = () => this.root.querySelectorAll('[data-list]');
      const clear = () => lists().forEach((l) => l.classList.remove('drop-into'));
      const targetAt = (x: number, y: number): { list: StmtPath; index: number } | null => {
        const hit = this.root.elementFromPoint(x, y);
        const listEl = hit?.closest?.('[data-list]') as HTMLElement | null;
        if (!listEl?.dataset.list) return null;
        const list = JSON.parse(listEl.dataset.list) as StmtPath;
        let index = 0;
        for (const child of Array.from(listEl.children)) {
          if (!(child as HTMLElement).dataset?.path) continue;
          const rect = (child as HTMLElement).getBoundingClientRect();
          if (y > rect.top + rect.height / 2) index++;
        }
        return { list, index };
      };
      const onMove = (ev: PointerEvent) => {
        clear();
        const t = targetAt(ev.clientX, ev.clientY);
        if (t) {
          const sel = `[data-list='${JSON.stringify(t.list)}']`;
          this.root.querySelector(sel)?.classList.add('drop-into');
        }
      };
      const onUp = (ev: PointerEvent) => {
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        clear();
        const t = targetAt(ev.clientX, ev.clientY);
        block.style.opacity = '';
        if (t && this.drag) this.moveStmtTo(this.drag.from, [...t.list, t.index]);
        else this.render();
        this.drag = null;
      };
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
    });
  }
}

function paletteClass(item: PaletteItem): string {
  if (item.id.startsWith('call:')) return 'call';
  if (item.id.startsWith('state:')) return 'state';
  if (item.id === 'let' || item.id === 'assign') return 'variables';
  return 'control';
}
