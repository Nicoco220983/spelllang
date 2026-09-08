# SpellLang — High-Level Specification

> Working name: **SpellLang** (provisional — pick the final name freely).
> Status: v0 draft for implementation planning. This document is the contract
> between the language project and its host projects (first host: VoxSpell).

---

## 1. Vision

SpellLang is a small, safe, embeddable scripting language designed for two
audiences at once:

1. **LLMs** — generating programs reliably from a compact, fully-described
   grammar that fits in a system prompt.
2. **Non-developer humans** — reading and tweaking programs through a
   block-based visual editor, where every language construct maps 1:1 to a
   block.

Scripts are authored by untrusted sources (LLM output, end users, shared
spell libraries) and executed inside host applications (games, tools, agents).
Safety is achieved **by construction**: programs are data (ASTs) interpreted
by the host, not executable code. There is nothing to sandbox because there
is no escape surface.

### Design north star

> A script is a declarative rule set with guarded control flow, executed by
> the host against the host's world — not a general-purpose program running
> in the host's process.

Resist Turing-completeness creep. Every feature must justify itself against
the two audiences above.

---

## 2. Goals and Non-Goals

### Goals

- **Total safety by construction**: no I/O, no reflection, no dynamic code,
  no global state access. Interpreter enforces hard resource limits (fuel,
  memory) with *preemptive*, deterministic interruption.
- **Host-extensible**: hosts inject typed helper functions ("callables") and
  data types. The same language core serves structure generation
  (`setVoxels`), entity AI (`nearest`, `moveTowards`), or any other domain.
- **Dual surface**: one canonical AST with (a) a terse text serialization
  (LLM-facing) and (b) a block-tree rendering (human-facing). Every valid AST
  is representable in both; round-trip must be lossless both ways.
- **High LLM reliability**: small grammar (~15 constructs), forgiving
  concrete syntax, total validation with machine-readable errors suitable for
  a generate→validate→retry loop.
- **Deterministic & bounded**: same script + same inputs = same outputs.
  Each run executes to completion or is preempted by fuel exhaustion —
  runs are short (fuel-bounded), so no mid-run suspension exists. Long-
  running behaviors are the host's concern: the host sets an adequate
  fuel budget per invocation and re-invokes per tick if needed.
- **Cheap to embed**: pure library, no native deps, runs in Node and
  browsers.

### Non-goals (v1)

- Turing completeness: no user-defined functions, no recursion, no
  higher-order constructs.
- String manipulation beyond literals and interpolation-free output.
- Concurrency, async, events/callbacks (a script runs to completion or is
  interrupted; hosts re-invoke it per tick).
- Performance parity with native code. Interpretation is the execution
  model; compilation of trusted scripts is a later, optional backend.

---

## 3. Core Architecture

```
text ──parse──▶ AST ──validate──▶ Program ──interpret──▶ results/intents
                    ▲                                      (fuel-bounded,
block UI ───────────┘ (1:1 mapping)                       deterministic)
```

Three public pillars:

### 3.1 AST (the single source of truth)

- A plain, JSON-serializable tree. Nodes are few and closed (see §5).
- The AST is the stable contract: text syntax and block UI are replaceable
  serializations of it.
- ASTs are versioned (`langVersion` field on the root node) so stored scripts
  can be migrated as the language evolves.

### 3.2 Text surface (LLM-facing)

- Terse, line-oriented, indentation-free (braces or keyword pairs — decide
  during detailed design; prefer forgiving separators: optional trailing
  commas, no significant whitespace, comments allowed).
- Every syntactic choice optimizes for *parse robustness*, not elegance.
- The full grammar description + 3–4 canonical examples must fit in ~100
  lines of an LLM system prompt.

### 3.3 Block surface (human-facing)

- Each AST node type has exactly one block representation; each block
  produces exactly one node. No pretty-printing ambiguity.
