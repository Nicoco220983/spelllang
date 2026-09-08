# SpellLang — Block Surface Spec

> Formal mapping between the SpellLang AST (the single source of truth, see
> `DESIGN.md` §2) and its block rendering in `<spelllang-editor>` (zero-dep
> web component, `spelllang/blocks`). Contract companion to `SPELLLANG.md`
> §8: every valid AST is representable as blocks and back, losslessly.

---

## 1. Principles

1. **No intermediate representation.** The block UI edits the AST directly.
   Each AST node kind has exactly one block rendering; each block produces
   exactly one node. There is nothing else to round-trip.
2. **The validator is the authority.** A socket's content is parsed by the
   same expression parser and validated by the same validator as the text
   surface. Invalid input → red field plus the same machine-readable error
   JSON (`{line, col, code, message}`); the AST is left untouched.
3. **Presentation never changes meaning.** Every rendering choice below is a
   pure function of the AST (implemented in `src/blocks/mapping.ts`).

## 2. Socket render rule (normative)

Quoting `DESIGN.md` §8:

> An expression renders as a text field iff it contains at most one function
> call and no member access on a call result; otherwise nested blocks.

Applied recursively per socket. Consequently:

| Expression | Rendering |
|---|---|
| `1 + 2 * 3`, `a or b`, `goblin.hp < 5`, `state.patience - 1` | inline text field |
| `distance(a, b) * 2`, `min(x, 1)` (one call) | inline text field |
| `min(abs(x), 2)` (two calls) | nested blocks |
| `nearest(goblins).pos` (member on a call result) | nested blocks |

On top of the rule, literal sockets are specialized (never changing the AST
mapping, only the widget):

| Socket content / declared type | Widget |
|---|---|
| `num` literal, expected `int`/`float` (or unconstrained) | round number input |
| `enum` literal (or enum-typed socket) | dropdown of the enum's values |
| `bool` literal | `true`/`false` dropdown |
| everything else that passes the rule | text input |

Enum dropdowns list the values of the enum's `TypeDecl` (or the arg's
`domain.enumValues`). A non-literal expression in an enum-typed socket (e.g. a
variable) renders as a dropdown whose options include the current text, so no
meaning can be lost in rendering.

## 3. Statement blocks

Block addressing uses statement paths (`mapping.ts`): `[2]` is the third root
statement; `[2, 'body:0', 1]` is the second statement of the first `if`
branch of root statement 2. `else` and `body:<n>` keys descend into `if`
bodies; `body:0` descends into a `for` body.

| AST node | Block | Sockets / fields | Palette group |
|---|---|---|---|
| `call` | `call NAME(arg…)` | one socket per arg, labeled with the arg name and typed by the `CallableDecl`; optional trailing args start omitted and can be added (`+ name`) / removed (`−`) | callable's `category` (default **Actions**) |
| `let` | `let x = ▢` | variable name field (identifier); value socket (unconstrained type) | Variables |
| `assign` | `x = ▢` | target dropdown (the `let`/`for` names in scope at that position); value socket | Variables |
| `stateAssign` | `state.f = ▢` | field dropdown (from `stateShape`); value socket typed by the field's declared type | State (hidden when no `stateShape`) |
| `if` | C-block: one row per branch (`if` / `else if`) with its own body list; optional `else` row | one condition socket per branch (expected `bool`); `+ else if`, `+ else`, branch `✕` controls | Control |
| `for` | C-block `for x of ▢` | loop variable field (identifier); iterable socket; body list | Control |
| `stop` | red cap block | none | Control |

Every statement block carries a drag handle (`⋮⋮`) and `↑` `↓` `✕` controls,
so reordering, nesting (via drag into a C-block body), and deletion work with
or without drag & drop.

## 4. Nested expression blocks

Rendered when the socket rule (§2) demands nested blocks:

| AST node | Rendering |
|---|---|
| `callBuiltin` | pill block `name(arg…)` with typed arg sockets (signatures from the fixed builtin registry) |
| `member` | object socket + `.field` text field |
| `binary` | left socket · operator dropdown (`+ - * / % == != < <= > >= and or`) · right socket; committing an operator keeps both operands (the validator flags type nonsense with the usual error JSON) |
| `unary` | `not`/`−` label + operand socket |
| `list` | `[ ▢ − … ]` element sockets with per-element `−` and a `+ item` control |

## 5. Palette composition

The palette is the grammar (`SPELLLANG.md` §3.3): it is derived from the host
registry, so hosts hide blocks they don't support by not registering those
callables. Groups, in order:

1. **Control** — `if … else`, `for item of list`, `stop`
2. **Variables** — `let x = …`, `x = …`
3. **State** — one item per `stateShape` field (only present when a state
   shape is declared)
4. **One group per callable `category`** — `call NAME(…)` per registered
   callable; callables without a category land in **Actions**

Clicking a palette item appends a fresh block to the end of the program. Fresh
blocks are valid-by-construction: required args are pre-filled with default
literals for their declared types (`int/float → 0`, `bool → false`,
`string → ""`, `enum → first value`, `list → []`); types with no literal form
(`record`, `vec`) fall back to `0`, which the validator flags as a type error
— an explicit "fill me" state.

## 6. Editing model & events

- Every edit produces a new AST, re-validates the whole program, re-renders,
  and fires a `change` event (`bubbles`, `composed`) with
  `detail = { program, text, errors }`. `program` is a deep copy.
- `editor.config = { callables, types, stateShape, contextShape, limits }`
  (same shape as `new SpellLang(…)`; fails fast on malformed config).
- `editor.program = someProgram` loads a program (deep-copied);
  `editor.text` returns the canonical text; `editor.validationErrors` the
  current error list.
- Validation errors are shown in an error bar (up to 5, then a count).
- Identifier fields (`let`/`for` names) accept only identifier syntax; a
  rename does not rewrite references — dangling references surface as ordinary
  `unknown-identifier` validation errors.
- Drag & drop uses pointer events: drag a block by its handle into any
  statement list (root, `if`/`else` bodies, `for` bodies). The same moves are
  available without drag via `↑`/`↓`.

## 7. Round-trip guarantees

- text ⇄ AST: unchanged from `DESIGN.md` §2 (printer/parser contract).
- AST ⇄ blocks: rendering is a pure function of the AST; the editor never
  stores state outside the AST. Loading a program and re-rendering is
  identity; edits keep the program a valid AST at all times (invalid *text*
  in a field is not committed).
- Blocks ⇄ text: `editor.text` after any edit prints canonical text that
  parses back to the same AST.
- Property tests (`test/blocks.roundtrip.property.test.ts`) cover the socket
  rule's idempotence (`shouldRenderAsTextField(parse(printExpr(e))) ===
  shouldRenderAsTextField(e)`) and print⇄parse stability over generated
  programs.

## 8. Theming

The editor uses a shadow root; hosts theme it with CSS custom properties on
the element: `--sl-bg`, `--sl-panel`, `--sl-text`, `--sl-dim`, `--sl-accent`,
`--sl-control`, `--sl-look`, `--sl-call`, `--sl-expr`, `--sl-danger`,
`--sl-radius`. Every significant element exposes a `part` name / class.

## 9. Known limitations (v1)

- `let`/`for` renames do not rewrite references (validation reports them).
- Enum dropdowns commit literals; variables in enum-typed sockets keep their
  text via an extra option but cannot be *switched to* from a literal.
- Drag & drop is statement-level; expression restructuring happens through
  sockets (text fields and nested blocks).
- No undo/redo.
