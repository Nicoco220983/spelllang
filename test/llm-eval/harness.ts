/**
 * LLM eval harness (SPELLLANG.md §7, deliverable #4): measures a model's
 * capacity to generate SpellLang scripts — first-attempt parse success
 * (target >= 99%), semantic correctness against a reference host, and
 * retry behavior under the machine-readable error feedback contract
 * (GRAMMAR.md "ON ERRORS"). Zero runtime deps: node:fs + global fetch.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  CallableDecl,
  ContextShape,
  ExecResult,
  Intent,
  Program,
  SpellError,
  StateShape,
  Type,
  Value,
} from '../../src/ast.js';
import type { SpellLang } from '../../src/host.js';
import type { RunInputs } from '../../src/interpreter.js';
import { renderPromptRegistry } from '../../src/prompt.js';
import type { ChatMessage, ChatReply, OpenRouterClient } from './openrouter.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');

// ---------------------------------------------------------------------------
// System prompt assembly (GRAMMAR.md template + host registry substitution)
// ---------------------------------------------------------------------------

/** Extract the fenced prompt template from GRAMMAR.md. */
export function loadGrammarTemplate(): string {
  const md = readFileSync(join(REPO_ROOT, 'GRAMMAR.md'), 'utf8');
  const m = md.match(/```\n([\s\S]*?)\n```/);
  if (!m || !m[1]) throw new Error('GRAMMAR.md: no fenced template found');
  return m[1];
}

function typeText(t: Type): string {
  switch (t.kind) {
    case 'int':
      return 'int';
    case 'float':
      return 'float';
    case 'bool':
      return 'bool';
    case 'string':
      return 'string';
    case 'none':
      return 'none';
    case 'vec':
      return 'vec(x,y,z)';
    case 'enum':
      return t.name;
    case 'list':
      return `list<${typeText(t.elem)}>`;
    case 'record':
      return t.name;
    case 'optional':
      return `${typeText(t.inner)}?`;
  }
}

/** Render a fixed record shape for the prompt, e.g. "state.count  int". */
export function renderShape(shape: Record<string, Type>, prefix = ''): string {
  return Object.entries(shape)
    .map(([name, t]) => `${prefix}${name}  ${typeText(t)}`)
    .join('   ');
}

export interface PromptRegistry {
  callables: CallableDecl[];
  stateShape: StateShape;
  contextShape: ContextShape;
}

/**
 * Build the full system prompt: static grammar + host-generated
 * AVAILABLE FUNCTIONS / STATE / CONTEXT sections + examples.
 */
export function buildSystemPrompt(reg: PromptRegistry, examples: string): string {
  return loadGrammarTemplate()
    .replace('{{renderPromptRegistry(callables)}}', renderPromptRegistry(reg.callables))
    .replace('{{stateShape}}', renderShape(reg.stateShape, 'state.'))
    .replace('{{contextShape}}', renderShape(reg.contextShape))
    .replace('{{examples}}', examples);
}

// ---------------------------------------------------------------------------
// Task shapes
// ---------------------------------------------------------------------------

export interface Verdict {
  pass: boolean;
  reason: string;
}

export interface RunSpec {
  context: Record<string, Value>;
  seed?: number;
}

/** The parts of a task the executor needs (kept minimal, no LLM bits). */
export interface ExecutableTask {
  initialState: Record<string, Value>;
  runs: RunSpec[];
}

export interface EvalTask extends ExecutableTask {
  id: string;
  /** natural-language ask, sent as the user message */
  prompt: string;
  /** known-good solution; used to self-check the harness without an API key */
  reference: string;
  /** semantic judgment on the executed runs */
  check: (outcomes: RunOutcome[]) => Verdict;
}

// ---------------------------------------------------------------------------
// Reference voxel-world host: callables record intents, world = voxel set
// ---------------------------------------------------------------------------

export interface RunOutcome {
  exec: ExecResult;
  intents: Intent[];
  /** resulting world: "x,y,z" -> voxel type. How it was built does not matter
   *  (a setVoxels box and an equivalent per-voxel loop are both correct). */
  voxels: Map<string, string>;
  /** state after this run (threaded into the next run) */
  state: Record<string, Value>;
}

export function voxelKey(x: number, y: number, z: number): string {
  return `${x},${y},${z}`;
}

export class VoxelWorld {
  readonly intents: Intent[] = [];
  readonly voxels = new Map<string, string>();

