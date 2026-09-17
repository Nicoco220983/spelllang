# Backlog — feature requests from host usage (voxspell)

Feature ideas motivated by real generated NPC-behavior scripts in the voxspell
host (event-driven step functions over `context`/`state`, see voxspell's
`ARCHITECTURE.md` §10). Tiered by value; each entry notes why it matters for
LLM-generated code specifically, and how it fits the design principles in
`DESIGN.md` (one way to write each construct, static validation first,
fuel-bounded, round-trip-stable AST).

## P1 — the plan (ordered, do top to bottom)

> Status 2026-09-14: **P1.1–P1.9 are all shipped.** Notes: P1.8 required a
> real `none` literal (new AST node, reserved word) — comparing against
> `none` was not even parseable before; the literal and the presence-test
> rule are documented in GRAMMAR.md. P1.9 landed `ExecResult.stateChanged`
> and failure stack traces in one revision, as planned below. `append` and
> `contains` burn ~n fuel (one per element copied/examined) and `append`
> enforces `maxListLength`.

Language-surface items first (they define what seed scripts and prompt
templates are written against), then the host-contract item — **P1.8 and
P1.9 touch `ExecResult`/`RunInputs` and should land in one revision.**

### P1.1 `append(list, x)` builtin — general-purpose script memory

State fields can be declared `list<string>` and iterated, but there is **no
way to grow a list** — so "remember which players I've greeted" is
unexpressible: `contains` (P1.5) can check a persisted list, nothing can
build one. Without this, hosts are pushed toward Core-side per-entity memory
mechanisms (new intents, new surface) for what should be script state —
exactly the per-behavior Core-feature growth the host's interface philosophy
forbids. `state.guests = append(state.guests, e.id)`, fuel ~n, returns a new
list (no mutation of the input). Ships with a conformance test that a
list-typed state field survives run→run persistence with repeated appends
(and respects `maxListLength` / `stateSlots`).

### P1.2 String concatenation (`+` on two strings)

Dialogue is the core passive-NPC behavior, and scripts currently cannot
personalize it at all — strings are opaque (equality + pass-to-callable only):

```spelllang
call say("Welcome back, " + p.name + "! This is visit " + state.visits + ".")
```

- Typing rule: `+` requires both operands numeric **or** both string; a
  mixed operand pair is a validation error (`type-mismatch`).
- Fits `addExpr` (DESIGN.md §1.2 level 5); no new statement form.
- LLM-feasibility: models already reach for `+` instinctively — today that
  produces a validator error and a retry round-trip. Removing an entire
  error class, not just adding expressiveness.
- Fuel cost: 1, same as numeric `+`.

### P1.3 `len(list)` builtin

There is currently no way to test list emptiness — "if anyone is sensed" is
unexpressible without a scan-with-flag. One entry in the fixed builtin
registry (DESIGN.md §3), fuel cost 1. (`len` over `count`: it is the name
LLMs guess.)

### P1.4 List indexing, `list[i]`

The v1 "never index" rule reads as a simplification, not a principle.
Indexing is an *expression* — it adds no loop form — and bounds are checkable
statically for literals/constant ranges, at runtime otherwise (the existing
`runtime-error` path, same as division by zero). This collapses the most
common NPC pattern:

```spelllang
// today: four if-chains
if state.wp == 0 { call setAction(WalkTo { x: 10, z: 10, timeout: 400 }) }
if state.wp == 1 { call setAction(WalkTo { x: 10, z: 42, timeout: 400 }) }
...
// with indexing
let corners = [[10, 10], [10, 42], [42, 42], [42, 10]]
call setAction(WalkTo { x: corners[state.wp][0], z: corners[state.wp][1], timeout: 400 })
```

