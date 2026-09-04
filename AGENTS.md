# AGENTS.md

Agent-facing notes for this repo. The contract is `SPELLLANG.md`; design
decisions (and why) live in `DESIGN.md` — read both before non-trivial
changes. Human-facing overview and commands: `README.md`.

## Commands

- `pnpm install` — dependencies (packageManager: pnpm 10)
- `pnpm test` — full vitest suite; fast-check property tests run random
  seeds, so failures there can be intermittent (re-run to confirm)
- `pnpm eval` — LLM eval harness only; skips without
  `OPENROUTER_API_KEY` + `OPENROUTER_MODEL`
- `pnpm test -t <name>` / `pnpm eval -t <task-id>` — run a single test
- `pnpm typecheck` — `tsc --noEmit` over `src/`
- `npx tsc -p tsconfig.test.json` — strict typecheck of `src/` +
  `test/llm-eval/` (the two older test files are not yet strict-clean;
  that is known and pre-existing)
- `pnpm build` — ESM output + declarations in `dist/`

## Conventions

- ESM only (`"type": "module"`), TypeScript, Node >= 20, **zero runtime
  deps** — use global `fetch`; do not add dependencies without asking.
- Every AST node carries `loc: {line, col}`; the AST is plain JSON and is
  the stable contract (text and block UI are replaceable serializations).
- `src/` layout: `ast`, `parser` (registry-free), `printer` (canonical
  text), `validator` (reclassifies identifiers, collects all errors),
  `builtins` (fixed helper registry), `interpreter` (fuel-bounded,
  deterministic, deep-copies at the host API edge), `host` (`SpellLang`
  class + fail-fast `SpellLangConfig` validation), `prompt`
  (`renderPromptRegistry`).
- Language changes must keep `GRAMMAR.md`, `EXAMPLES.md`, and the
  conformance suite in sync; keep `SPELLLANG.md` §9's repo tree accurate.
- Style: single quotes, 2-space indent, semicolons; tests use vitest.
- Run the full suite before declaring anything done: `pnpm test` must be
  green (`pnpm typecheck` too if `src/` changed).