  private record(x: number, y: number, z: number, type: string): void {
    this.voxels.set(voxelKey(x, y, z), type);
    this.intents.push(['voxel', x, y, z, type]);
  }

  readonly impl: RunInputs['callablesImpl'] = {
    setVoxel: (args) => {
      const [x, y, z, type] = args as [number, number, number, string];
      this.record(x, y, z, type);
    },
    setVoxels: (args) => {
      const [x1, y1, z1, x2, y2, z2, type] = args as [number, number, number, number, number, number, string];
      for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) {
        for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y++) {
          for (let z = Math.min(z1, z2); z <= Math.max(z1, z2); z++) {
            this.record(x, y, z, type);
          }
        }
      }
    },
    say: (args) => {
      this.intents.push(['say', args[0] ?? '']);
    },
  };
}

/** Run a program through every RunSpec, threading state across runs. */
export function executeRuns(rt: SpellLang, program: Program, task: ExecutableTask): RunOutcome[] {
  const outcomes: RunOutcome[] = [];
  let state = JSON.parse(JSON.stringify(task.initialState)) as Record<string, Value>;
  for (const run of task.runs) {
    const world = new VoxelWorld();
    const exec = rt.run(program, {
      state,
      context: run.context,
      seed: run.seed ?? 42,
      callablesImpl: world.impl,
    });
    outcomes.push({ exec, intents: world.intents, voxels: world.voxels, state: exec.state });
    state = exec.state;
  }
  return outcomes;
}

// ---------------------------------------------------------------------------
// Script extraction + the generate -> validate -> feedback loop
// ---------------------------------------------------------------------------

/** Models are told to output raw script text; tolerate markdown fences anyway. */
export function extractScript(text: string): string {
  const fence = text.match(/```(?:spelllang)?\s*\n([\s\S]*?)```/);
  if (fence && fence[1]) return fence[1].trim();
  return text.trim();
}

export interface AttemptRecord {
  attempt: number;
  code: string;
  parseOk: boolean;
  errors: SpellError[];
  semantic?: Verdict;
  usage: { prompt: number; completion: number };
  latencyMs: number;
}

export interface TaskReport {
  taskId: string;
  attempts: AttemptRecord[];
  firstAttemptParseOk: boolean;
  firstAttemptFullyOk: boolean;
  finalParseOk: boolean;
  finalOk: boolean;
  errorCodesSeen: string[];
  retriesUsed: number;
  totalTokens: number;
}

export async function runTask(opts: {
  task: EvalTask;
  runtime: SpellLang;
  /** anything chat-shaped (OpenRouterClient, or a scripted stub in tests) */
  client: Pick<OpenRouterClient, 'chat'>;
  systemPrompt: string;
  /** error-feedback rounds after the first attempt (total attempts = 1 + maxRetries) */
  maxRetries: number;
}): Promise<TaskReport> {
  const { task, runtime: rt, client, systemPrompt, maxRetries } = opts;
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `${task.prompt}\n\nOutput only the SpellLang script.` },
  ];

  const attempts: AttemptRecord[] = [];
  const errorCodesSeen = new Set<string>();

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    let reply: ChatReply;
    try {
      reply = await client.chat(messages);
    } catch (err) {
      // API-level failure (auth, rate limits, persistent empty content).
      // The client already retried transients — record it and stop instead
      // of burning the error-feedback budget or losing the artifacts.
      const message = err instanceof Error ? err.message : String(err);
      errorCodesSeen.add('api-error');
      attempts.push({
        attempt,
        code: '(no response)',
        parseOk: false,
        errors: [{ line: 1, col: 1, code: 'api-error', message }],
        usage: { prompt: 0, completion: 0 },
        latencyMs: 0,
      });
      break;
    }
    const code = extractScript(reply.content);
    const parsed = rt.parse(code);

    let semantic: Verdict | undefined;
    if (parsed.ok && parsed.program) {
      const outcomes = executeRuns(rt, parsed.program, task);
      const failed = outcomes.find((o) => o.exec.result !== 'ok');
      semantic = failed
        ? {
            pass: false,
            reason: `run #${outcomes.indexOf(failed) + 1} failed with result '${failed.exec.result}': ${failed.exec.error?.message ?? 'no detail'}`,
          }
        : task.check(outcomes);
    }
    for (const e of parsed.errors) errorCodesSeen.add(e.code);
    attempts.push({
      attempt,
      code,
      parseOk: parsed.ok,
      errors: parsed.errors,
      semantic,
      usage: { prompt: reply.promptTokens, completion: reply.completionTokens },
      latencyMs: reply.latencyMs,
    });

    if (parsed.ok && semantic?.pass) break;

    // Error feedback contract (GRAMMAR.md "ON ERRORS").
    messages.push({ role: 'assistant', content: reply.content });
    if (!parsed.ok) {
      messages.push({
        role: 'user',
        content:
          'Your script was rejected. Here are the machine-readable errors. ' +
          'Fix ALL of them and output the corrected script only.\n' +
          JSON.stringify({ ok: false, errors: parsed.errors }),
      });
    } else {
      messages.push({
        role: 'user',
        content: `Your script parsed and ran, but the result is wrong: ${semantic?.reason}. Output the corrected script only.`,
      });
    }
  }

  const first = attempts[0]!;
  const last = attempts[attempts.length - 1]!;
  return {
    taskId: task.id,
    attempts,
    firstAttemptParseOk: first.parseOk,
    firstAttemptFullyOk: first.parseOk && first.semantic?.pass === true,
    finalParseOk: last.parseOk,
    finalOk: last.parseOk && last.semantic?.pass === true,
    errorCodesSeen: [...errorCodesSeen],
    retriesUsed: attempts.length - 1,
    totalTokens: attempts.reduce((s, a) => s + a.usage.prompt + a.usage.completion, 0),
  };
}