- The block palette is the grammar: hosts can hide blocks they don't support,
  which makes the editor *capability-configurable per project*.
- The language project ships the node↔block mapping spec (not necessarily the
  UI itself; a reference renderer is a nice-to-have).

---

## 4. Host Integration Model

The host is the authority. The language runtime is a library the host drives.

### 4.1 Host API (the surface host projects code against)

Sketch (language-agnostic; final API in TS, compiled to JS, ESM):

```ts
// 1. Construct a runtime configured by the host
const runtime = new SpellLang({
  langVersion: 1,
  callables: { ...host-defined helpers... },
  types: { ...host-defined data types (records/enums)... },
  limits: { fuel: 10_000, callDepth: 8, stateSlots: 16, maxResults: 512 },
});

// 2. LLM path: parse + fully validate; errors are machine-readable
const result = runtime.parse(text);
if (!result.ok) { /* result.errors: [{line, col, message, expected?}] */ }
const program = result.program;

// 3. Execute against host state
const exec = runtime.run(program, {
  state,          // opaque host-managed per-script state handle
  context,        // per-invocation data (tick number, target position, entity set...)
  callablesImpl,  // host implementations, injected per run (enables per-world scoping)
});
// exec.result: 'ok' | 'out-of-fuel' | 'runtime-error' | 'invalid-call'
// exec.intents / exec.returnValue / exec.state (updated) / exec.fuelUsed
```

Key properties:

- **Callables are declared (name, signature, cost, docs) at runtime
  construction** and implemented per-run. Declaration is used for static
  validation (unknown call = parse/validation error, never a runtime
  surprise) and for LLM prompt generation (the host can *render its
  callable registry into the system prompt automatically*).
- **State is host-managed**: the runtime only sees a typed, fixed-shape state
  record declared by the host. Scripts get scoped `let` slots (bounded,
  typed); nothing else persists.
- **No callbacks, no events**: the host calls the runtime; the runtime never
  calls back into host code except through declared callables, which must be
  pure-from-the-script's-perspective (return values only; side effects only
  via intents or explicit host contracts).

### 4.2 Callable declaration format

```ts
runtime.registerCallable({
  name: 'setVoxels',               // used in text syntax verbatim
  signature: '(x1, y1, z1, x2, y2, z2, type, color?) -> none',
  args: [ /* typed, with ranges/enums, e.g. type ∈ {DIRT, STONE, ...} */ ],
  fuelCost: 8,                     // accounting weight (see §6)
  doc: 'Fill an inclusive box with a voxel type.',
  category: 'world',               // for block palette grouping
});
```

Static validation must check arity and *value domains* where declared
(enums, ranges, non-null). This recreates — generically — the voxel-type
validation VoxSpell currently does server-side for generated JS.

### 4.3 Invocation

A single shape (fuel-bounded): **`run(program, inputs)`** — one execution to
completion or `out-of-fuel`. Long-running behaviors are the host's concern:
the host re-invokes `run` per world-clock tick, passing the updated `state`
back in; applying one program to many subjects is a host-side loop over its
own collection, exposed to the script as a normal list value (via `context`
or a callable). The runtime has no `self`, no subject mode, no special batch
path.

---

## 5. Language Shape (v1)

Detailed grammar is left to the implementation design doc, but the v1 feature
set is fixed:

### 5.1 Program structure

- A program is an ordered list of **statements**. No rules, no query heads,
  no `self` — iteration over subjects is an ordinary `for` loop over a list
  value supplied by the host (`context`) or returned by a callable.

### 5.2 Statements

- **Action / intent**: `call host-callable(args...)` — no sugared statement
  forms in v1.
- **Control**: `if / else if / else`, `for <x> of <list-expr>:` — the single
  loop form; ranges via the `range(start, end)` builtin (half-open, index
  available as the loop variable).
- **Assignment**: `let x = <expr>` (script-local, declared implicitly, typed
  by first assignment; host pre-declares a fixed `state` record for scripts
  that must persist data across invocations).
