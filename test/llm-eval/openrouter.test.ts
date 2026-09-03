/**
 * Offline tests for OpenRouterClient (no network): fetch is stubbed to play
 * provider responses — success, transient empties/429s (retried), and hard
 * 4xx (fail fast with the body).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenRouterClient } from './openrouter.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function okBody(content: string) {
  return {
    choices: [{ message: { content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 3, completion_tokens: 4 },
  };
}

const MSG = [{ role: 'user' as const, content: 'hi' }];

describe('OpenRouterClient', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns content, tokens, and latency on success', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, okBody('call setVoxel(0, 0, 0, STONE)'))));
    const reply = await new OpenRouterClient({ apiKey: 'k', model: 'm' }).chat(MSG);
    expect(reply.content).toBe('call setVoxel(0, 0, 0, STONE)');
    expect(reply.promptTokens).toBe(3);
    expect(reply.completionTokens).toBe(4);
    expect(reply.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('retries transient empty content and succeeds when content comes back', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, { choices: [{ message: { content: null }, finish_reason: 'stop' }] }),
      )
      .mockResolvedValueOnce(jsonResponse(200, okBody('stop')));
    vi.stubGlobal('fetch', fetchMock);
    const reply = await new OpenRouterClient({ apiKey: 'k', model: 'm' }).chat(MSG);
    expect(reply.content).toBe('stop');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws with diagnostics after repeated empty content', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(200, { choices: [], error: { message: 'content filter' } })),
    );
    const client = new OpenRouterClient({ apiKey: 'k', model: 'm' });
    await expect(client.chat(MSG)).rejects.toThrow(/empty content.*content filter/s);
  }, 15_000);

  it('retries 429 with backoff', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, { error: { message: 'rate limited' } }))
      .mockResolvedValueOnce(jsonResponse(200, okBody('ok')));
    vi.stubGlobal('fetch', fetchMock);
    const reply = await new OpenRouterClient({ apiKey: 'k', model: 'm' }).chat(MSG);
    expect(reply.content).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  }, 15_000);

  it('fails fast on 4xx with the response body', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(401, { error: { message: 'invalid key' } }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new OpenRouterClient({ apiKey: 'k', model: 'm' });
    await expect(client.chat(MSG)).rejects.toThrow(/OpenRouter 401.*invalid key/s);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