// ---------------------------------------------------------------------------
// Artifacts + summary
// ---------------------------------------------------------------------------

/** Persist prompts, attempts, errors, and final scripts for offline review. */
export function saveRunArtifacts(dir: string, task: EvalTask, report: TaskReport): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${report.taskId}.json`),
    JSON.stringify({ prompt: task.prompt, report }, null, 2),
  );
  const last = report.attempts[report.attempts.length - 1]!;
  writeFileSync(join(dir, `${report.taskId}.spelllang`), `${last.code}\n`);
}

/** Human-readable failure details for test assertions. */
export function failureDetails(report: TaskReport): string {
  return report.attempts
    .map((a) => {
      let line = `attempt ${a.attempt}: parseOk=${a.parseOk}`;
      if (a.errors.length > 0) line += ` errors=${JSON.stringify(a.errors)}`;
      if (a.semantic) line += a.semantic.pass ? ' semantic=pass' : ` semantic=FAIL (${a.semantic.reason})`;
      if (!a.parseOk || (a.semantic && !a.semantic.pass)) {
        line += `\ncode:\n${a.code}`;
      }
      return line;
    })
    .join('\n');
}

export function printSummary(reports: TaskReport[], model: string): void {
  if (reports.length === 0) return;
  const pct = (n: number) => `${((100 * n) / reports.length).toFixed(1)}%`;
  const count = (f: (r: TaskReport) => boolean) => reports.filter(f).length;
  const lines: string[] = [
    '',
    '=== LLM eval summary ===',
    `model: ${model}`,
    '',
    'task'.padEnd(20) + 'first-parse'.padEnd(13) + 'first-full'.padEnd(12) + 'final'.padEnd(8) + 'retries',
    ...reports.map(
      (r) =>
        r.taskId.padEnd(20) +
        String(r.firstAttemptParseOk).padEnd(13) +
        String(r.firstAttemptFullyOk).padEnd(12) +
        String(r.finalOk).padEnd(8) +
        String(r.retriesUsed),
    ),
    '',
    `first-attempt parse success:  ${count((r) => r.firstAttemptParseOk)}/${reports.length} (${pct(count((r) => r.firstAttemptParseOk))}) — target >= 99%`,
    `first-attempt full success:   ${count((r) => r.firstAttemptFullyOk)}/${reports.length} (${pct(count((r) => r.firstAttemptFullyOk))})`,
    `final success (with retries): ${count((r) => r.finalOk)}/${reports.length} (${pct(count((r) => r.finalOk))})`,
    `total tokens: ${reports.reduce((s, r) => s + r.totalTokens, 0)}`,
    `error codes seen: ${[...new Set(reports.flatMap((r) => r.errorCodesSeen))].join(', ') || '(none)'}`,
  ];
  console.log(lines.join('\n'));
}
