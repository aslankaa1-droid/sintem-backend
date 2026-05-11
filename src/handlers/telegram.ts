// Telegram update dispatcher: messages and callback queries.

import { log } from '../lib/log';
import { sendMessage, sendChatAction, answerCallback, escapeHtml } from '../lib/tg';
import { callLLM, llmCostUsdE4, type LlmMessage } from '../lib/llm';
import { createInvoice } from './payments';
import { handleAdmin } from './admin';
import { enqueueRetry } from './retry';
import {
  type Env,
  type Plan,
  type PaidPlan,
  type TgMessage,
  type TgCallbackQuery,
  type TgUpdate,
  type TgUser,
  PLAN_CONFIG,
  WEDGE_AGENTS,
  AGENT_LABELS,
} from '../types';

interface QuotaResult {
  allowed: boolean;
  remaining: number;
  reason?: 'no_active_plan' | 'daily_quota' | 'flood' | 'free_minute' | 'free_daily';
}

// Anti-abuse: бесплатный тариф (free_trial) — 1 запрос/мин, 20/день суммарно по всем агентам.
// Платные — 30/мин flood-guard (старое поведение), per-agent суточная квота сохраняется.
const FREE_PER_MIN = 1;
const FREE_PER_DAY = 20;
const PAID_FLOOD_PER_MIN = 30;

export async function handleTelegramUpdate(env: Env, ctx: ExecutionContext, update: TgUpdate): Promise<void> {
  if (update.message?.text) return handleMessage(env, ctx, update.message);
  if (update.callback_query) return handleCallback(env, ctx, update.callback_query);
}

