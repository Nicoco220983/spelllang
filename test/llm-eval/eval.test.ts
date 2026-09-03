/**
 * LLM eval entry point (SPELLLANG.md §7, deliverable #4).
 *
 *   OPENROUTER_API_KEY=... OPENROUTER_MODEL=... pnpm eval
 *
 * The self-check suite (reference solutions) always runs and needs no key.
 * The live eval describe skips without credentials; each task is one test
 * that fails if the model cannot produce a parseable AND semantically
 * correct script within the retry budget. A summary with the spec's
 * first-attempt parse-success metric (target >= 99%) prints after the run;
 * per-task artifacts land in test/llm-eval/runs/<timestamp>__<model>/.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  buildSystemPrompt,
  executeRuns,
  failureDetails,
  printSummary,
  runTask,
  saveRunArtifacts,
  type TaskReport,
} from './harness.js';
import { OpenRouterClient } from './openrouter.js';
import { CALLABLES, CONTEXT_SHAPE, EXAMPLE, makeRuntime, STATE_SHAPE, TASKS } from './tasks.js';

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Self-check: the harness and task suite are sound, no API key needed.
// ---------------------------------------------------------------------------

describe('llm-eval: task suite self-check (no API key needed)', () => {
  for (const task of TASKS) {
    it(`${task.id}: reference solution parses, runs, and passes its checker`, () => {
      const rt = makeRuntime();
      const parsed = rt.parse(task.reference);
      expect(parsed.ok, JSON.stringify(parsed.errors, null, 2)).toBe(true);
      const outcomes = executeRuns(rt, parsed.program!, task);
      const verdict = task.check(outcomes);
      expect(verdict.pass, verdict.reason).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Live eval
// ---------------------------------------------------------------------------

const apiKey = process.env.OPENROUTER_API_KEY;
const model = process.env.OPENROUTER_MODEL;

describe.skipIf(!apiKey || !model)(`llm-eval: live eval (model: ${model ?? 'unset'})`, () => {
  // NB: describe.skipIf still evaluates this body at collection time — keep it
  // safe when OPENROUTER_API_KEY / OPENROUTER_MODEL are unset.
  const safeModel = model ?? 'unset';
  const filter = (process.env.EVAL_TASKS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const tasks = filter.length > 0 ? TASKS.filter((t) => filter.includes(t.id)) : TASKS;

  const client = new OpenRouterClient({
    apiKey: apiKey!,
    model: model!,
    baseUrl: process.env.OPENROUTER_BASE_URL,
    temperature: Number(process.env.EVAL_TEMPERATURE ?? 0),
  });
  const maxRetries = Number(process.env.EVAL_MAX_RETRIES ?? 2);
  const systemPrompt = buildSystemPrompt(
    { callables: CALLABLES, stateShape: STATE_SHAPE, contextShape: CONTEXT_SHAPE },
    EXAMPLE,
  );
  const runDir = join(
    HERE,
    'runs',
    `${new Date().toISOString().replace(/[:.]/g, '-')}__${safeModel.replace(/[^a-z0-9]+/gi, '_')}`,
  );
  const reports: TaskReport[] = [];

  if (tasks.length === 0) {
    it('no tasks selected (check EVAL_TASKS)', () => {
      expect.unreachable('EVAL_TASKS filter matched nothing');
    });
  }

  for (const task of tasks) {
    it(task.id, async () => {
      const report = await runTask({
        task,
        runtime: makeRuntime(),
        client,
        systemPrompt,
        maxRetries,
      });
      reports.push(report);
      saveRunArtifacts(runDir, task, report);
      expect(report.finalOk, `\n${failureDetails(report)}`).toBe(true);
    }, 300_000);
  }

  afterAll(() => {
    printSummary(reports, safeModel);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'summary.json'), JSON.stringify({ model, reports }, null, 2));
  });
});
