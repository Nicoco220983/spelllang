# SpellLang — Implementation Design (v1)

> Companion to `SPELLLANG.md` (the contract). This document fixes the concrete
> syntax, AST shapes, error format, and interpreter semantics decisions needed
> to implement v1. Where `SPELLLANG.md` and this file disagree, the spec wins.

---

## 1. Concrete syntax

Principles: keyword-led statements, braces for blocks, insignificant
whitespace, newline/semicolon statement termination, `//` comments, optional
trailing commas. One — and only one — way to write each construct.

### 1.1 Program

```ebnf
program    := statement*
statement  := callStmt | letStmt | assignStmt | stateAssign | ifStmt
            | forStmt | stopStmt
callStmt   := "call" IDENT "(" args ")"
letStmt    := "let" IDENT "=" expr            ; declaration, types the variable
assignStmt := IDENT "=" expr                  ; reassignment, type must match the declaration
stateAssign:= "state" "." IDENT "=" expr
ifStmt     := "if" expr block ("else" "if" expr block)* ("else" block)?
forStmt    := "for" IDENT "of" expr block     ; the single loop form; use
                                               ; range(start, end) for counting loops
stopStmt   := "stop"
block      := "{" statement* "}"
args       := (expr ("," expr)* ","?)?
```

Notes:

- `call` invokes a **host callable** (statement position only — no value).
- Expression-position function calls exist only for the fixed builtin helpers
  (`min max abs floor ceil round distance random`), see §3.
- `state.<field>` refers to the host-predeclared state record. Fields are
  declared by the host, not the script; unknown fields are validation errors.
  Scripts never declare state — they read/write `state.<field>` directly.

### 1.2 Expressions

Classic precedence, tightest binding last:

| Level | Operators | Notes |
|-------|-----------|-------|
| 1 (loosest) | `or` | short-circuit |
| 2 | `and` | short-circuit |
| 3 | `not` | unary |
| 4 | `== != < <= > >=` | non-associative (chain = validation error) |
| 5 | `+ -` | left-assoc |
| 6 | `* / %` | left-assoc |
| 7 | `-` | unary minus |
| 8 | `.field`, call args | postfix |

```ebnf
expr     := orExpr
orExpr   := andExpr ("or" andExpr)*
andExpr  := notExpr ("and" notExpr)*
notExpr  := "not" notExpr | cmpExpr
cmpExpr  := addExpr (("=="|"!="|"<"|"<="|">"|">=") addExpr)?
addExpr  := mulExpr (("+"|"-") mulExpr)*
mulExpr  := unary (("*"|"/"|"%") unary)*
unary    := "-" unary | postfix
postfix  := primary ("." IDENT | "(" args ")")*
primary  := NUMBER | STRING | "true" | "false" | IDENT
          | "[" (expr ("," expr)* ","?)? "]" | "(" expr ")"
```

Identifier resolution (in order): local variable → `state` field →
context field → enum literal → validation error "unknown identifier".
Context is a host-declared record (like `state`, but per-invocation): its
fields resolve as bare identifiers (`goblins`, `player`), so scripts read as
"the world as you see it now", while `state.<f>` stays explicitly prefixed to
make persistence visible. Enum values are plain identifiers from the
host-registered enum registry (e.g. `DIRT`, `STONE`); convention is
UPPER_SNAKE but enforcement is registry membership, not casing.

Strings: `"..."` with escapes `\"`, `\\`, `\n`. Opaque: equality + passing to
callables only.

### 1.3 Literals & types

| Type | Text form | Notes |
|------|-----------|-------|
| int | `42`, `-7` | exact; host int range enforced in validator if declared |
| float | `3.14`, `-0.5` | |
| bool | `true`, `false` | |
| string | `"text"` | opaque |
| enum | `DIRT` | host-registered |
| list | `[1, 2, 3]` | homogeneous element type inferred; max length from host type decl or static literal length |
| object | (never literal) | host-declared records, values arrive via `state`/`context`/callables |

## 2. AST

Plain JSON, every node carries `loc: {line, col}` (1-based). Root:
`{ langVersion: 1, statements: [...] }`.

