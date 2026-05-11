# SINTEM backend — deployment

## Quickstart with bootstrap.sh (recommended)

```bash
# 1. Authenticate to Cloudflare (interactive browser OAuth, ~30 sec)
npx wrangler login

# 2. Run bootstrap — creates D1 + 4 KV namespaces, patches wrangler.toml,
#    applies migrations, generates webhook secret, prints next-steps
bash deploy/bootstrap.sh
```

Bootstrap is idempotent — refuses to run if `wrangler.toml` no longer contains `REPLACE_WITH_REAL_*` placeholders. Backup is saved (`wrangler.toml.backup_<timestamp>`).

After bootstrap completes, follow the printed list of 12 `wrangler secret put` commands, then `wrangler deploy`.

## Manual deploy (if you want full control)

```bash
npm ci
npm run typecheck
wrangler d1 create sintem_db
wrangler kv:namespace create PROMPTS         # x4 for: PROMPTS RATE_LIMITS BILLING_CACHE RETRY_QUEUE
wrangler kv:namespace create PROMPTS --preview   # x4 preview versions too
# Fill IDs into wrangler.toml manually
wrangler d1 migrations apply sintem_db --remote
# Set 12 secrets (see Secrets section below)
wrangler deploy
node scripts/seed-prompts.mjs                # uploads 6 prompts to PROMPTS KV
```

## Secrets (12 total)

| Secret | Source |
|---|---|
| `TELEGRAM_BOT_TOKEN` | BotFather (`@sintem_bot` is taken — register new username first) |
| `TELEGRAM_WEBHOOK_SECRET` | Random 64-char hex — bootstrap generates this |
| `GROQ_API_KEY` | groq.com (free tier — primary LLM) |
| `OPENROUTER_API_KEY` | openrouter.ai (fallback LLM, qwen3.6-plus) |
| `YANDEX_API_KEY` + `YANDEX_FOLDER_ID` | yandex.cloud (secondary fallback, РФ-resident) |
| `NOWPAYMENTS_API_KEY` + `NOWPAYMENTS_IPN_SECRET` | nowpayments.io (post-expertise audit recommends YuKassa for РФ B2B instead — stubs OK for MVP) |
| `CRYPTOCLOUD_API_KEY` + `CRYPTOCLOUD_SECRET` + `CRYPTOCLOUD_SHOP_ID` | cryptocloud.plus (same caveat) |
| `ADMIN_TG_USER_IDS` | Your Telegram user_id from `@userinfobot` (comma-separated for multiple admins) |

## Set the Telegram webhook (after deploy)

```bash
WORKER_URL="https://sintem-bot.<your-cf-subdomain>.workers.dev"
BOT_TOKEN="<your Telegram bot token>"
WEBHOOK_SECRET="<value printed by bootstrap>"

curl -X POST "https://api.telegram.org/bot$BOT_TOKEN/setWebhook" \
  -d "url=$WORKER_URL/telegram/webhook" \
  -d "secret_token=$WEBHOOK_SECRET"

# Verify:
curl "https://api.telegram.org/bot$BOT_TOKEN/getWebhookInfo"
```

## GitHub Actions CI

`github-actions.yml.template` — workflow for auto-deploy on push to main.

To install:

1. Create `CLOUDFLARE_API_TOKEN` secret in repo settings → Secrets and variables → Actions
2. Create `.github/workflows/` directory in the repo
3. Copy `github-actions.yml.template` → `.github/workflows/deploy.yml`
4. Adjust paths/variables for your environment

Pushing workflow files requires a GitHub token with `workflow` scope (the default `repo` is not enough).