- **Early stop**: `stop` (exit the program) — no `goto`, no `break`-to-label.

### 5.3 Expressions

- Values: numbers (int/float distinction matches host types), booleans,
  strings (opaque: no ops beyond equality and passing to callables), enums
  (host-registered), lists, and objects (host-declared records with named
  fields — no classes, no components, no methods).
- Arithmetic `+ - * / %`, comparison `< <= == != >= >`, logic `and or not`,
  parentheses. Short-circuit semantics fixed and documented.
- A **small fixed library** of pure helpers (host cannot add expression
  operators; hosts add *callables* instead): `min max abs floor ceil round
  distance(a,b) random()` (seeded — see §6), `range(start, end)` (list of
  ints, half-open).
- Member access on objects via declared fields only; list access only via
  `for` iteration. No indexing operator in v1.

### 5.4 Explicitly absent (v1)

User functions, recursion, `while` (use `for` over `range`), dynamic typing
beyond declared unions, string ops, arrays-of-arrays, exceptions/try, imports,
reflection, null (use optional-typed host values with `exists` check).

---

## 6. Safety & Resource Limits

Enforced by the interpreter, deterministically, with **preemption** (not
watchdogs):

- **Fuel**: each executed node costs fuel; each callable call costs its
  declared `fuelCost`. Exhaustion → `out-of-fuel` result at the exact
  instruction boundary; host decides policy (discard intents, penalize, …).
  Fuel is an execution *result*, never a host-process concern.
- **Call depth**: hard cap (e.g. 8) — only relevant via callable composition.
- **Memory**: fixed bound on live values (state slots, loop iteration caps,
  max list sizes). No unbounded allocation exists in the grammar.
- **Result/intent volume**: `limits.maxResults`; excess is a validation-style
  error, not a crash.
- **Determinism**: `random()` is host-seeded per run (seed in, sequence
  reproducible). No wall-clock, no iteration-order dependence beyond
  host-specified ordering.

---

## 7. LLM Contract

The language project must ship, as a deliverable, an **LLM integration kit**:

- `GRAMMAR.md`: the ~100-line grammar + semantics description, written to be
  pasted into a system prompt.
- `EXAMPLES.md`: 3–4 canonical annotated programs per major use case
  (structure generation, entity behavior, …).
- `renderPromptRegistry(callables)`: function that renders a host's callable
  registry into prompt-ready text (signatures + one-line docs + value
  domains).
- **Validation feedback spec**: exact error JSON format so hosts can
  implement generate → parse → (on failure) feed errors back to the LLM →
  regenerate. Retry guidance: errors are line/col-localized and phrased for
  model consumption.
- Version pinning: generated text declares its language version implicitly by
  host prompt; the parser rejects newer/older AST versions explicitly.

Target: ≥99% of syntactically well-formed LLM outputs parse on first attempt
for in-domain prompts (measure on an eval set; ship the eval harness as a
deliverable).

---

## 8. Human / Block-UI Contract

- `block-spec`: formal mapping AST node ⇄ block (shape, sockets, fields).
- Constraints for 1:1: no layout-significant syntax, no operator precedence
  puzzles (keep precedence minimal and visualizable with nesting), every
  construct nestable in every syntactically valid position.
- Palette composition: host-visible categories from callable `category` +
  core control blocks.
- Round-trip guarantees: text ⇄ AST ⇄ blocks ⇄ AST ⇄ text must be stable
  (idempotent after first normalization). Property tests required.

---

## 9. Repository & Deliverables (for the implementing agent)

Agnostic package (not tied to VoxSpell):

