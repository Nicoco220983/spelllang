/**
 * Minimal OpenRouter chat client (https://openrouter.ai/docs/api).
 * Zero deps: global fetch. Retries 429/5xx/network errors with backoff;
 * fails loudly on 4xx (auth, model name, quota) so eval runs don't limp.
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatReply {
  content: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
}

export interface OpenRouterConfig {
  apiKey: string;
  model: string;
  baseUrl?: string;
  /** eval default is 0: measurability beats sample diversity */
  temperature?: number;
}

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
const MAX_TRIES = 4;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class OpenRouterClient {
  constructor(private readonly config: OpenRouterConfig) {}

  get model(): string {
    return this.config.model;
  }

  async chat(messages: ChatMessage[]): Promise<ChatReply> {
    const url = `${this.config.baseUrl ?? DEFAULT_BASE_URL}/chat/completions`;
    const body = {
      model: this.config.model,
      messages,
      temperature: this.config.temperature ?? 0,
    };

    let lastErr: unknown = new Error('unreachable');
    for (let i = 0; i < MAX_TRIES; i++) {
      const start = Date.now();
      let res: Response;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.config.apiKey}`,
          },
          body: JSON.stringify(body),
        });
      } catch (err) {
        lastErr = err;
        await sleep(500 * 2 ** i);
        continue;
      }

      if (res.ok) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const data = (await res.json()) as any;
        const content: unknown = data.choices?.[0]?.message?.content;
        if (typeof content === 'string' && content.length > 0) {
          return {
            content,
            promptTokens: data.usage?.prompt_tokens ?? 0,
            completionTokens: data.usage?.completion_tokens ?? 0,
            latencyMs: Date.now() - start,
          };
        }
        // Empty content happens transiently (provider quirks, content
        // filters, reasoning-only turns) — retry like a 5xx, with
        // diagnostics so a persistent failure is diagnosable.
        lastErr = new Error(
          `OpenRouter: empty content (finish_reason=${JSON.stringify(
            data.choices?.[0]?.finish_reason ?? null,
          )}, body=${JSON.stringify(data).slice(0, 400)})`,
        );
        await sleep(500 * 2 ** i);
        continue;
      }

      const text = (await res.text()).slice(0, 500);
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`OpenRouter ${res.status}: ${text}`);
        await sleep(500 * 2 ** i);
        continue;
      }
      throw new Error(`OpenRouter ${res.status}: ${text}`);
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
}