async function handleMessage(env: Env, ctx: ExecutionContext, msg: TgMessage): Promise<void> {
  if (!msg.from || !msg.text) return;
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  const text = msg.text.trim();

  await upsertUser(env, msg.from);

  // Проверяем не забанен ли юзер (silent drop)
  const user = await env.DB.prepare(`SELECT is_banned FROM users WHERE tg_user_id = ?`)
    .bind(userId)
    .first<{ is_banned: number }>();
  if (user?.is_banned === 1) return;

  if (text.startsWith('/start')) {
    // Параметр deep-link `?start=ref_<userid>` — реферальный, фиксируем при первом /start.
    const startArg = text.split(/\s+/)[1] ?? '';
    if (startArg.startsWith('ref_')) {
      const refBy = parseInt(startArg.slice(4), 10);
      if (refBy && refBy !== userId) {
        await env.DB.prepare(`UPDATE users SET utm_source = ? WHERE tg_user_id = ? AND (utm_source IS NULL OR utm_source = '')`)
          .bind(`ref_${refBy}`, userId)
          .run();
      }
    }
    const isNew = await ensureFreeTrial(env, userId);
    if (isNew) {
      // welcome_short вариант B — теплее, с обращением по имени (см. bot_dialogues.md §1)
      await sendMessage(
        env,
        chatId,
        `Здравствуйте, ${escapeHtml(msg.from.first_name)}. Это <b>SINTEM</b>.\n\n` +
          `Помогаем продавцам WB и Ozon: разбираем карточки, отвечаем на отзывы, считаем юнит-экономику и сравниваем с конкурентами. Все ответы — от профильных AI-помощников.\n\n` +
          `Первые 5 запросов к каждому помощнику бесплатны. Регистрация не нужна.`,
        { reply_markup: agentsKeyboard() },
      );
    } else {
      await sendMessage(
        env,
        chatId,
        'С возвращением. Выберите помощника или откройте /me, чтобы посмотреть остаток запросов.',
        { reply_markup: agentsKeyboard() },
      );
    }
    return;
  }

  if (text.startsWith('/help')) {
    await sendMessage(env, chatId, helpText());
    return;
  }

  if (text.startsWith('/agents')) {
    await sendMessage(env, chatId, 'Пять рабочих помощников. Выберите:', { reply_markup: agentsKeyboard() });
    return;
  }

  if (text.startsWith('/pay') || text.startsWith('/plans')) {
    await sendMessage(env, chatId, payIntroText(), { reply_markup: plansKeyboard() });
    return;
  }

  if (text.startsWith('/me') || text.startsWith('/profile')) {
    await sendMessage(env, chatId, await renderMe(env, userId));
    return;
  }

  if (text.startsWith('/about')) {
    await sendMessage(env, chatId, aboutText());
    return;
  }

  if (text.startsWith('/cancel')) {
    const upd = await env.DB.prepare(
      `UPDATE subscriptions SET auto_renew = 0
         WHERE tg_user_id = ? AND is_active = 1 AND auto_renew = 1
        RETURNING id`,
    )
      .bind(userId)
      .first<{ id: number }>();
    if (upd) {
      await sendMessage(env, chatId, '✅ Авто-продление отключено. Подписка остаётся активной до конца оплаченного периода.');
    } else {
      await sendMessage(env, chatId, 'Авто-продление и так не было включено.');
    }
    return;
  }

  if (text.startsWith('/admin')) {
    return handleAdmin(env, msg);
  }

  // Обычное сообщение — нужен выбранный агент
  const session = await env.DB.prepare(
    `SELECT active_agent_id, context_window FROM sessions WHERE tg_user_id = ?`,
  )
    .bind(userId)
    .first<{ active_agent_id: string | null; context_window: string }>();

  if (!session?.active_agent_id) {
    await sendMessage(env, chatId, 'Сначала выберите агента: /agents');
    return;
  }

  const agentId = session.active_agent_id;
  const quota = await checkAndIncrementQuota(env, userId, agentId);
  if (!quota.allowed) {
    if (quota.reason === 'no_active_plan') {
      await sendMessage(env, chatId, 'Подписка не активна. Оплатите тариф: /pay');
    } else if (quota.reason === 'free_minute' || quota.reason === 'free_daily') {
      await sendMessage(env, chatId, 'Лимит бесплатного тарифа исчерпан. Обновите подписку: /plans');
    } else if (quota.reason === 'daily_quota') {
      const label = AGENT_LABELS[agentId as (typeof WEDGE_AGENTS)[number]] ?? agentId;
      await sendMessage(
        env,
        chatId,
        `Бесплатные 5 запросов к «${escapeHtml(label)}» на сегодня закончились. Завтра в 00:00 счётчик обнулится.\n\n` +
          `Если работаете каждый день — посмотрите тарифы, на любом из них лимит кратно больше: /pay`,
      );
    }
    // flood — silent
    return;
  }

  ctx.waitUntil(sendChatAction(env, chatId, 'typing'));

  const systemPrompt = (await env.PROMPTS.get(`prompt:${agentId}`)) ??
    'You are a helpful WB/Ozon seller assistant. Answer concisely in Russian.';
  const history: LlmMessage[] = JSON.parse(session.context_window || '[]');
  const messages: LlmMessage[] = [
    { role: 'system', content: systemPrompt },
    ...history.slice(-8),
    { role: 'user', content: text },
  ];

  let llmResult;
  try {
    llmResult = await callLLM(env, messages);
  } catch (e) {
    log({ event: 'llm_failed_enqueue', level: 'error', user_id: userId, agent_id: agentId, error: (e as Error).message });
    await enqueueRetry(env, {
      user_id: userId,
      chat_id: chatId,
      agent_id: agentId,
      messages,
      attempts: 1,
      enqueued_at: Math.floor(Date.now() / 1000),
      original_msg_id: msg.message_id,
    });
    await sendMessage(env, chatId, 'Сервис AI временно перегружен. Ответ придёт автоматически в течение 5 минут.');
    return;
  }

  const invStmt = env.DB.prepare(
    `INSERT INTO agent_invocations
     (tg_user_id, agent_id, model, provider, input_tokens, output_tokens, latency_ms, status, cost_usd_e4)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).bind(
    userId, agentId, llmResult.model, llmResult.provider,
    llmResult.input_tokens, llmResult.output_tokens, llmResult.latency_ms,
    'success',
    llmCostUsdE4(llmResult.provider, llmResult.model, llmResult.input_tokens, llmResult.output_tokens),
  );
  const userMsgStmt = env.DB.prepare(
    `INSERT INTO messages (tg_user_id, agent_id, role, content, tg_message_id)
     VALUES (?,?,?,?,?)`,
  ).bind(userId, agentId, 'user', text, msg.message_id);
  const asstMsgStmt = env.DB.prepare(
    `INSERT INTO messages (tg_user_id, agent_id, role, content) VALUES (?,?,?,?)`,
  ).bind(userId, agentId, 'assistant', llmResult.content);

  ctx.waitUntil(env.DB.batch([invStmt, userMsgStmt, asstMsgStmt]).then(() => undefined));

  const newHistory = [
    ...history.slice(-6),
    { role: 'user' as const, content: text },
    { role: 'assistant' as const, content: llmResult.content },
  ];
  ctx.waitUntil(
    env.DB.prepare(
      `UPDATE sessions SET context_window = ?, state = 'idle', updated_at = strftime('%s','now')
       WHERE tg_user_id = ?`,
    )
      .bind(JSON.stringify(newHistory), userId)
      .run()
      .then(() => undefined),
  );

  await sendMessage(env, chatId, llmResult.content);
  log({
    event: 'msg_handled',
    user_id: userId,
    agent_id: agentId,
    provider: llmResult.provider,
    model: llmResult.model,
    latency_ms: llmResult.latency_ms,
    in_tokens: llmResult.input_tokens,
    out_tokens: llmResult.output_tokens,
  });
}

async function handleCallback(env: Env, ctx: ExecutionContext, q: TgCallbackQuery): Promise<void> {
  await answerCallback(env, q.id);
  if (!q.data || !q.message) return;
  const userId = q.from.id;
  const chatId = q.message.chat.id;

  if (q.data.startsWith('agent:')) {
    const agentId = q.data.slice('agent:'.length);
    if (!WEDGE_AGENTS.includes(agentId as (typeof WEDGE_AGENTS)[number])) return;
    await env.DB.prepare(
      `INSERT INTO sessions (tg_user_id, active_agent_id, state, context_window)
       VALUES (?, ?, 'awaiting_input', '[]')
       ON CONFLICT(tg_user_id) DO UPDATE SET
         active_agent_id = excluded.active_agent_id,
         state = 'awaiting_input',
         context_window = '[]',
         updated_at = strftime('%s','now')`,
    )
      .bind(userId, agentId)
      .run();
    await sendMessage(
      env,
      chatId,
      `Агент <b>${escapeHtml(AGENT_LABELS[agentId as (typeof WEDGE_AGENTS)[number]] ?? agentId)}</b> выбран. Задайте вопрос текстом.`,
    );
    return;
  }

  if (q.data.startsWith('plan:')) {
    const plan = q.data.slice('plan:'.length) as Plan;
    if (!(plan in PLAN_CONFIG) || plan === 'free_trial') return;
    try {
      const { url, payment_id, provider } = await createInvoice(env, userId, plan as PaidPlan);
      await sendMessage(
        env,
        chatId,
        `Счёт <b>${PLAN_CONFIG[plan].price_rub} ₽</b> на тариф <b>${escapeHtml(plan)}</b> создан через ${provider}.\n` +
          `Подписка активируется автоматически после оплаты.`,
        {
          reply_markup: {
            inline_keyboard: [[{ text: '💳 Оплатить', url }]],
          },
        },
      );
      log({ event: 'invoice_sent', user_id: userId, plan, payment_id, provider });
    } catch (e) {
      log({ event: 'invoice_failed', level: 'error', user_id: userId, plan, error: (e as Error).message });
      await sendMessage(env, chatId, '❌ Не удалось создать счёт. Попробуйте позже или напишите в поддержку.');
    }
    void ctx;
  }
}

// ============================================================
// Helpers
// ============================================================

async function upsertUser(env: Env, u: TgUser): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO users (tg_user_id, username, first_name, last_name, language_code, last_seen_at)
     VALUES (?, ?, ?, ?, ?, strftime('%s','now'))
     ON CONFLICT(tg_user_id) DO UPDATE SET
       username = excluded.username,
       first_name = excluded.first_name,
       last_name = excluded.last_name,
       language_code = excluded.language_code,
       last_seen_at = strftime('%s','now')`,
  )
    .bind(u.id, u.username ?? null, u.first_name, u.last_name ?? null, u.language_code ?? null)
    .run();
}

