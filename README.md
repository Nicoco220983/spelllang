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
