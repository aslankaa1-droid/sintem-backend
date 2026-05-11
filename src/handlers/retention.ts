// SINTEM retention nudges (week 4 launch · retention_playbook.md).
//
// Триггеры по таймлайну юзера, считаются от users.registered_at и от
// активной подписки. Все nudges — TG-сообщения через бот, отдельно от
// активного диалога с агентом. Idempotency: используем KV BILLING_CACHE
// под ключом `nudge:<user_id>:<event>` — если ключ есть, не шлём повторно.
//
// Запускается из daily-окна handleCron() один раз в сутки.

import { log } from '../lib/log';
import { sendMessage } from '../lib/tg';
import { type Env, PLAN_CONFIG } from '../types';

const NUDGE_TTL = 60 * 86400; // 60 дней — чтобы не повторить nudge даже после сброса cache
const SECONDS_PER_DAY = 86400;

interface UserRow {
  tg_user_id: number;
  registered_at: number;
}

interface SubRow {
  tg_user_id: number;
  plan: string;
  expires_at: number;
}

async function alreadySent(env: Env, userId: number, event: string): Promise<boolean> {
  const key = `nudge:${userId}:${event}`;
  return (await env.BILLING_CACHE.get(key)) !== null;
}

async function markSent(env: Env, userId: number, event: string): Promise<void> {
  const key = `nudge:${userId}:${event}`;
  await env.BILLING_CACHE.put(key, '1', { expirationTtl: NUDGE_TTL });
}

async function sendNudge(env: Env, userId: number, event: string, text: string): Promise<void> {
  if (await alreadySent(env, userId, event)) return;
  try {
    await sendMessage(env, userId, text);
    await markSent(env, userId, event);
    log({ event: 'nudge_sent', user_id: userId, nudge: event });
  } catch (e) {
    log({ event: 'nudge_failed', level: 'warn', user_id: userId, nudge: event, error: (e as Error).message });
  }
}

/** Запуск всех retention-nudge'ов. Вызывается из daily-cron. */
export async function runRetentionNudges(env: Env, ctx: ExecutionContext): Promise<void> {
  log({ event: 'retention_start' });
  ctx.waitUntil(nudgeDay1NoFirstRequest(env));
  ctx.waitUntil(nudgeDay2NoFirstRequest(env));
  ctx.waitUntil(nudgeDay4OneAgentOnly(env));
  ctx.waitUntil(nudgeDay7TrialEnding(env));
  ctx.waitUntil(nudgeSubExpiringIn3Days(env));
  ctx.waitUntil(nudgeChurnSilence7d(env));
  log({ event: 'retention_done' });
}

/**
 * День 1: 24h после регистрации, ноль запросов → мягкий nudge с подсказкой
 * простого первого шага.
 */
async function nudgeDay1NoFirstRequest(env: Env): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const lo = now - 1 * SECONDS_PER_DAY - SECONDS_PER_DAY;
  const hi = now - 1 * SECONDS_PER_DAY;
  const rows = await env.DB.prepare(
    `SELECT u.tg_user_id, u.registered_at FROM users u
       LEFT JOIN agent_invocations a ON a.tg_user_id = u.tg_user_id
      WHERE u.is_banned = 0 AND u.is_deleted = 0
        AND u.registered_at BETWEEN ? AND ?
      GROUP BY u.tg_user_id, u.registered_at
      HAVING COUNT(a.id) = 0
      LIMIT 200`,
  )
    .bind(lo, hi)
    .all<UserRow>();
  for (const u of rows.results ?? []) {
    await sendNudge(
      env,
      u.tg_user_id,
      'd1_no_first_request',
      'Вы запустили SINTEM, но ещё не задавали ни одного вопроса. Если непонятно с чего начать — попробуйте «ABC/XYZ-аналитик»: пришлите выгрузку продаж за неделю в CSV, он покажет какие SKU тянут вниз. Или нажмите /agents и выберите любого помощника.',
    );
  }
}

/**
 * День 2: 48h после регистрации, по-прежнему ноль запросов → последний
 * мягкий толчок перед паузой.
 */
async function nudgeDay2NoFirstRequest(env: Env): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const lo = now - 2 * SECONDS_PER_DAY - SECONDS_PER_DAY;
  const hi = now - 2 * SECONDS_PER_DAY;
  const rows = await env.DB.prepare(
    `SELECT u.tg_user_id, u.registered_at FROM users u
       LEFT JOIN agent_invocations a ON a.tg_user_id = u.tg_user_id
      WHERE u.is_banned = 0 AND u.is_deleted = 0
        AND u.registered_at BETWEEN ? AND ?
      GROUP BY u.tg_user_id, u.registered_at
      HAVING COUNT(a.id) = 0
      LIMIT 200`,
  )
    .bind(lo, hi)
    .all<UserRow>();
  for (const u of rows.results ?? []) {
    await sendNudge(
      env,
      u.tg_user_id,
      'd2_no_first_request',
      'У вас осталось 5 дней триала SINTEM. Если бот непонятен — напишите в @sintem_support, ответим за 2 минуты.',
    );
  }
}

/**
 * День 4: половина триала позади. Юзер использовал ровно 1 уникального
 * агента → подсказываем второго.
 */
