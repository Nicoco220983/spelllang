/**
 * Offline tests for the harness itself (no API key, no network): a stub
 * client plays scripted model replies so the generate -> validate ->
 * feedback loop, metrics, and prompt assembly are all covered. The live
 * model capacity measurement lives in eval.test.ts.
 */

import { describe, expect, it } from 'vitest';
import {
  buildSystemPrompt,
  extractScript,
  loadGrammarTemplate,
  runTask,
  type TaskReport,
} from './harness.js';
import type { ChatMessage, ChatReply } from './openrouter.js';
import { CALLABLES, CONTEXT_SHAPE, EXAMPLE, makeRuntime, STATE_SHAPE, TASKS } from './tasks.js';

/** Chat-shaped stub: replies with scripted content in FIFO order. */
class StubClient {
  readonly requests: ChatMessage[][] = [];
  constructor(private readonly replies: string[]) {}

  async chat(messages: ChatMessage[]): Promise<ChatReply> {
    this.requests.push(messages.map((m) => ({ ...m })));
    const content = this.replies.shift() ?? 'stop';
    return { content, promptTokens: 10, completionTokens: 5, latencyMs: 1 };
  }
}

const task = (id: string) => {
  const t = TASKS.find((x) => x.id === id);
  if (!t) throw new Error(`unknown task ${id}`);
  return t;
};

const systemPrompt = buildSystemPrompt(
  { callables: CALLABLES, stateShape: STATE_SHAPE, contextShape: CONTEXT_SHAPE },
  EXAMPLE,
);

async function runWithReplies(id: string, replies: string[], maxRetries = 2): Promise<TaskReport> {
  return runTask({
    task: task(id),
    runtime: makeRuntime(),
    client: new StubClient(replies),
    systemPrompt,
    maxRetries,
  });
}

describe('harness: generate -> validate -> feedback loop', () => {
  it('succeeds on the first attempt when the model is right', async () => {
    const report = await runWithReplies('single-voxel', [task('single-voxel').reference]);
    expect(report.firstAttemptParseOk).toBe(true);
    expect(report.firstAttemptFullyOk).toBe(true);
    expect(report.finalOk).toBe(true);
    expect(report.retriesUsed).toBe(0);
    expect(report.errorCodesSeen).toEqual([]);
  });

  it('recovers via the machine-readable error feedback contract', async () => {
    const report = await runWithReplies('single-voxel', [
      'call setVoxel(0, 0, 0, LAVA)', // invalid enum value
      task('single-voxel').reference,
    ]);
    expect(report.firstAttemptParseOk).toBe(false);
    // an undeclared enum literal classifies as an unknown identifier
    expect(report.errorCodesSeen).toContain('unknown-identifier');
    expect(report.finalOk).toBe(true);
    expect(report.retriesUsed).toBe(1);
  });

  it('feeds semantic failures back too (parses but wrong world)', async () => {
    const report = await runWithReplies('single-voxel', [
      'call setVoxel(0, 0, 0, STONE)', // parses, but not (2,0,3)
      task('single-voxel').reference,
    ]);
    expect(report.firstAttemptParseOk).toBe(true);
    expect(report.firstAttemptFullyOk).toBe(false);
    expect(report.finalOk).toBe(true);
    expect(report.retriesUsed).toBe(1);
    expect(report.attempts[0]!.semantic?.pass).toBe(false);
  });

  it('gives up after maxRetries and reports the failure', async () => {
    const report = await runWithReplies('single-voxel', ['call nope()', 'call nope()'], 1);
    expect(report.finalOk).toBe(false);
    expect(report.finalParseOk).toBe(false);
    expect(report.retriesUsed).toBe(1);
    expect(report.errorCodesSeen).toContain('unknown-callable');
  });

  it('records API errors as an api-error attempt instead of throwing', async () => {
    const client = {
      async chat(): Promise<never> {
        throw new Error('OpenRouter: empty content (finish_reason="stop", body={})');
      },
    };
    const report = await runTask({
      task: task('single-voxel'),
      runtime: makeRuntime(),
      client,
      systemPrompt,
      maxRetries: 2,
    });
    expect(report.finalOk).toBe(false);
    expect(report.attempts).toHaveLength(1); // no retry-budget burn on API errors
    expect(report.attempts[0]!.errors[0]!.code).toBe('api-error');
    expect(report.attempts[0]!.errors[0]!.message).toContain('empty content');
    expect(report.errorCodesSeen).toContain('api-error');
  });

  it('feedback messages follow the GRAMMAR.md contract', async () => {
    const stub = new StubClient(['call nope()', task('single-voxel').reference]);
    await runTask({
      task: task('single-voxel'),
      runtime: makeRuntime(),
      client: stub,
      systemPrompt,
      maxRetries: 1,
    });
    const secondRequest = stub.requests[1]!;
    expect(secondRequest).toHaveLength(4);
    const feedback = secondRequest[3]!;
    expect(feedback.role).toBe('user');
    expect(feedback.content).toContain('"ok":false');
    expect(feedback.content).toContain('unknown-callable');
  });
});

describe('harness: prompt assembly + extraction', () => {
  it('buildSystemPrompt substitutes all host sections', () => {
    expect(systemPrompt).toContain('setVoxel(x: int, y: int, z: int, type: VoxelType) -> none');
    expect(systemPrompt).toContain('state.count  int');
    expect(systemPrompt).toContain('tick  int');
    expect(systemPrompt).toContain('material  VoxelType');
    expect(systemPrompt).toContain('weather  string');
    expect(systemPrompt).toContain('for floor of range(0, 4)');
    expect(systemPrompt).not.toContain('{{');
  });

  it('loadGrammarTemplate extracts the fenced block', () => {
    const template = loadGrammarTemplate();
    expect(template).toContain('== STATEMENTS');
    expect(template).not.toContain('```');
  });

  it('extractScript strips markdown fences and trims prose-free text', () => {
    expect(extractScript('Here you go:\n```spelllang\ncall setVoxel(0, 0, 0, STONE)\n```\nDone.')).toBe(
      'call setVoxel(0, 0, 0, STONE)',
    );
    expect(extractScript('  call setVoxel(0, 0, 0, STONE)\n')).toBe('call setVoxel(0, 0, 0, STONE)');
  });
});
