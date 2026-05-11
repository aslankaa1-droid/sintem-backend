-- SINTEM D1 schema, sqlite-edge dialect (Cloudflare D1)
-- Apply: wrangler d1 execute sintem_db --file=./schema.sql --remote
-- Idempotent: использует CREATE TABLE IF NOT EXISTS. Для миграций после v1 заводим numbered migrations/0001_xxx.sql.

PRAGMA foreign_keys = ON;

-- ============================================================
-- users: Telegram-пользователь, корневая сущность
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
  -- Telegram user.id, never recycled, безопасно использовать как PK
  tg_user_id      INTEGER PRIMARY KEY,
  -- username опционален в Telegram, может быть NULL у пользователей без @handle
  username        TEXT,
  -- first_name приходит всегда; нужен для приветствия
  first_name      TEXT NOT NULL,
  -- last_name опционален
  last_name       TEXT,
  -- en/ru/etc, из Telegram update language_code; используем для локализации ошибок
  language_code   TEXT,
  -- timestamp в unix seconds, для аналитики когорт
  registered_at   INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  -- статус блокировки, для banned юзеров не отвечаем (антиспам)
  is_banned       INTEGER NOT NULL DEFAULT 0 CHECK (is_banned IN (0,1)),
  -- soft delete для GDPR/152-ФЗ /delete_me, не дропаем чтобы не ломать FK на payments
  is_deleted      INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0,1)),
  -- последний раз увидели юзера, чтобы считать DAU/MAU
  last_seen_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  -- источник трафика для аналитики UTM
  utm_source      TEXT
);

CREATE INDEX IF NOT EXISTS idx_users_last_seen ON users(last_seen_at);
CREATE INDEX IF NOT EXISTS idx_users_registered ON users(registered_at);

-- ============================================================
-- subscriptions: активные/прошлые тарифы пользователя
-- ============================================================
CREATE TABLE IF NOT EXISTS subscriptions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_user_id      INTEGER NOT NULL REFERENCES users(tg_user_id) ON DELETE CASCADE,
  -- free_trial, starter, pro, business; не enum чтобы менять тарифы без миграций
  plan            TEXT NOT NULL CHECK (plan IN ('free_trial','starter','pro','business')),
  -- активна ли сейчас; одна активная на юзера, проверяется триггером ниже
  is_active       INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  started_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  -- expires_at = started_at + 30 дней для paid, +7 дней для free_trial
  expires_at      INTEGER NOT NULL,
  -- ID платежа, который активировал подписку; NULL для free_trial
  payment_id      INTEGER REFERENCES payments(id) ON DELETE SET NULL,
  -- авто-продление включено? для отмены через /cancel
  auto_renew      INTEGER NOT NULL DEFAULT 0 CHECK (auto_renew IN (0,1)),
  -- кто активировал: webhook | admin_manual | trial_auto
  source          TEXT NOT NULL DEFAULT 'webhook',
  created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS idx_sub_user_active ON subscriptions(tg_user_id, is_active);
CREATE INDEX IF NOT EXISTS idx_sub_expires ON subscriptions(expires_at) WHERE is_active = 1;

-- ============================================================
-- payments: каждая попытка оплаты, в т.ч. неудачная
-- ============================================================
CREATE TABLE IF NOT EXISTS payments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_user_id      INTEGER NOT NULL REFERENCES users(tg_user_id) ON DELETE RESTRICT,
  -- nowpayments | cryptocloud | admin_manual
  provider        TEXT NOT NULL CHECK (provider IN ('nowpayments','cryptocloud','admin_manual')),
  -- ID платежа от провайдера; для admin_manual NULL; UNIQUE для idempotency webhook
  provider_payment_id TEXT,
  -- запрашиваемая сумма в RUB до конвертации в крипту
  amount_rub      INTEGER NOT NULL,
  -- фактически уплачено в crypto (в satoshi/lamport/wei смотря какая монета)
  crypto_amount   TEXT,
  crypto_currency TEXT,
  -- выбранный тариф, тот же CHECK что в subscriptions
  plan            TEXT NOT NULL CHECK (plan IN ('starter','pro','business')),
  -- pending | paid | failed | expired | refunded
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','paid','failed','expired','refunded')),
  -- TX hash в блокчейне, заполняется когда платеж confirmed
  tx_hash         TEXT,
  -- payload от провайдера для дебага (JSON)
  raw_payload     TEXT,
  created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  -- момент финального статуса (paid/failed/expired)
  finalized_at    INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pay_provider_id
  ON payments(provider, provider_payment_id) WHERE provider_payment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pay_user_status ON payments(tg_user_id, status);
CREATE INDEX IF NOT EXISTS idx_pay_pending_recheck
  ON payments(created_at) WHERE status = 'pending';

-- ============================================================
-- sessions: текущее состояние диалога юзера с ботом
-- ============================================================
CREATE TABLE IF NOT EXISTS sessions (
  -- одна активная сессия на юзера, поэтому tg_user_id это PK
  tg_user_id      INTEGER PRIMARY KEY REFERENCES users(tg_user_id) ON DELETE CASCADE,
  -- какой агент сейчас выбран; NULL = no agent selected
  active_agent_id TEXT,
  -- idle | awaiting_input | processing | error
  state           TEXT NOT NULL DEFAULT 'idle'
                  CHECK (state IN ('idle','awaiting_input','processing','error')),
  -- JSON: последние 4 пары (user/assistant) для context window
  context_window  TEXT NOT NULL DEFAULT '[]',
  -- автоматически тушим сессию через 30 мин idle, проверяем в worker
  updated_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at);

