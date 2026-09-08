/**
 * Stylesheet for `<spelllang-editor>`, injected into its shadow root.
 * Themable via CSS custom properties (see BLOCKS.md §Theming); a dark
 * Blockly-like default ships out of the box.
 */

export const BLOCK_CSS = `
:host {
  --sl-bg: #1e1e28;
  --sl-panel: #262633;
  --sl-text: #e8e8f0;
  --sl-dim: #9a9ab0;
  --sl-accent: #4f9cf9;
  --sl-control: #4f9cf9;   /* if / for / stop */
  --sl-look: #8a5cf6;      /* let / assign / state */
  --sl-call: #2fb56b;      /* host callables */
  --sl-expr: #e8a33d;      /* expression sockets */
  --sl-danger: #e05555;
  --sl-radius: 8px;
  display: block;
  font-family: system-ui, sans-serif;
  font-size: 14px;
  color: var(--sl-text);
  background: var(--sl-bg);
}
* { box-sizing: border-box; }
.root { display: flex; align-items: flex-start; gap: 12px; padding: 12px; min-height: 200px; }

/* palette */
.palette { flex: 0 0 200px; background: var(--sl-panel); border-radius: var(--sl-radius); padding: 8px; max-height: 70vh; overflow-y: auto; }
.palette h3 { margin: 8px 4px 4px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--sl-dim); }
.palette .item { display: block; width: 100%; text-align: left; margin: 3px 0; padding: 6px 8px; border: 0; border-radius: 6px; color: #fff; font-size: 13px; cursor: grab; }
.palette .item.control { background: var(--sl-control); }
.palette .item.variables, .palette .item.state { background: var(--sl-look); }
.palette .item.call { background: var(--sl-call); }
.palette .item:hover { filter: brightness(1.12); }

/* canvas */
.canvas { flex: 1; min-width: 0; }
.stmt-list { display: flex; flex-direction: column; gap: 8px; min-height: 12px; padding: 4px; border-radius: var(--sl-radius); }
.stmt-list.empty { outline: 2px dashed var(--sl-dim); outline-offset: -2px; min-height: 40px; }
.stmt-list.drop-into { outline: 2px solid var(--sl-accent); }

/* blocks */
.block { position: relative; border-radius: var(--sl-radius); padding: 6px 8px; background: var(--sl-panel); }
.block.control { background: var(--sl-control); color: #fff; }
.block.variables, .block.state { background: var(--sl-look); color: #fff; }
.block.call { background: var(--sl-call); color: #fff; }
.block.stop { background: var(--sl-danger); color: #fff; }
/* Two flex zones: .head-main (content) wraps freely and flexes to fill;
   .ctl never wraps and sits at the block's right edge, aligned with the
   content's first row. */
.block .head { display: flex; align-items: flex-start; gap: 6px; }
.block .head-main { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; flex: 1 1 auto; min-width: 0; }
.block .label { font-weight: 600; }
.block .child { margin-top: 6px; background: rgba(0, 0, 0, 0.22); border-radius: 6px; }
.block .else-label { margin-top: 6px; font-style: italic; opacity: 0.85; }

/* controls: drag handle lives in .head-main; ↑↓✕ are a .head sibling, so
   they stay pinned right even when the content wraps onto several lines. */
.ctl { display: inline-flex; gap: 2px; flex: none; opacity: 0.55; padding-top: 2px; }
.block:hover .ctl { opacity: 1; }
.ctl button, .adder { border: 0; border-radius: 4px; background: rgba(0, 0, 0, 0.3); color: inherit; font-size: 12px; padding: 1px 6px; cursor: pointer; }
.ctl button:hover, .adder:hover { background: rgba(0, 0, 0, 0.5); }
.drag-handle { cursor: grab; }
.adder { margin-top: 4px; }

/* sockets */
.socket { display: inline-flex; align-items: center; gap: 4px; background: rgba(0, 0, 0, 0.28); border-radius: 999px; padding: 2px 8px; min-height: 24px; }
.socket .socket-name { font-size: 11px; opacity: 0.8; font-style: italic; }
.socket input, .socket select { border: 0; border-radius: 999px; padding: 2px 8px; font: inherit; color: #222; background: #fff; min-width: 48px; max-width: 240px; }
.socket input[type='text'] { min-width: 90px; }
.socket.invalid input { background: #ffd7d7; outline: 2px solid var(--sl-danger); }
.socket.drop-into { outline: 2px dashed #fff; }
.var-field { border: 0; border-radius: 999px; padding: 2px 8px; font: inherit; color: #222; background: #fff; min-width: 56px; }

/* nested expression blocks */
.expr-block { display: inline-flex; align-items: center; gap: 4px; flex-wrap: wrap; background: var(--sl-expr); color: #fff; border-radius: 999px; padding: 2px 8px; }
.expr-block .op { font-weight: 700; }
.expr-block.list { border-radius: var(--sl-radius); }
`;
