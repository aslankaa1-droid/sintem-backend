// /admin commands: stats and manual subscription activation.

import { sendMessage, escapeHtml } from '../lib/tg';
import { activateSubscription } from './payments';
import { type Env, type Plan, type TgMessage, PLAN_CONFIG } from '../types';

function isAdmin(env: Env, userId: number): boolean {
  return env.ADMIN_TG_USER_IDS.split(',').map((s) => parseInt(s.trim(), 10)).includes(userId);
}

export async function handleAdmin(env: Env, msg: TgMessage): Promise<void> {
  if (!msg.from || !msg.text) return;
  const chatId = msg.chat.id;
  if (!isAdmin(env, msg.from.id)) {
    await sendMessage(env, chatId, '⛔ Нет доступа.');
    return;
  }
  const parts = msg.text.split(/\s+/);
  const sub = parts[1] ?? 'help';

  if (sub === 'stats') {
    await sendStats(env, chatId);
    return;
  }
  if (sub === 'activate') {
    const userId = parseInt(parts[2] ?? '', 10);
    const plan = parts[3] as Plan | undefined;
    const days = parseInt(parts[4] ?? '30', 10);
    if (!userId || !plan || !(plan in PLAN_CONFIG)) {
      await sendMessage(env, chatId, 'Использование: /admin activate &lt;user_id&gt; &lt;plan&gt; [days]\nПлан: free_trial | starter | pro | business');
      return;
    }
    await activateManual(env, chatId, userId, plan, days);
    return;
  }
  if (sub === 'ban' || sub === 'unban') {
    const userId = parseInt(parts[2] ?? '', 10);
    if (!userId) {
      await sendMessage(env, chatId, `Использование: /admin ${sub} &lt;user_id&gt;`);
      return;
    }
    await env.DB.prepare(`UPDATE users SET is_banned = ? WHERE tg_user_id = ?`)
      .bind(sub === 'ban' ? 1 : 0, userId)
      .run();
    await env.BILLING_CACHE.delete(`sub:${userId}`);
    await sendMessage(env, chatId, `✅ Пользователь ${userId} ${sub === 'ban' ? 'забанен' : 'разбанен'}.`);
    return;
  }

  await sendMessage(
    env,
    chatId,
    '<b>Admin commands</b>\n' +
      '/admin stats — DAU/MAU/выручка\n' +
      '/admin activate &lt;user_id&gt; &lt;plan&gt; [days] — выдать подписку вручную\n' +
      '/admin ban &lt;user_id&gt; — заблокировать пользователя\n' +
      '/admin unban &lt;user_id&gt; — разблокировать',
  );
}

async function sendStats(env: Env, chatId: number): Promise<void> {
  const dau = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM v_active_users WHERE days_since_seen <= 1`,
  ).first<{ n: number }>();
  const mau = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM users WHERE last_seen_at > strftime('%s','now') - 30*86400 AND is_banned = 0 AND is_deleted = 0`,
  ).first<{ n: number }>();
  const paying = await env.DB.prepare(
    `SELECT COUNT(DISTINCT tg_user_id) AS n FROM subscriptions WHERE is_active = 1 AND plan != 'free_trial' AND expires_at > strftime('%s','now')`,
  ).first<{ n: number }>();
  const trial = await env.DB.prepare(
    `SELECT COUNT(DISTINCT tg_user_id) AS n FROM subscriptions WHERE is_active = 1 AND plan = 'free_trial' AND expires_at > strftime('%s','now')`,
  ).first<{ n: number }>();
  const rev7 = await env.DB.prepare(
    `SELECT COALESCE(SUM(amount_rub), 0) AS s FROM payments
       WHERE status = 'paid' AND finalized_at > strftime('%s','now') - 7*86400`,
  ).first<{ s: number }>();
  const rev30 = await env.DB.prepare(
    `SELECT COALESCE(SUM(amount_rub), 0) AS s FROM payments
       WHERE status = 'paid' AND finalized_at > strftime('%s','now') - 30*86400`,
  ).first<{ s: number }>();
  const errors = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM agent_invocations
       WHERE status NOT IN ('success','retried_ok') AND created_at > strftime('%s','now') - 86400`,
  ).first<{ n: number }>();
  const totalCalls = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM agent_invocations WHERE created_at > strftime('%s','now') - 86400`,
  ).first<{ n: number }>();

  const errorRate = totalCalls && totalCalls.n > 0 ? ((errors?.n ?? 0) / totalCalls.n * 100).toFixed(1) : '0.0';

  await sendMessage(
    env,
    chatId,
    `<b>📊 SINTEM stats</b>\n` +
      `DAU: <b>${dau?.n ?? 0}</b>\n` +
      `MAU: <b>${mau?.n ?? 0}</b>\n` +
      `Платящих сейчас: <b>${paying?.n ?? 0}</b>\n` +
      `На trial: <b>${trial?.n ?? 0}</b>\n\n` +
      `Выручка 7д: <b>${rev7?.s ?? 0} ₽</b>\n` +
      `Выручка 30д: <b>${rev30?.s ?? 0} ₽</b>\n\n` +
      `Groq calls 24ч: ${totalCalls?.n ?? 0}\n` +
      `Error rate 24ч: <b>${errorRate}%</b>`,
  );
}

