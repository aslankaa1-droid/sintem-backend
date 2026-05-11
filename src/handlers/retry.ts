// RETRY_QUEUE: failed Groq calls are enqueued in KV, drained by cron every 5 min.

import { log } from '../lib/log';
import { callLLM, llmCostUsdE4, type LlmMessage } from '../lib/llm';
import { sendMessage } from '../lib/tg';
import type { Env, RetryQueueItem } from '../types';

const MAX_ATTEMPTS = 3;

export async function enqueueRetry(env: Env, item: RetryQueueItem): Promise<void> {
  const id = `retry:${item.user_id}:${Date.now()}`;
  await env.RETRY_QUEUE.put(id, JSON.stringify(item), { expirationTtl: 3600 });
  log({ event: 'retry_enqueued', user_id: item.user_id, agent_id: item.agent_id, attempts: item.attempts });
}

export async function drainRetryQueue(env: Env, ctx: ExecutionContext): Promise<void> {
  // KV list — eventually consistent, но для нашего объёма (десятки в час) хватает.
  const list = await env.RETRY_QUEUE.list({ prefix: 'retry:', limit: 100 });
  for (const k of list.keys) {
    ctx.waitUntil(processRetry(env, k.name));
  }
}

async function processRetry(env: Env, key: string): Promise<void> {
  const raw = await env.RETRY_QUEUE.get(key);
  if (!raw) return;
  let item: RetryQueueItem;
  try {
    item = JSON.parse(raw) as RetryQueueItem;
  } catch {
    await env.RETRY_QUEUE.delete(key);
    return;
  }
  // Удаляем сразу чтобы не было гонки между двумя cron-запусками.
  await env.RETRY_QUEUE.delete(key);

  try {
    const res = await callLLM(env, item.messages as LlmMessage[]);
    await env.DB.prepare(
      `INSERT INTO agent_invocations
       (tg_user_id, agent_id, model, provider, input_tokens, output_tokens, latency_ms, status, cost_usd_e4)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    )
      .bind(
        item.user_id, item.agent_id, res.model, res.provider,
        res.input_tokens, res.output_tokens, res.latency_ms,
        'retried_ok',
        llmCostUsdE4(res.provider, res.model, res.input_tokens, res.output_tokens),
      )
      .run();
    await env.DB.prepare(
      `INSERT INTO messages (tg_user_id, agent_id, role, content) VALUES (?,?,?,?)`,
    )
      .bind(item.user_id, item.agent_id, 'assistant', res.content)
      .run();
    await sendMessage(env, item.chat_id, `Ответ готов (повторная попытка):\n\n${res.content}`);
    log({ event: 'retry_ok', user_id: item.user_id, agent_id: item.agent_id, attempts: item.attempts });
  } catch (e) {
    item.attempts += 1;
    if (item.attempts >= MAX_ATTEMPTS) {
      // Возвращаем квоту юзеру — мы списали её при оригинальном handleMessage, но ответ не выдали.
      const today = parseInt(new Date().toISOString().slice(0, 10).replace(/-/g, ''), 10);
      await env.DB.prepare(
        `UPDATE usage_quota SET count = MAX(0, count - 1)
         WHERE tg_user_id = ? AND agent_id = ? AND date = ?`,
      )
        .bind(item.user_id, item.agent_id, today)
        .run();
      await sendMessage(
        env,
        item.chat_id,
        `Не удалось получить ответ после ${MAX_ATTEMPTS} попыток. Запрос не учтён в квоте — попробуйте позже или напишите в поддержку.`,
      );
      log({ event: 'retry_giveup', level: 'error', user_id: item.user_id, agent_id: item.agent_id, error: (e as Error).message });
    } else {
      // Re-enqueue с инкрементированным attempts
      await enqueueRetry(env, item);
    }
  }
}