```ts
type Stmt =
  | { kind: 'call', name: string, args: Expr[] }
  | { kind: 'let', name: string, value: Expr }
  | { kind: 'assign', name: string, value: Expr }           // reassignment, type must match
  | { kind: 'stateAssign', field: string, value: Expr }
  | { kind: 'if', branches: { cond: Expr, body: Stmt[] }[], elseBody: Stmt[] | null }
  | { kind: 'for', variable: string, iterable: Expr, body: Stmt[] }
  | { kind: 'stop' }

type Expr =
  | { kind: 'num', value: number, isInt: boolean }
  | { kind: 'str', value: string }
  | { kind: 'bool', value: boolean }
  | { kind: 'enum', name: string }
  | { kind: 'list', elements: Expr[] }
  | { kind: 'var', name: string }
  | { kind: 'stateField', field: string }                  // desugared from state.<f>
  | { kind: 'contextField', field: string }                // reclassified from bare var
  | { kind: 'member', object: Expr, field: string }
  | { kind: 'binary', op: string, left: Expr, right: Expr }
  | { kind: 'unary', op: '-' | 'not', operand: Expr }
  | { kind: 'callBuiltin', name: string, args: Expr[] }    // fixed set only
```

The AST is the round-trip-stable artifact: text ⇄ AST must be lossless
(idempotent after one normalization pass), per `SPELLLANG.md` §8.

The parser is registry-free: every bare identifier parses as `var`, and the
validator reclassifies it in place to `stateField`, `contextField`, or
`enum` per §1.2's resolution order (adding `{ kind: 'contextField', field: string }`
to `Expr`). Thus `state`/`context`/enums are validation-time concepts; the
parser only knows syntax.

## 3. Builtin helper registry (fixed)

| Name | Signature | Fuel cost |
|------|-----------|-----------|
| `min(a,b)`, `max(a,b)` | (num, num) → num | 1 |
| `abs(x)` | (num) → num | 1 |
| `floor(x)`, `ceil(x)`, `round(x)` | (num) → int | 1 |
| `distance(a,b)` | (vec, vec) → float | 2 |
| `random()` | () → float in [0,1) | 1 |
| `range(start, end)` | (int, int) → list of int | 1 |

`range` is half-open (`range(0, 3)` = `[0, 1, 2]`), direction follows the
sign of `end - start` (`range(3, 0)` counts down), and its length is bounded
by `limits.maxListLength` (§4).

`random()` draws from a run-local PRNG (mulberry32), seeded by `inputs.seed`
(host-provided; default 0). The seed and stream position live and die within
one `run` — no cross-run state.

Semantics that must be nailed down:

- `/` on two ints → float; `%` requires ints (validation error otherwise).
- Division by zero → **runtime error** (`runtime-error`), not an exception
  mechanism the script can catch.
- Float equality with `==` is allowed; hosts are warned in docs.
- Short-circuit: `and`/`or` return the boolean result of the *test*, always
  bool; no truthiness of non-bools (type error).

## 4. Validation (static, post-parse, before any execution)

All errors carry `line/col` from the node. The validator collects **all**
errors, never stops at the first.