async function activateManual(env: Env, chatId: number, userId: number, plan: Plan, days: number): Promise<void> {
  // Создаём admin_manual платёж и активируем подписку с произвольным duration.
  if (plan === 'free_trial') {
    const expires = Math.floor(Date.now() / 1000) + days * 86400;
    await env.DB.batch([
      env.DB.prepare(`UPDATE subscriptions SET is_active = 0 WHERE tg_user_id = ? AND is_active = 1`).bind(userId),
      env.DB.prepare(
        `INSERT INTO subscriptions (tg_user_id, plan, is_active, expires_at, source)
         VALUES (?, 'free_trial', 1, ?, 'admin_manual')`,
      ).bind(userId, expires),
    ]);
    await env.BILLING_CACHE.delete(`sub:${userId}`);
    await sendMessage(env, chatId, `✅ Free trial выдан user ${userId} на ${days} дней.`);
    return;
  }
  // paid plan — создаём admin_manual payment с amount=0
  const pay = await env.DB.prepare(
    `INSERT INTO payments (tg_user_id, provider, amount_rub, plan, status, finalized_at)
     VALUES (?, 'admin_manual', 0, ?, 'paid', strftime('%s','now'))
     RETURNING id`,
  )
    .bind(userId, plan)
    .first<{ id: number }>();
  if (!pay) {
    await sendMessage(env, chatId, '❌ Не удалось создать платёж.');
    return;
  }
  // Использование activateSubscription с кастомным days требует обхода PLAN_CONFIG —
  // делаем это вручную чтобы не ломать стандартный flow.
  const expires = Math.floor(Date.now() / 1000) + days * 86400;
  await env.DB.batch([
    env.DB.prepare(`UPDATE subscriptions SET is_active = 0 WHERE tg_user_id = ? AND is_active = 1`).bind(userId),
    env.DB.prepare(
      `INSERT INTO subscriptions (tg_user_id, plan, is_active, expires_at, payment_id, source)
       VALUES (?, ?, 1, ?, ?, 'admin_manual')`,
    ).bind(userId, plan, expires, pay.id),
  ]);
  await env.BILLING_CACHE.delete(`sub:${userId}`);
  await sendMessage(env, chatId, `✅ Тариф <b>${escapeHtml(plan)}</b> активирован user ${userId} на ${days} дней (payment ${pay.id}).`);
  // Уведомить юзера
  await sendMessage(
    env,
    userId,
    `Вам активирована подписка <b>${escapeHtml(plan)}</b> до ${new Date(expires * 1000).toISOString().slice(0, 10)} (вручную администратором).`,
  ).catch(() => undefined);
  // Подавляем неиспользование импорта activateSubscription — оставлен для будущих мест где duration стандартный
  void activateSubscription;
}
