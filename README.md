# SpellLang

Small, safe, embeddable scripting language for LLM-generated and block-edited
scripts, executed inside host applications (games, tools, agents). Scripts are
data (ASTs) interpreted by the host — no I/O, no escape surface, nothing to
sandbox.

- `SPELLLANG.md` — the spec (the contract between the language and its hosts)
- `DESIGN.md` — implementation design decisions
- `GRAMMAR.md` — LLM-facing grammar description (system-prompt ready)
- `EXAMPLES.md` — canonical example scripts
- `test/llm-eval/` — LLM eval harness (measures model generation capacity)

## Setup

```bash
pnpm install
```

## Embedding in a host application

Zero runtime dependencies, ESM, Node ≥ 20 (and modern browsers). The host
declares its surface (callables, types, state/context shapes); scripts are
parsed and validated up front, then executed against injected implementations.
Malformed host config throws immediately at construction.

```ts
import { SpellLang, tEnum, tInt, tNone } from 'spelllang';

const lang = new SpellLang({
  // named enum used by callable arguments
  types: { VoxelType: { kind: 'enum', values: ['STONE', 'DIRT', 'PLANKS'] } },
  // persistent per-script state (deep-copied in and out of each run)
  stateShape: { count: tInt },
  // read-only per-invocation data
  contextShape: { tick: tInt },
  callables: [
    {
      name: 'setVoxel',
      args: [
        { name: 'x', type: tInt, domain: { min: -64, max: 64 } },
        { name: 'type', type: tEnum('VoxelType') },
      ],
      returnType: tNone,
      fuelCost: 1,
      doc: 'Place one voxel.',
    },
  ],
});

// Text → parse → validate. Errors are machine-readable (line/col, code,
// expected/found) — feed them back to the generating LLM to fix the script.
const parsed = lang.parse('call setVoxel(1 + 1, STONE)');
if (!parsed.ok) {
  console.error(parsed.errors);
} else {
  // Execution is fuel-bounded and side-effect-free except through callables.
  const result = lang.run(parsed.program, {
    state: { count: 0 },
    context: { tick: 42 },
    callablesImpl: {
      setVoxel: (args, { emit }) => emit({ op: 'setVoxel', x: args[0], type: args[1] }),
    },
  });
  // result: { result, intents, state, fuelUsed, error? }
}
```

See `SPELLLANG.md` for the full contract, `GRAMMAR.md` for the LLM-facing
script grammar, and `test/llm-eval/tasks.ts` for a complete host example.

## Test commands

```bash
pnpm test          # full vitest suite: parser, validator, interpreter,
                   # conformance, round-trip property tests, eval self-checks
                   # (live LLM eval tests skip without OPENROUTER_API_KEY)

pnpm eval          # LLM eval harness only; requires:
                   #   OPENROUTER_API_KEY=... OPENROUTER_MODEL=...
                   # see test/llm-eval/README.md for options (EVAL_TASKS,
                   # EVAL_MAX_RETRIES, EVAL_TEMPERATURE, ...)

pnpm typecheck     # typecheck src/ (tsc --noEmit)
npx tsc -p tsconfig.test.json   # strict typecheck of src/ + test/llm-eval/
```

Run a single test with vitest's name filter:

```bash
pnpm test -t 'rejects: unknown callable'
pnpm eval -t single-voxel        # one eval task (one LLM call with EVAL_MAX_RETRIES=0)
```

## Build

```bash
pnpm build         # ESM output + declarations in dist/
```
