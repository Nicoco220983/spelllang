# LLM Eval Harness

Measures a model's capacity to generate SpellLang scripts (SPELLLANG.md §7,
deliverable #4). Drives the exact production path an LLM integration would
use: `GRAMMAR.md` system prompt + `renderPromptRegistry` output → generate →
`SpellLang.parse` → on failure, feed machine-readable errors back
(GRAMMAR.md "ON ERRORS" contract) → regenerate.

## Run

```bash
export OPENROUTER_API_KEY=sk-or-...
export OPENROUTER_MODEL=anthropic/claude-sonnet-4        # any OpenRouter model id
pnpm eval                                                # = vitest run test/llm-eval/eval.test.ts
```

Optional env vars:

| var                 | default                        | effect                                    |
| ------------------- | ------------------------------ | ----------------------------------------- |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | compatible API endpoint                    |
| `EVAL_TEMPERATURE`  | `0`                            | 0 = measurable; raise for diversity runs  |
| `EVAL_MAX_RETRIES`  | `2`                            | error-feedback rounds per task            |
| `EVAL_TASKS`        | all                            | comma-separated task ids to run           |

Without `OPENROUTER_API_KEY` / `OPENROUTER_MODEL` the live suite skips; the
self-check suite (every task's reference solution parses, runs, and passes
its own checker) always runs and needs no key or network.

## Metrics

Per task, one vitest test that **fails** if the model cannot produce a
parseable *and* semantically correct script within the retry budget:

- **first-attempt parse success** — `% of tasks whose first output parses +
  validates clean`. The spec target is **≥ 99%** for in-domain prompts.
- **first-attempt full success** — first output also passes the semantic
  checker (right world state, not just well-formed).
- **final success (with retries)** — after up to `EVAL_MAX_RETRIES`
  error-feedback rounds.
- **error codes seen** — which validator/parse errors the model triggered.

Transient API flakiness (empty responses, 429s) is retried inside the
client with backoff; a task whose API ultimately fails is recorded with
error code `api-error` in its artifacts instead of crashing the run.

Artifacts per run land in `runs/<timestamp>__<model>/` (gitignored): task
prompt, every attempt (code + errors + token usage + latency), the final
script, and a `summary.json`.

## The task suite (`tasks.ts`)

A reference voxel-world host (`setVoxel`, `setVoxels`, `say`; enum
`VoxelType`; state `state.count`; context `tick`, `material`, `weather`)
and 10 tasks ordered by difficulty: literal placement → arithmetic → loops →
box fill → nested loops → per-tick conditionals (string + modulo) → enum
from context → `stop` → persistent state across re-invocations.

Checkers compare the **resulting voxel set**, never intent shapes — a
`setVoxels` box and an equivalent per-voxel loop are both correct.

## Adding a task

Append an `EvalTask` to `TASKS`: `id`, natural-language `prompt`,
`initialState`, one `runs` entry per invocation (state threads across them),
a `reference` solution (the self-check will verify it), and a `check` over
`RunOutcome[]` (see `compareVoxels`). Use only callables/enums/context
fields declared in this file's registry.