async function ensureFreeTrial(env: Env, userId: number): Promise<boolean> {
  // Возвращает true, если только что создали trial; false — если уже был у этого user'а.
  const existed = await env.DB.prepare(`SELECT 1 FROM subscriptions WHERE tg_user_id = ? LIMIT 1`)
    .bind(userId)
    .first<{ 1: number }>();
  if (existed) return false;
  const expiresAt = Math.floor(Date.now() / 1000) + 7 * 86400;
  await env.DB.prepare(
    `INSERT INTO subscriptions (tg_user_id, plan, is_active, expires_at, source)
     VALUES (?, 'free_trial', 1, ?, 'trial_auto')`,
  )
    .bind(userId, expiresAt)
    .run();
  return true;
}

async function checkAndIncrementQuota(env: Env, userId: number, agentId: string): Promise<QuotaResult> {
  const cacheKey = `sub:${userId}`;
  let sub = await env.BILLING_CACHE.get<{ plan: Plan; expires_at: number }>(cacheKey, 'json');
  if (!sub) {
    const row = await env.DB.prepare(
      `SELECT plan, expires_at FROM subscriptions
       WHERE tg_user_id = ? AND is_active = 1
       ORDER BY expires_at DESC LIMIT 1`,
    )
      .bind(userId)
      .first<{ plan: Plan; expires_at: number }>();
    if (!row) return { allowed: false, remaining: 0, reason: 'no_active_plan' };
    sub = row;
    await env.BILLING_CACHE.put(cacheKey, JSON.stringify(sub), { expirationTtl: 300 });
  }

  if (sub.expires_at < Math.floor(Date.now() / 1000)) {
    return { allowed: false, remaining: 0, reason: 'no_active_plan' };
  }

  const isFree = sub.plan === 'free_trial';
  const floodLimit = isFree ? FREE_PER_MIN : PAID_FLOOD_PER_MIN;
  const floodKey = `flood:${userId}`;
  const floodCount = parseInt((await env.RATE_LIMITS.get(floodKey)) ?? '0', 10) + 1;
  await env.RATE_LIMITS.put(floodKey, String(floodCount), { expirationTtl: 60 });
  if (floodCount > floodLimit) {
    return { allowed: false, remaining: 0, reason: isFree ? 'free_minute' : 'flood' };
  }

  if (isFree) {
    const dayKey = `free_day:${userId}:${new Date().toISOString().slice(0, 10)}`;
    const dayCount = parseInt((await env.RATE_LIMITS.get(dayKey)) ?? '0', 10) + 1;
    await env.RATE_LIMITS.put(dayKey, String(dayCount), { expirationTtl: 86400 });
    if (dayCount > FREE_PER_DAY) {
      return { allowed: false, remaining: 0, reason: 'free_daily' };
    }
  }

  await detectMultiAccount(env, userId);

  const limit = PLAN_CONFIG[sub.plan].daily_quota_per_agent;
  const today = parseInt(new Date().toISOString().slice(0, 10).replace(/-/g, ''), 10);

  // Atomic increment via D1 upsert + RETURNING
  const inc = await env.DB.prepare(
    `INSERT INTO usage_quota (tg_user_id, agent_id, date, count, last_at)
     VALUES (?, ?, ?, 1, strftime('%s','now'))
     ON CONFLICT(tg_user_id, agent_id, date) DO UPDATE SET
       count = count + 1,
       last_at = strftime('%s','now')
     RETURNING count`,
  )
    .bind(userId, agentId, today)
    .first<{ count: number }>();

  const used = inc?.count ?? 0;
  if (used > limit) {
    // Откатываем инкремент
    await env.DB.prepare(
      `UPDATE usage_quota SET count = count - 1
       WHERE tg_user_id = ? AND agent_id = ? AND date = ?`,
    )
      .bind(userId, agentId, today)
      .run();
    return { allowed: false, remaining: 0, reason: 'daily_quota' };
  }
  return { allowed: true, remaining: limit - used };
}

