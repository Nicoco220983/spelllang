/**
 * spelllang block surface — browser entry point (`spelllang/blocks`).
 *
 * Importing this module defines the `<spelllang-editor>` custom element (the
 * definition is guarded: importing in a non-DOM environment is a no-op, and
 * double registration is ignored). The main `spelllang` entry stays DOM-free.
 */

export * from './mapping.js';
export { SpellLangEditorElement, type EditorChangeDetail } from './editor.js';
export { BLOCK_CSS } from './css.js';

import { SpellLangEditorElement } from './editor.js';

declare global {
  interface HTMLElementTagNameMap {
    'spelllang-editor': SpellLangEditorElement;
  }
}

if (typeof customElements !== 'undefined' && !customElements.get('spelllang-editor')) {
  customElements.define('spelllang-editor', SpellLangEditorElement);
}
