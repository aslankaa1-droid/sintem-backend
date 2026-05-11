// SINTEM Telegram bot — Cloudflare Worker entry point.
// Runtime: Cloudflare Workers (V8 isolate, NOT Node).
// TypeScript strict mode. No console.log: only structured JSON via lib/log.

import { Router, type IRequest } from 'itty-router';
import { log } from './lib/log';
import { handleTelegramUpdate } from './handlers/telegram';
import { handleNowPaymentsWebhook, handleCryptoCloudWebhook } from './handlers/payments';
import { handleCron } from './handlers/cron';
import type { Env, TgUpdate } from './types';

const router = Router();

router.get('/health', () => new Response('ok', { status: 200 }));

router.post('/webhook/telegram', async (req: IRequest, env: Env, ctx: ExecutionContext) => {
  const secret = req.headers.get('x-telegram-bot-api-secret-token');
  if (secret !== env.TELEGRAM_WEBHOOK_SECRET) {
    log({ event: 'tg_webhook_bad_secret', level: 'warn' });
    return new Response('forbidden', { status: 403 });
  }
  const update = (await req.json()) as TgUpdate;
  // Telegram считает успехом любой 2xx; если бросить — сделают retry до 6 раз.
  // Тяжелую работу делаем через ctx.waitUntil чтобы быстро ответить 200.
  ctx.waitUntil(
    handleTelegramUpdate(env, ctx, update).catch((e) =>
      log({ event: 'handler_failed', level: 'error', error: (e as Error).message, update_id: update.update_id }),
    ),
  );
  return new Response('', { status: 200 });
});

router.post('/webhook/nowpayments', async (req: IRequest, env: Env, ctx: ExecutionContext) => {
  const sig = req.headers.get('x-nowpayments-sig') ?? '';
  const body = await req.text();
  return handleNowPaymentsWebhook(env, ctx, body, sig);
});

router.post('/webhook/cryptocloud', async (req: IRequest, env: Env, ctx: ExecutionContext) => {
  // CryptoCloud отправляет header `Sign` (capitalized). Принимаем оба варианта.
  const sig = req.headers.get('Sign') ?? req.headers.get('x-signature') ?? '';
  const body = await req.text();
  return handleCryptoCloudWebhook(env, ctx, body, sig);
});

router.get('/pay/success', () => new Response('Оплата прошла. Возвращайтесь в Telegram-бот.', { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } }));
router.get('/pay/cancel', () => new Response('Оплата отменена.', { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } }));

router.all('*', () => new Response('not found', { status: 404 }));

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await router.fetch(request, env, ctx);
    } catch (e) {
      log({ event: 'unhandled', level: 'error', error: (e as Error).message });
      return new Response('internal', { status: 500 });
    }
  },
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    await handleCron(env, ctx);
  },
};