Fuel cost: 1 (+ the index expression's cost). Keeps `for` as the only loop.

### P1.5 `contains(list, x)` builtin

"Greet each player exactly once" needs membership in persisted state.
Today: a full scan with a flag, made clumsy by the absence of `break`.
`contains(state.guests, e.id)`, fuel ~n, short-circuits. (Depends on P1.1
for the pattern to be writable end-to-end.)

### P1.6 `randomInt(min, max)` builtin

`floor(random() * n)` works but is an off-by-one factory in generated code.
`randomInt(1, 6)` draws from the existing seeded PRNG (mulberry32 — stays
deterministic per run), fuel cost 1.

### P1.7 `sqrt` builtin

`min/max/abs/floor/ceil/round/distance/random/range` exist; `sqrt` does not.
Combat-tier scripts computing ranges from scalar components will guess it —
one more validator-error class to remove. Fuel cost 1. (`pow` can wait for a
real caller.)

### P1.8 Optional-field `none` comparison

DESIGN.md §1.3 says omitted optional record fields become `none`, but it is
unspecified whether `==`/`!=` against `none` is legal. Hosts that flatten
event unions into one record (voxspell's `Event { kind, x?, z?, id?, … }`)
need presence tests (`e.id != none`) for robust scripts. If already legal,
document it in the grammar; if not, allow it — cheap either way.

### P1.9 Host contract: `stateChanged` flag + error stack traces (`ExecResult`)

Two additive `ExecResult` changes, one revision:

- **`stateChanged: boolean`** — the interpreter deep-copies `state` in at
  entry and copies the updated record out at exit. Whether a program can
  assign state is statically known; whether a *run* assigned state is a
  runtime fact. When no `stateAssign` executed, return the input record by
  reference and set `stateChanged: false` — the common "events empty,
  nothing to do" run then costs zero state copies (the biggest remaining
  per-run allocation after context building).
- **Error stack traces** — on `runtime-error` / `out-of-fuel`, attach the
  call stack with source locations to `ExecResult.error`. The interpreter
  already maintains a call stack (`callDepth` limit), so this is a walk of
  an existing structure, built **only on failure**: zero hot-path cost.
  This is the observability hook for the host's LLM-in-the-loop debug flow
  (voxspell D8: nobody hand-debugs generated scripts; the LLM does, from
  player feedback like "my goblin doesn't react when I approach"):

  1. The host keeps a small per-entity **ring buffer** (~50 runs) of
     host-side records — tick, events delivered (with payloads), own action,
     intents emitted, result, error+stack when present. The host built the
     context and receives the intents, so successful-run truth costs nothing
     inside the interpreter; no per-call tracing (deliberately — allocating
     a trace entry per `call` would tax the hot path for little value).
  2. On a patch request ("it doesn't react"), the host appends the buffer to
     the LLM's input — "here is what your script actually did recently" —
     so the model diagnoses from evidence instead of guessing: empty
     `events` every run → Core-side delivery problem (sense radius,
     distance), don't touch the script; events present but zero intents →
     script logic problem, with payloads showing why (e.g. `dist` 4–6 vs a
     `< 3` threshold). Errors and their stack traces must be in the record:
     a frozen NPC is usually an erroring script.
  3. Trace output is observability, not replay — no determinism commitment
     (D8 unchanged).

  Per-call tracing stays possible as a later opt-in flag if evidence-based
  patching ever proves insufficient; it is not in P1.

## Considered and rejected

### Static fuel analysis (parse-time fuel, no runtime accounting)

Rejected on host reconsideration. A static worst-case must assume
`maxListLength` (4096) for every loop over a context list (`events`,
`players`) whose real trip count is data-dependent and usually 0–3 — so the
static number is either meaningless (budget sized for the 4096 case: no real
protection) or rejects every honest script. Meanwhile runtime accounting is a
decrement-and-compare inside an interpreter already doing far more work per
node — cheap even at hundreds of entities × 20 runs/s. The genuine scaling
levers are runs per second and the fuel cap, not the accounting. Keeping
runtime `fuelUsed` also preserves a useful per-run debug signal (quiet runs
vs heavy runs) that a static number would erase. The bounded-execution
property survives without computing anything: no `while`/recursion plus the
runtime cap means validated programs cannot run unboundedly.

## Deferred — medium value

### Host query callables (registerable expression builtins with impls) — SHIPPED 2026-09-17

Landed as designed below (it amended the DESIGN.md §3 "fixed registry only"
rule — that section is now "fixed core, host-extensible via queries"):

- Decl in the host config (`queries`) or `registerQuery`: name, typed args,
  `returnType` (host record types by name work — the driver use case,
  voxspell's `getAction() -> ActionInfo`, type-checks
  `getAction().completedTick != none` end to end), `fuelCost?` (default 1),
  doc. Fail-fast config validation: duplicate names, builtin-name collisions,
  undeclared enum/record references.
- Per-run impls ride a parallel `queryImpls` channel (query name → sync
  `(args) => value`); purity (no I/O, no wall-clock) is a documented host
  contract. Missing impl / throw / wrong-shape return → `invalid-call`,
  exactly like `callablesImpl`.
- Same closed world as builtins: the parser stays registry-free (any
  `IDENT(` in an expression parses to the existing `callBuiltin` node) and
  the validator resolves builtins ∪ queries; unknown names → `unknown-query`
  with typo suggestions. No new AST node.
- Fuel charged per call; results deep-copied at the host API edge;
  `renderPromptRegistry(callables, queries?)` renders a `[queries]` group.

Remaining (deliberately out of scope there):

- **Block surface** — `src/blocks/` builds its Registry without queries and
  BLOCKS.md still documents `callBuiltin` as "fixed builtin registry"
  signatures; query-call blocks (palette entry, socket signatures) are the
  follow-up. Today a query call fails validation inside the editor.
- **voxspell wiring** — the declared-but-unwired reads in voxspell's
  `shared/entity-spelllang.js` (ARCHITECTURE.md §10 query callables) can now
  be connected to real `queryImpls`.

### `match` / `switch` on enum tags

Every event-driven brain is an `if e.kind == A … else if …` chain over a
discriminant enum. A `match` statement would cut boilerplate and reduce
typo-rate (one tag per arm instead of N repeated comparisons). Bigger change:
new statement kind, block-surface rendering, round-trip property tests.
Do after P1 — `else if` chains are serviceable in the meantime.

## Deferred — long-term (language-semantics project)

### Tagged unions for host events

The flattened optional-field record is a workaround for the lack of
discriminated unions. Real per-kind payloads with exhaustive `match`:

```spelllang
match e {
    playerEnter { id, dist, x, z } -> { … }
    timer -> { … }
}
```

would let hosts type `events` as a true sum type and make taxonomies
self-documenting in `renderPromptRegistry`. P1 + the flattened record
covers ~90% of the value, so this can wait for real host demand.

### Compiler backend: validated AST → JS function

Transpile once per program (at parse), reuse as a stateless function
`(state, context, seed) → { intents, state, fuelUsed }` across all callers.
Feasible *because* the language is restricted: `call` → host closure, `for`
→ bounded loop, fuel → injected decrement checks (P1.10 makes even those
coarse). Safety note: the JS is generated from the validated AST, never from
raw LLM text — the trust surface is the compiler itself, same as the
interpreter's. Must keep the `SpellLang.run` host contract identical so
hosts swap interpreter↔compiled per program without churn. Buys back the
10–50× AST-dispatch factor; only worth it after P1 lands and profiling still
shows the interpreter as the bottleneck at host scale (voxspell: 64 NPCs ×
20 runs/s — it currently is not).

## Explicitly not requested

Kept out on purpose — voxspell's Core design relies on these absences:

- **`while` / general recursion / user-defined functions** — the safety
  property: spin-waiting over time is unexpressible, so generated code
  cannot produce timing bugs. Non-negotiable, in the good direction.
- **`break` / `continue`** — the `stop`-handles-one-event-per-run idiom
  turned out to be a feature (bounds per-run work naturally). Document the
  idiom in the grammar's `== EXAMPLE ==` section instead of extending the
  language.

## Grammar-size note

`GRAMMAR.md` targets ~90 lines and every addition costs prompt budget.
P1's language items add ~10–12 lines but each removes a whole error class
(concat guesses, index guesses, empty-check workarounds, off-by-one
`floor(random()*n)`, `sqrt` guesses), so they are net-positive for LLM
compliance, not just expressiveness. Revisit the deferred tiers if the
grammar starts pushing the target size.