```
spelllang/
├── SPELLLANG.md         # the spec — the contract (this document)
├── AGENTS.md            # agent-facing repo notes (commands, conventions)
├── README.md            # overview + test commands
├── DESIGN.md            # implementation design decisions
├── GRAMMAR.md           # LLM-facing grammar description
├── BLOCKS.md            # block-surface spec: AST node ⇄ block mapping
├── EXAMPLES.md
├── LICENSE              # MIT
├── src/
│   ├── ast.ts           # node types + static types + versioning
│   ├── parser.ts        # text -> AST, error JSON, multi-error recovery
│   ├── printer.ts       # AST -> canonical text (round-trip)
│   ├── validator.ts     # static checks incl. callable registry
│   ├── builtins.ts      # fixed builtin helper registry
│   ├── interpreter.ts   # fuel-bounded, deterministic exec
│   ├── host.ts          # runtime construction, callable registration
│   ├── prompt.ts        # renderPromptRegistry
│   └── blocks/          # block surface (`spelllang/blocks` subpath):
│       ├── mapping.ts   #   socket render rule, palette model, AST path edits
│       ├── editor.ts    #   <spelllang-editor> custom element (zero-dep)
│       ├── css.ts       #   shadow-root stylesheet (CSS-var themable)
│       └── index.ts     #   exports + guarded element registration
├── test/
│   ├── parser.test.ts
│   ├── validator.test.ts
│   ├── host.test.ts            # host API: embed flow, config validation
│   ├── interpreter.test.ts     # fuel, determinism, limits, state persistence
│   ├── roundtrip.property.test.ts  # fast-check print<->parse stability
│   ├── blocks.mapping.test.ts      # block-surface mapping unit tests
│   ├── blocks.editor.test.ts       # <spelllang-editor> DOM tests (happy-dom)
│   ├── blocks.roundtrip.property.test.ts  # socket-rule idempotence props
│   ├── conformance.test.ts         # spec conformance suite
│   └── llm-eval/             # LLM eval harness (§7 deliverable #4)
│       ├── harness.ts        # prompt assembly, retry loop, metrics, artifacts
│       ├── openrouter.ts     # minimal OpenRouter chat client (fetch, zero deps)
│       ├── tasks.ts          # task suite: voxel-world host, checkers, references
│       ├── harness.test.ts   # offline tests of the loop (stub client)
│       ├── eval.test.ts      # vitest entry (skips without OPENROUTER_API_KEY)
│       └── README.md
```

Deliverables / acceptance criteria:

1. ESM library, zero native deps, Node ≥20 + modern browsers.
2. Conformance suite green; 100% of invalid programs rejected with
   line/col-localized errors; 100% of fuel/limits tests deterministic.
3. Block-mapping spec + round-trip property tests green.
4. LLM eval harness with measurable parse-success baseline documented.
5. `langVersion` migration hooks (parser accepts older versions via
   declared transforms).

---

## 10. Open Questions (resolve during detailed design)

- Concrete syntax details: brace vs keyword delimiters, comment style,
  callable-call syntax vs statement sugar.
- Whether scripts declare `state` explicitly (`state anger = 0`) vs
  implicit persistence — leaning explicit: the state record's fixed shape
  must be statically known, and explicit declarations read clearly in the
  block UI.
- List length bounds: single global `maxListLength` vs per-type declared
  bounds — leaning a global cap for v1 simplicity.
- Error recovery: single-error vs multi-error parse reports (LLM retry prefers
  all-errors-at-once; decide by eval).

---

## 11. Relationship to VoxSpell (first host)

VoxSpell will consume the package as:

- **Structure generation**: replaces `new Function('api', code)` entirely —
  the LLM emits SpellLang text; the server parses/validates (callables:
  `setVoxel`, `setVoxels`) and returns block intents. The sandbox problem
  disappears.
- **Entity AI (future)**: tick scripts with host callables (`nearest`,
  `moveTowards`, …), state records per entity, fuel per tick — replacing the
  isolated-vm design discussed during planning, unless a trusted-JS tier is
  later added.
- **Spellbook**: stored scripts are versioned ASTs (JSON), safe to share
  between players and editable as blocks.
