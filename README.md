# SINTEM backend (Cloudflare Workers + D1 + KV)

Telegram-бот для продавцов WB/Ozon. Один Worker обслуживает три зоны:

- `POST /webhook/telegram` — основной диспатчер сообщений и callback-ов
- `POST /webhook/nowpayments`, `POST /webhook/cryptocloud` — IPN от платежных провайдеров
- `scheduled` cron — каждые 5 минут retry/recheck, ежедневно в 00:05 UTC сброс квот и truncate

## Стек

- Cloudflare Workers (V8 isolate, NOT Node)
- D1 (sqlite-edge) — `users / subscriptions / payments / sessions / messages / agent_invocations / usage_quota`
- 4 KV: `PROMPTS / RATE_LIMITS / BILLING_CACHE / RETRY_QUEUE`
- Groq API (llama-3.3-70b-versatile) с timeout 30s + 1 retry
- NowPayments (primary) + CryptoCloud (fallback) для крипто-оплат

## Архитектура и риски

Полный документ: `../../sintem-sprint-kit-source-doc` (`E:\Проекты Аслана\SINTEM\sprint\week3_backend\architecture.md`).
Runbook деплоя: то же место, `deploy_runbook.md`.

## Структура

```
sintem/backend/
  package.json              # itty-router + wrangler + workers-types
  tsconfig.json             # strict TS, target ES2022
  wrangler.toml             # production + staging environments
  schema.sql                # D1 schema (apply once, idempotent)
  migrations/
    0001_initial.sql        # та же схема, для wrangler d1 migrations apply
  src/
    index.ts                # entry: router + scheduled handler
    types.ts                # Env, TgUpdate, Plan, etc.
    lib/
      log.ts                # structured JSON logger (no PII)
      hmac.ts               # webcrypto HMAC helpers
      tg.ts                 # Telegram API helpers
      groq.ts               # Groq client с timeout + retry
    handlers/
      telegram.ts           # /start /help /agents /pay /me /cancel /admin + free text
      payments.ts           # NowPayments + CryptoCloud invoice + webhook + activate
      cron.ts               # 5min + 00:05 UTC handlers
      admin.ts              # /admin stats + activate
      retry.ts              # RETRY_QUEUE для failed Groq
```

## Deploy за 6 шагов

1. `wrangler login`
2. `wrangler d1 create sintem_db` → подставь `database_id` в `wrangler.toml`
3. `wrangler kv:namespace create PROMPTS / RATE_LIMITS / BILLING_CACHE / RETRY_QUEUE` (×2 + `--preview`) → подставь id-ы в `wrangler.toml`
4. Установи 9 секретов через `wrangler secret put` (см. `wrangler.toml`)
5. `npm run db:migrate:remote` → применить схему
6. `npm run deploy` → задеплоить worker

После деплоя:

```bash
curl https://bot.sintem.example.com/health
# ok
```

Регистрация Telegram webhook — в `../../sintem-sprint-kit-source-doc/deploy_runbook.md` раздел 6.

## Где TODO ещё остались

Реализованы все TODO из исходного skeleton:

- ✅ NowPayments HMAC-SHA512 (sorted JSON keys per docs)
- ✅ CryptoCloud HMAC-SHA256
- ✅ NowPayments invoice creation (`createNowPaymentsInvoice`)
- ✅ CryptoCloud invoice creation (`createCryptoCloudInvoice`)
- ✅ `/admin stats` — DAU/MAU/выручка из views
- ✅ `/admin activate <user_id> <plan> <days>` — manual subscription
- ✅ `/cancel` — отключение auto_renew
- ✅ RETRY_QUEUE: enqueue в handleMessage при groq fail, drain в cron
- ✅ Re-check pending payments старше 1 часа в cron

Что НЕ реализовано в MVP (по architecture.md §9):

- streaming Groq → Telegram (sendChatAction "typing" каждые 4 сек хватает)
- multi-turn context > 4 пар (sliding window 4)
- voice / images
- A/B testing промптов
- web app для оплаты (фаза 2 после 50 платящих)

## Smoke-test чек-лист

См. `deploy_runbook.md` раздел 8 в исходном sprint kit. Кратко: `/start` → free_trial → `/agents` → выбор → диалог → 6-й запрос упирается в квоту → `/pay` → оплата в sandbox → подписка активирована.

## Стоимость

| MAU | Worker | D1 | KV | Groq | Итого |
|-----|--------|-----|-----|------|-------|
| 100 | $0 | $0 | $0 | $5–15 | $5–20 |
| 1k | $5 | $0 | $0 | $50–150 | $90–200 |
| 10k | $8 | $5 | $5+ | $500–1500 | $640–1640 |

ARPU при ₽3000/мес ≈ $35 → маржинальность 99.5%.