1. **Identifiers**: unbound variables, unknown `state` fields, unknown enum
   names, unknown callables, unknown builtins (can't happen — parser rejects).
2. **Types**: first-assignment typing of `let` (rebinding a `let` to a
   different type = error); `state` field types are fixed by host declaration;
   operand/argument type matching; homogeneous lists; comparison operands
   compatible; `if` conditions are bool; `for` iterates a list.
3. **Value domains** (callable args): enum membership, numeric ranges,
   non-null where declared.
4. **Bounds**: list length ≤ `limits.maxListLength` (default 4096) —
   checked statically for literals and constant `range` bounds, at runtime
   otherwise (`runtime-error`); `state` slot count ≤ `limits.stateSlots`
   (host declaration enforces).
5. **Structure**: `stop` only at statement level (not inside expressions —
   grammar enforces); no empty program? allowed (no-op, but validation
   warning is fine).

## 5. Error JSON (machine-readable, LLM-retry-oriented)

```jsonc
{
  "ok": false,
  "errors": [
    {
      "line": 3, "col": 14,          // 1-based, node-localized
      "code": "unknown-callable",    // stable snake_case code
      "message": "Unknown callable 'setVoxelz'.",
      "expected": ["setVoxel", "setVoxels"],  // candidates when known
      "found": "setVoxelz"
    }
  ]
}
```

Parser errors use codes like `unexpected-token`, `unclosed-brace`,
`expected-expression`; validator codes like `unknown-identifier`,
`type-mismatch`, `enum-out-of-domain`, `list-too-large`. Messages are
phrased "expected X, found Y" wherever possible. Parser recovery: on error,
skip to the next line beginning with a statement keyword and continue — the
goal is the complete error list in one pass.

## 6. Interpreter semantics

- **Fuel**: every evaluated AST node costs 1; every callable call costs its
  declared `fuelCost`. Exhaustion → `{ result: 'out-of-fuel', fuelUsed }`
  at the exact node boundary; intents emitted so far are returned and the
  host decides policy.
- **Scope**: `let` is block-scoped (visible after declaration within its
  block and nested blocks). Shadowing a `let` with another `let` in a nested
  block is allowed.
- **`for` loop semantics**: iterate the list snapshot taken at loop entry
  (host can't mutate it mid-loop — values are copied into the run).
- **Copy semantics**: values crossing the run boundary (`state`, `context`,
  callable args/returns) are deep-copied at the host API edge. The script
  never holds a reference to host memory.
- **`stop`**: terminates the program immediately (result `ok`).
- **Result object**:
  ```ts
  {
    result: 'ok' | 'out-of-fuel' | 'runtime-error' | 'invalid-call',
    intents: Intent[],          // accumulated host-intent records
    state: StateRecord,         // updated (only if 'ok' or host chooses)
    fuelUsed: number,
    error?: { code, message }   // for runtime-error / invalid-call
  }
  ```
- A callable that throws / returns invalid data → `invalid-call` (host bug
  surfaced, not a script fault), run terminates.

## 7. Host API (TypeScript)

```ts
const runtime = new SpellLang({
  langVersion: 1,
  callables: { /* name → declaration */ },
  types: { /* record shapes, enums, list bounds */ },
  stateShape: { /* field → type, for the state record */ },
  limits: { fuel: 10_000, callDepth: 8, stateSlots: 16, maxResults: 512, maxListLength: 4096 },
});

const parsed = runtime.parse(text);           // { ok, program?, errors? }
const exec = runtime.run(parsed.program!, {
  state, context, seed, callablesImpl,
});
```

`renderPromptRegistry(callables)` renders declarations (signature + one-line
doc + value domains) for system prompts, per `SPELLLANG.md` §7.

## 8. Block surface — dual rendering (implemented)

> Status: implemented as the `<spelllang-editor>` web component
> (`spelllang/blocks`, zero dependencies) with the formal node⇄block mapping
> in `BLOCKS.md`. The rule below is normative; `src/blocks/mapping.ts` is the
> reference implementation and the property tests in
> `test/blocks.roundtrip.property.test.ts` pin its idempotence.

Each expression socket in a block renders as **inline editable text** or
**nested blocks**, decided by a deterministic, spec-fixed function of the AST

- **Text field** for simple expressions: `1 + 2 * 3`, `a or b`,
  `goblin.hp < 5`, `state.patience - 1`. Non-dev humans read and edit these
  as sentences.
- **Nested blocks** for complex ones: calls inside calls, member access on a
  call result, deeply nested arithmetic — where text becomes unreadable and
  nesting carries the meaning.

Both faces of one socket normalize to the **same AST node**: the text field
is parsed by the same expression parser and validated by the same validator
(invalid input → red field, same error JSON). The render function is a pure
function of the AST, e.g.:

> An expression renders as a text field iff it contains at most one function
> call and no member access on a call result; otherwise nested blocks.

Idempotence holds by construction (`render(parse(render(x))) == render(x)`);
round-trip property tests cover it. The threshold only affects presentation,
never meaning. Socket typing (round number ▢ vs hex boolean ⬡, enum
dropdowns) is unchanged — the block UI inherits exactly the validator's
guarantees.

## 9. Open implementation choices (non-blocking)

- PRNG: mulberry32 (documented above; swap later behind one function).
- `round` ties-to-even vs ties-away — pick ties-away-from-zero, document.
- Whether `if` without `else` requires braces — yes, always braces (one form).