-- ============================================================
-- messages: история переписки, TTL 30 дней
-- ============================================================
CREATE TABLE IF NOT EXISTS messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_user_id      INTEGER NOT NULL REFERENCES users(tg_user_id) ON DELETE CASCADE,
  -- к какому агенту относится; NULL для системных команд
  agent_id        TEXT,
  -- user | assistant | system
  role            TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
  content         TEXT NOT NULL,
  -- Telegram message_id для возможности editMessageText в будущем
  tg_message_id   INTEGER,
  -- связь с инвокацией, если это assistant-message
  invocation_id   INTEGER REFERENCES agent_invocations(id) ON DELETE SET NULL,
  created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS idx_msg_user_created ON messages(tg_user_id, created_at DESC);
-- для cron truncate старых сообщений
CREATE INDEX IF NOT EXISTS idx_msg_created ON messages(created_at);

-- ============================================================
-- agent_invocations: каждый вызов LLM, для аналитики и биллинга
-- ============================================================
CREATE TABLE IF NOT EXISTS agent_invocations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_user_id      INTEGER NOT NULL REFERENCES users(tg_user_id) ON DELETE CASCADE,
  agent_id        TEXT NOT NULL,
  -- llama-3.3-70b-versatile, etc.
  model           TEXT NOT NULL,
  -- groq | openrouter (для будущего fallback)
  provider        TEXT NOT NULL DEFAULT 'groq',
  -- для биллинга и cost analysis
  input_tokens    INTEGER NOT NULL,
  output_tokens   INTEGER NOT NULL,
  -- end-to-end latency мы измеряем сами в worker
  latency_ms      INTEGER NOT NULL,
  -- success | timeout | rate_limit | api_error | retried_ok
  status          TEXT NOT NULL CHECK (status IN ('success','timeout','rate_limit','api_error','retried_ok')),
  error_message   TEXT,
  -- стоимость в долларах * 10000 (целое чтобы избежать float), считаем post-hoc
  cost_usd_e4     INTEGER,
  created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS idx_inv_user_created ON agent_invocations(tg_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inv_agent_status ON agent_invocations(agent_id, status, created_at);

-- ============================================================
-- usage_quota: счетчики rate-limit, по дням и по агентам
-- ============================================================
CREATE TABLE IF NOT EXISTS usage_quota (
  tg_user_id      INTEGER NOT NULL REFERENCES users(tg_user_id) ON DELETE CASCADE,
  agent_id        TEXT NOT NULL,
  -- YYYYMMDD как INTEGER для эффективного индекса и партишена
  date            INTEGER NOT NULL,
  count           INTEGER NOT NULL DEFAULT 0,
  -- последнее обращение, для отладки
  last_at         INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (tg_user_id, agent_id, date)
);

-- для ежедневного cron, который удаляет квоты старше 7 дней
CREATE INDEX IF NOT EXISTS idx_quota_date ON usage_quota(date);

-- ============================================================
-- VIEWS (аналитика без materialized т.к. D1 не поддерживает MV)
-- ============================================================

-- v_active_users: кто активен сейчас (заходил последние 7 дней)
DROP VIEW IF EXISTS v_active_users;
CREATE VIEW v_active_users AS
SELECT
  u.tg_user_id,
  u.username,
  u.first_name,
  u.registered_at,
  u.last_seen_at,
  s.plan AS active_plan,
  s.expires_at AS plan_expires_at,
  CAST((strftime('%s','now') - u.last_seen_at) / 86400 AS INTEGER) AS days_since_seen
FROM users u
LEFT JOIN subscriptions s
  ON s.tg_user_id = u.tg_user_id AND s.is_active = 1
WHERE u.is_banned = 0
  AND u.is_deleted = 0
  AND u.last_seen_at > strftime('%s','now') - 7*86400;

-- v_revenue_daily: выручка по дням (только paid платежи)
DROP VIEW IF EXISTS v_revenue_daily;
CREATE VIEW v_revenue_daily AS
SELECT
  CAST(strftime('%Y%m%d', finalized_at, 'unixepoch') AS INTEGER) AS date,
  COUNT(*) AS payments_count,
  SUM(amount_rub) AS revenue_rub,
  COUNT(DISTINCT tg_user_id) AS unique_payers
FROM payments
WHERE status = 'paid' AND finalized_at IS NOT NULL
GROUP BY date;

-- v_agent_usage: сколько каждый агент стоит и используется
DROP VIEW IF EXISTS v_agent_usage;
CREATE VIEW v_agent_usage AS
SELECT
  agent_id,
  CAST(strftime('%Y%m%d', created_at, 'unixepoch') AS INTEGER) AS date,
  COUNT(*) AS invocations,
  COUNT(DISTINCT tg_user_id) AS unique_users,
  SUM(input_tokens) AS total_input_tokens,
  SUM(output_tokens) AS total_output_tokens,
  AVG(latency_ms) AS avg_latency_ms,
  SUM(cost_usd_e4) / 10000.0 AS total_cost_usd,
  SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success_count,
  SUM(CASE WHEN status != 'success' AND status != 'retried_ok' THEN 1 ELSE 0 END) AS error_count
FROM agent_invocations
WHERE created_at > strftime('%s','now') - 30*86400
GROUP BY agent_id, date;

-- ============================================================
-- Seed: служебная строка для проверки connectivity
-- ============================================================
-- INSERT OR IGNORE INTO users(tg_user_id, first_name, registered_at)
-- VALUES (0, 'system', strftime('%s','now'));
