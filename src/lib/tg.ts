// Telegram Bot API helpers.

import { log } from './log';
import type { Env } from '../types';

export async function tg<T = unknown>(
  env: Env,
  method: string,
  body: Record<string, unknown>,
): Promise<T> {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    log({ event: 'tg_api_error', level: 'error', method, status: res.status, body: text });
    throw new Error(`Telegram API ${method} failed: ${res.status}`);
  }
  const json = (await res.json()) as { ok: boolean; result: T; description?: string };
  if (!json.ok) throw new Error(`Telegram API ${method}: ${json.description}`);
  return json.result;
}

export const sendMessage = (env: Env, chatId: number, text: string, extra: Record<string, unknown> = {}) =>
  tg(env, 'sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });

export const editMessageText = (
  env: Env,
  chatId: number,
  messageId: number,
  text: string,
  extra: Record<string, unknown> = {},
) =>
  tg(env, 'editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...extra,
  });

export const answerCallback = (env: Env, queryId: string, text?: string) =>
  tg(env, 'answerCallbackQuery', { callback_query_id: queryId, text, cache_time: 1 });

export const sendChatAction = (env: Env, chatId: number, action: 'typing') =>
  tg(env, 'sendChatAction', { chat_id: chatId, action }).catch(() => undefined);

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    const map: Record<string, string> = {
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    };
    return map[c]!;
  });
}