async function nudgeDay4OneAgentOnly(env: Env): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const lo = now - 4 * SECONDS_PER_DAY - SECONDS_PER_DAY;
  const hi = now - 4 * SECONDS_PER_DAY;
  const rows = await env.DB.prepare(
    `SELECT u.tg_user_id, u.registered_at,
            COUNT(DISTINCT a.agent_id) AS unique_agents
       FROM users u
       LEFT JOIN agent_invocations a ON a.tg_user_id = u.tg_user_id
      WHERE u.is_banned = 0 AND u.is_deleted = 0
        AND u.registered_at BETWEEN ? AND ?
      GROUP BY u.tg_user_id, u.registered_at
      HAVING unique_agents <= 1
      LIMIT 200`,
  )
    .bind(lo, hi)
    .all<UserRow & { unique_agents: number }>();
  for (const u of rows.results ?? []) {
    if (u.unique_agents === 0) continue; // их обработали день 1/2 nudges
    await sendNudge(
      env,
      u.tg_user_id,
      'd4_one_agent',
      'Половина триала позади. Из 5 помощников вы попробовали только одного — самый сильный для WB остался не открытым. «Скаут конкурентов» даёт топ-5–7 по поисковому запросу с разбором цены, отзывов и контента. Попробуйте: /agents',
    );
  }
}

/**
 * День 7: триал заканчивается через 24 часа. Если ≥3 уникальных агентов
 * (Activated) → апсейл к Старту. Если <3 → честный churn-survey.
 */
async function nudgeDay7TrialEnding(env: Env): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const lo = now - 6 * SECONDS_PER_DAY - SECONDS_PER_DAY;
  const hi = now - 6 * SECONDS_PER_DAY;
  const rows = await env.DB.prepare(
    `SELECT u.tg_user_id, u.registered_at,
            COUNT(DISTINCT a.agent_id) AS unique_agents,
            COUNT(a.id) AS total_calls
       FROM users u
       LEFT JOIN agent_invocations a ON a.tg_user_id = u.tg_user_id
       JOIN subscriptions s ON s.tg_user_id = u.tg_user_id AND s.is_active = 1 AND s.plan = 'free_trial'
      WHERE u.is_banned = 0 AND u.is_deleted = 0
        AND u.registered_at BETWEEN ? AND ?
      GROUP BY u.tg_user_id, u.registered_at
      LIMIT 200`,
  )
    .bind(lo, hi)
    .all<UserRow & { unique_agents: number; total_calls: number }>();
  for (const u of rows.results ?? []) {
    if (u.unique_agents >= 3) {
      await sendNudge(
        env,
        u.tg_user_id,
        'd7_trial_activated',
        `Триал кончается через 24 часа. У вас уже ${u.total_calls} запросов через ${u.unique_agents} помощников. Тариф «Старт» — ${PLAN_CONFIG.starter.price_rub} ₽/мес, окупает себя одной хорошо переписанной карточкой в топе.\n\nОформить: /pay`,
      );
    } else {
      await sendNudge(
        env,
        u.tg_user_id,
        'd7_trial_not_activated',
        'Триал кончается через 24 часа. Понимаю, что не всё стрельнуло. Если хотите бесплатно ещё 7 дней — напишите «продлить» в @sintem_support, разово продлим. Если не зашло — скажите в двух словах что не так, это поможет следующим селлерам.',
      );
    }
  }
}

/**
 * За 3 дня до окончания платной подписки → напоминание о продлении
 * (для всех, кто не на free_trial).
 */
async function nudgeSubExpiringIn3Days(env: Env): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const lo = now + 3 * SECONDS_PER_DAY - SECONDS_PER_DAY;
  const hi = now + 3 * SECONDS_PER_DAY;
  const rows = await env.DB.prepare(
    `SELECT tg_user_id, plan, expires_at FROM subscriptions
      WHERE is_active = 1 AND plan != 'free_trial'
        AND expires_at BETWEEN ? AND ?
      LIMIT 500`,
  )
    .bind(lo, hi)
    .all<SubRow>();
  for (const s of rows.results ?? []) {
    const date = new Date(s.expires_at * 1000).toISOString().slice(0, 10);
    await sendNudge(
      env,
      s.tg_user_id,
      `sub_expiring_${s.expires_at}`,
      `Подписка <b>${s.plan}</b> закончится ${date} — это через 3 дня. Чтобы не остаться без квот, продлите заранее: /pay`,
    );
  }
}

/**
 * Active payer молчит 7 дней → один nudge с открытым вопросом «почему?».
 * Не давим на продление, цель — снять сигнал.
 */
async function nudgeChurnSilence7d(env: Env): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - 7 * SECONDS_PER_DAY;
  const rows = await env.DB.prepare(
    `SELECT u.tg_user_id, u.registered_at,
            MAX(a.created_at) AS last_call
       FROM users u
       JOIN subscriptions s ON s.tg_user_id = u.tg_user_id AND s.is_active = 1 AND s.plan != 'free_trial'
       LEFT JOIN agent_invocations a ON a.tg_user_id = u.tg_user_id
      WHERE u.is_banned = 0 AND u.is_deleted = 0
      GROUP BY u.tg_user_id, u.registered_at
      HAVING last_call IS NOT NULL AND last_call < ?
      LIMIT 200`,
  )
    .bind(cutoff)
    .all<UserRow & { last_call: number }>();
  for (const u of rows.results ?? []) {
    // event-key включает неделю запуска nudge'а, чтобы могли отправлять снова
    // если юзер опять замолчал на 7+ дней через месяц
    const week = Math.floor(now / (7 * SECONDS_PER_DAY));
    await sendNudge(
      env,
      u.tg_user_id,
      `silence_7d_${week}`,
      'Прошла неделя без вопросов к SINTEM. Это потому что хорошо, или потому что не хватает помощника под вашу задачу? Напишите 1–2 фразы в @sintem_support — это помогает решить, какого следующего агента добавлять.',
    );
  }
}
