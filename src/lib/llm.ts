// Multi-provider LLM client: Groq (primary) -> OpenRouter -> YandexGPT (fallback chain).
// Каждый провайдер ограничен 30s, на 5xx/timeout/rate-limit идёт на следующего.

import { log } from './log';
import type { Env } from '../types';

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export type LlmProvider = 'groq' | 'openrouter' | 'yandex';

export interface LlmResult {
  content: string;
  input_tokens: number;
  output_tokens: number;
  latency_ms: number;
  provider: LlmProvider;
  model: string;
}

interface ProviderAttempt {
  provider: LlmProvider;
  call: () => Promise<LlmResult>;
}

const TIMEOUT_MS = 30_000;
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

class RetryableError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
  }
}

export async function callLLM(env: Env, messages: LlmMessage[]): Promise<LlmResult> {
  const attempts = buildChain(env, messages);
  if (attempts.length === 0) {
    throw new Error('llm: no providers configured');
  }
  const errors: string[] = [];
  for (const a of attempts) {
    try {
      const res = await a.call();
      log({
        event: 'llm_ok',
        provider: res.provider,
        model: res.model,
        latency_ms: res.latency_ms,
        in_tokens: res.input_tokens,
        out_tokens: res.output_tokens,
      });
      return res;
    } catch (e) {
      const msg = (e as Error).message;
      errors.push(`${a.provider}: ${msg}`);
      const retryable = e instanceof RetryableError || isAbort(e);
      log({
        event: 'llm_provider_failed',
        level: retryable ? 'warn' : 'error',
        provider: a.provider,
        error: msg,
        fallback: retryable,
      });
      if (!retryable) break;
    }
  }
  throw new Error(`llm: all providers failed (${errors.join(' | ')})`);
}

function buildChain(env: Env, messages: LlmMessage[]): ProviderAttempt[] {
  const list: ProviderAttempt[] = [];
  if (env.GROQ_API_KEY) {
    list.push({ provider: 'groq', call: () => callGroq(env, messages) });
  }
  if (env.OPENROUTER_API_KEY) {
    list.push({ provider: 'openrouter', call: () => callOpenRouter(env, messages) });
  }
  if (env.YANDEX_API_KEY && env.YANDEX_FOLDER_ID) {
    list.push({ provider: 'yandex', call: () => callYandex(env, messages) });
  }
  return list;
}

async function callGroq(env: Env, messages: LlmMessage[]): Promise<LlmResult> {
  const t0 = Date.now();
  const model = env.GROQ_MODEL || 'llama-3.3-70b-versatile';
  const res = await timedFetch(`${env.GROQ_API_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.GROQ_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model, messages, temperature: 0.4, max_tokens: 1500 }),
  });
  if (!res.ok) throw await toError('groq', res);
  const json = (await res.json()) as {
    choices: { message: { content: string } }[];
    usage: { prompt_tokens: number; completion_tokens: number };
  };
  return {
    content: json.choices[0]?.message?.content ?? '',
    input_tokens: json.usage.prompt_tokens,
    output_tokens: json.usage.completion_tokens,
    latency_ms: Date.now() - t0,
    provider: 'groq',
    model,
  };
}

async function callOpenRouter(env: Env, messages: LlmMessage[]): Promise<LlmResult> {
  const t0 = Date.now();
  const primary = env.OPENROUTER_MODEL || 'qwen/qwen3.6-plus';
  const fallback = env.OPENROUTER_MODEL_FALLBACK || 'qwen/qwen-2.5-72b-instruct';
  // OpenRouter сам пройдёт по `models` списку при недоступности primary
  const res = await timedFetch(`${env.OPENROUTER_API_BASE || 'https://openrouter.ai/api/v1'}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      'content-type': 'application/json',
      'HTTP-Referer': env.PUBLIC_BASE_URL,
      'X-Title': 'SINTEM',
    },
    body: JSON.stringify({
      model: primary,
      models: [primary, fallback],
      messages,
      temperature: 0.4,
      max_tokens: 1500,
    }),
  });
  if (!res.ok) throw await toError('openrouter', res);
  const json = (await res.json()) as {
    model?: string;
    choices: { message: { content: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  return {
    content: json.choices[0]?.message?.content ?? '',
    input_tokens: json.usage?.prompt_tokens ?? 0,
    output_tokens: json.usage?.completion_tokens ?? 0,
    latency_ms: Date.now() - t0,
    provider: 'openrouter',
    model: json.model ?? primary,
  };
}

async function callYandex(env: Env, messages: LlmMessage[]): Promise<LlmResult> {
  const t0 = Date.now();
  const model = env.YANDEX_MODEL || 'yandexgpt/latest';
  const modelUri = `gpt://${env.YANDEX_FOLDER_ID}/${model}`;
  const res = await timedFetch(
    env.YANDEX_API_BASE || 'https://llm.api.cloud.yandex.net/foundationModels/v1/completion',
    {
      method: 'POST',
      headers: {
        authorization: `Api-Key ${env.YANDEX_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        modelUri,
        completionOptions: { stream: false, temperature: 0.4, maxTokens: '1500' },
        messages: messages.map((m) => ({ role: m.role, text: m.content })),
      }),
    },
  );
  if (!res.ok) throw await toError('yandex', res);
  const json = (await res.json()) as {
    result: {
      alternatives: { message: { role: string; text: string } }[];
      usage: { inputTextTokens: string; completionTokens: string };
    };
  };
  return {
    content: json.result.alternatives[0]?.message.text ?? '',
    input_tokens: parseInt(json.result.usage.inputTextTokens, 10) || 0,
    output_tokens: parseInt(json.result.usage.completionTokens, 10) || 0,
    latency_ms: Date.now() - t0,
    provider: 'yandex',
    model,
  };
}

async function timedFetch(url: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function toError(provider: LlmProvider, res: Response): Promise<Error> {
  const body = await res.text().catch(() => '');
  const snippet = body.slice(0, 200);
  if (RETRYABLE_STATUS.has(res.status)) {
    return new RetryableError(`${provider} ${res.status}: ${snippet}`, res.status);
  }
  return new Error(`${provider} ${res.status}: ${snippet}`);
}

function isAbort(e: unknown): boolean {
  return e instanceof Error && (e.name === 'AbortError' || /aborted|timeout/i.test(e.message));
}

/** Cost estimate in cents-of-cent (USD * 10000) by provider+model for atomic SQL storage. */
export function llmCostUsdE4(provider: LlmProvider, model: string, input_tokens: number, output_tokens: number): number {
  // Pricing snapshot 2026-05; update when providers move prices.
  const rates: Record<string, { in: number; out: number }> = {
    'groq:llama-3.3-70b-versatile': { in: 0.59, out: 0.79 },
    'groq:qwen-2.5-72b': { in: 0.59, out: 0.79 },
    'openrouter:qwen/qwen3.6-plus': { in: 0.9, out: 1.8 },
    'openrouter:qwen/qwen-2.5-72b-instruct': { in: 0.8, out: 1.2 },
    'yandex:yandexgpt/latest': { in: 0.4, out: 1.2 },
  };
  const r = rates[`${provider}:${model}`] ?? rates[`${provider}:${model.split('/').pop() ?? model}`];
  if (!r) return 0;
  const usd = (input_tokens * r.in + output_tokens * r.out) / 1_000_000;
  return Math.round(usd * 10_000);
}
