// Cron handler: invoked every 5 minutes + once per day at 00:05 UTC.

import { log } from '../lib/log';
import { recheckPendingPayments } from './payments';
import { drainRetryQueue } from './retry';
import { runRetentionNudges } from './retention';
import type { Env } from '../types';

export async function handleCron(env: Env, ctx: ExecutionContext): Promise<void> {
  log({ event: 'cron_start' });

  // 1. Drain RETRY_QUEUE — failed Groq calls.
  ctx.waitUntil(drainRetryQueue(env, ctx));

  // 2. Re-check pending payments older than 1 hour.
  ctx.waitUntil(recheckPendingPayments(env, ctx));

  // 3. Daily-only tasks: run if it's the 00:05 UTC slot (cron pattern "5 0 * * *").
  const now = new Date();
  const isDailyWindow = now.getUTCHours() === 0 && now.getUTCMinutes() < 10;
  if (isDailyWindow) {
    // 3a. Удалить usage_quota старше 7 дней
    const cutoffDate = parseInt(
      new Date(Date.now() - 7 * 86400 * 1000).toISOString().slice(0, 10).replace(/-/g, ''),
      10,
    );
    ctx.waitUntil(
      env.DB.prepare(`DELETE FROM usage_quota WHERE date < ?`).bind(cutoffDate).run().then(() => undefined),
    );

    // 3b. Truncate messages старше 30 дней
    const msgCutoff = Math.floor(Date.now() / 1000) - 30 * 86400;
    ctx.waitUntil(
      env.DB.prepare(`DELETE FROM messages WHERE created_at < ?`).bind(msgCutoff).run().then(() => undefined),
    );

    // 3c. Деактивация просроченных подписок
    ctx.waitUntil(
      env.DB.prepare(
        `UPDATE subscriptions SET is_active = 0
           WHERE is_active = 1 AND expires_at < strftime('%s','now')`,
      )
        .run()
        .then(() => undefined),
    );

    // 3d. Retention nudges (week 4): day1/2/4/7 + sub-expiring + silence-7d
    ctx.waitUntil(runRetentionNudges(env, ctx));

    log({ event: 'cron_daily_done' });
  }

  log({ event: 'cron_done' });
}