async function detectMultiAccount(env: Env, userId: number): Promise<void> {
  // Логирующая метка без блокировки. >=2 подписок за 30 дней у одного tg_user_id — повод проверить.
  const flag = await env.RATE_LIMITS.get(`mac:${userId}`);
  if (flag) return;
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM subscriptions
     WHERE tg_user_id = ? AND created_at > strftime('%s','now') - 30*86400`,
  )
    .bind(userId)
    .first<{ n: number }>();
  if ((row?.n ?? 0) >= 2) {
    log({ event: 'multi_account_suspected', level: 'warn', user_id: userId, subs_30d: row?.n });
  }
  await env.RATE_LIMITS.put(`mac:${userId}`, '1', { expirationTtl: 3600 });
}

function agentsKeyboard() {
  return {
    inline_keyboard: WEDGE_AGENTS.map((id) => [{ text: AGENT_LABELS[id], callback_data: `agent:${id}` }]),
  };
}

function plansKeyboard() {
  return {
    inline_keyboard: (['starter', 'pro', 'business'] as Plan[]).map((p) => [
      { text: `${p} — ${PLAN_CONFIG[p].price_rub} ₽/мес`, callback_data: `plan:${p}` },
    ]),
  };
}

function helpText(): string {
  // bot_dialogues.md §2 `help`
  return (
    '<b>SINTEM</b>. Что внутри.\n\n' +
    'Помощники:\n' +
    '— 🩺 Карточка-доктор: разбор карточки WB/Ozon\n' +
    '— 💬 Ответ на отзыв: три варианта ответа\n' +
    '— 🔭 Скаут конкурентов: сравнение с 5–7 конкурентами\n' +
    '— 📊 ABC/XYZ: чистка ассортимента\n' +
    '— 💰 Юнит-экономика: маржа и точка безубытка\n\n' +
    'Команды:\n' +
    '/start — начало работы\n' +
    '/agents — список помощников\n' +
    '/me — тариф и остаток запросов\n' +
    '/pay — оплатить или продлить тариф\n' +
    '/cancel — отключить авто-продление\n' +
    '/about — о сервисе и оферта\n\n' +
    'Поддержка: @sintem_support'
  );
}

function aboutText(): string {
  // bot_dialogues.md §2 `about`
  return (
    '<b>SINTEM</b> — информационный сервис для селлеров маркетплейсов. Помогает разобрать карточку, ответить на отзыв, посчитать юнит-экономику, сравнить с конкурентами.\n\n' +
    'Оплата принимается в криптовалюте через NowPayments и CryptoCloud. Чек по запросу.\n\n' +
    'Сервис не заменяет профильного специалиста и не даёт юридических, налоговых или медицинских консультаций. Все рекомендации — информационные.\n\n' +
    'Контакт: @sintem_support'
  );
}

function payIntroText(): string {
  // bot_dialogues.md §3 `pay_intro`
  return (
    '<b>Тарифы SINTEM.</b>\n\n' +
    `Старт — ${PLAN_CONFIG.starter.price_rub} ₽/мес, ${PLAN_CONFIG.starter.daily_quota_per_agent} запросов в день на агента\n` +
    `Рост — ${PLAN_CONFIG.pro.price_rub} ₽/мес, ${PLAN_CONFIG.pro.daily_quota_per_agent} запросов, приоритет очереди\n` +
    `Бизнес — ${PLAN_CONFIG.business.price_rub} ₽/мес, ${PLAN_CONFIG.business.daily_quota_per_agent} запросов, приоритет, экспорт CSV\n\n` +
    'Оплата криптовалютой. Без подписки — каждый месяц отдельным платежом. Выберите тариф.'
  );
}

async function renderMe(env: Env, userId: number): Promise<string> {
  const sub = await env.DB.prepare(
    `SELECT plan, expires_at, auto_renew FROM subscriptions
     WHERE tg_user_id = ? AND is_active = 1 LIMIT 1`,
  )
    .bind(userId)
    .first<{ plan: Plan; expires_at: number; auto_renew: number }>();
  if (!sub) return 'Подписка не активна. /pay';
  const days = Math.max(0, Math.floor((sub.expires_at - Date.now() / 1000) / 86400));
  return (
    `Тариф: <b>${escapeHtml(sub.plan)}</b>\n` +
    `Осталось дней: ${days}\n` +
    `Авто-продление: ${sub.auto_renew ? 'да' : 'нет'}\n` +
    `Квота на агента в сутки: ${PLAN_CONFIG[sub.plan].daily_quota_per_agent}`
  );
}
