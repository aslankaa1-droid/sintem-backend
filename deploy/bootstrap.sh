#!/usr/bin/env bash
# SINTEM backend bootstrap — creates Cloudflare infra and patches wrangler.toml
# Run from project root: bash deploy/bootstrap.sh
# Prereq: wrangler login (interactive browser OAuth) OR CLOUDFLARE_API_TOKEN env var
set -euo pipefail

cd "$(dirname "$0")/.."

# Helper: extract id = "..." from wrangler stdout (handles both YAML-ish and JSON-ish output)
extract_id() {
  echo "$1" | grep -oE '"?id"?\s*[=:]\s*"[a-f0-9]{20,}"' | sed -E 's/.*"([a-f0-9]{20,})".*/\1/' | head -1
}

extract_d1_id() {
  echo "$1" | grep -oE '"?database_id"?\s*[=:]\s*"[a-f0-9-]{30,}"' | sed -E 's/.*"([a-f0-9-]{30,})".*/\1/' | head -1
}

separator() { echo ""; echo "=================================================================="; }

# ============================================================
# Step 1: Auth check
# ============================================================
separator
echo "Step 1/6 — Cloudflare auth check"
echo "=================================================================="

WHOAMI_OUT=$(npx wrangler whoami 2>&1 || true)
if echo "$WHOAMI_OUT" | grep -qi "not authenticated"; then
  echo "ERROR: Not authenticated to Cloudflare."
  echo ""
  echo "Run one of:"
  echo "  ! wrangler login                                  # interactive browser"
  echo "  export CLOUDFLARE_API_TOKEN=your_api_token        # if you have a token"
  echo ""
  exit 1
fi
echo "OK — authenticated."

# ============================================================
# Step 2: Idempotency check
# ============================================================
separator
echo "Step 2/6 — wrangler.toml state check"
echo "=================================================================="
if ! grep -q "REPLACE_WITH_REAL_" wrangler.toml; then
  echo "wrangler.toml has no REPLACE_WITH_REAL_* placeholders — already configured."
  echo "If you want to re-bootstrap, restore wrangler.toml from git or backup first."
  exit 0
fi
echo "Placeholders found — proceeding."

# Backup
BACKUP_FILE="wrangler.toml.backup_$(date +%Y%m%d_%H%M%S)"
cp wrangler.toml "$BACKUP_FILE"
echo "Backup saved: $BACKUP_FILE"

# ============================================================
# Step 3: Create D1 database
# ============================================================
separator
echo "Step 3/6 — Creating D1 database 'sintem_db'"
echo "=================================================================="
D1_OUT=$(npx wrangler d1 create sintem_db 2>&1 || true)
echo "$D1_OUT"

D1_ID=$(extract_d1_id "$D1_OUT")
if [ -z "$D1_ID" ]; then
  if echo "$D1_OUT" | grep -qi "already exists\|database with name"; then
    echo ""
    echo "D1 database 'sintem_db' already exists. Listing to fetch ID..."
    LIST_OUT=$(npx wrangler d1 list 2>&1 || true)
    D1_ID=$(echo "$LIST_OUT" | grep -E "sintem_db" | grep -oE "[a-f0-9-]{30,}" | head -1)
  fi
fi
if [ -z "$D1_ID" ]; then
  echo "ERROR: could not obtain D1 database_id"
  exit 1
fi
echo "D1 ID: $D1_ID"

# ============================================================
# Step 4: Create 4 KV namespaces (production + preview each)
# ============================================================
separator
echo "Step 4/6 — Creating 4 KV namespaces (production + preview)"
echo "=================================================================="

# Bash 3.2 (macOS default) doesn't support associative arrays reliably across versions;
# use parallel scalar vars for portability.
PROMPTS_ID=""; PROMPTS_PREVIEW_ID=""
RATE_LIMITS_ID=""; RATE_LIMITS_PREVIEW_ID=""
BILLING_CACHE_ID=""; BILLING_CACHE_PREVIEW_ID=""
RETRY_QUEUE_ID=""; RETRY_QUEUE_PREVIEW_ID=""

create_kv() {
  local name=$1
  local preview_flag=$2  # "" or "--preview"
  local label
  if [ -z "$preview_flag" ]; then label="prod"; else label="preview"; fi
  echo "  - $name ($label)"
  local out
  out=$(npx wrangler kv:namespace create "$name" $preview_flag 2>&1 || true)
  local id
  id=$(extract_id "$out")
  if [ -z "$id" ]; then
    echo "    WARNING: could not parse ID, raw output:"
    echo "$out" | sed 's/^/    /'
    return 1
  fi
  echo "    ID: $id"
  printf '%s' "$id"
}

for kv in PROMPTS RATE_LIMITS BILLING_CACHE RETRY_QUEUE; do
  prod_id=$(create_kv "$kv" "")
  preview_id=$(create_kv "$kv" "--preview")
  case "$kv" in
    PROMPTS) PROMPTS_ID=$prod_id; PROMPTS_PREVIEW_ID=$preview_id ;;
    RATE_LIMITS) RATE_LIMITS_ID=$prod_id; RATE_LIMITS_PREVIEW_ID=$preview_id ;;
    BILLING_CACHE) BILLING_CACHE_ID=$prod_id; BILLING_CACHE_PREVIEW_ID=$preview_id ;;
    RETRY_QUEUE) RETRY_QUEUE_ID=$prod_id; RETRY_QUEUE_PREVIEW_ID=$preview_id ;;
  esac
done

# ============================================================
# Step 5: Patch wrangler.toml
# ============================================================
separator
echo "Step 5/6 — Patching wrangler.toml with real IDs"
echo "=================================================================="

# CRITICAL: replace *_PREVIEW placeholders BEFORE plain ones (longer string first)
# else `s|REPLACE_WITH_REAL_KV_ID_PROMPTS|...|g` would also match `..._PROMPTS_PREVIEW`
sed -i.bak \
  -e "s|REPLACE_WITH_REAL_D1_ID|$D1_ID|g" \
  -e "s|REPLACE_WITH_REAL_KV_ID_PROMPTS_PREVIEW|$PROMPTS_PREVIEW_ID|g" \
  -e "s|REPLACE_WITH_REAL_KV_ID_PROMPTS|$PROMPTS_ID|g" \
  -e "s|REPLACE_WITH_REAL_KV_ID_RL_PREVIEW|$RATE_LIMITS_PREVIEW_ID|g" \
  -e "s|REPLACE_WITH_REAL_KV_ID_RL|$RATE_LIMITS_ID|g" \
  -e "s|REPLACE_WITH_REAL_KV_ID_BILLING_PREVIEW|$BILLING_CACHE_PREVIEW_ID|g" \
  -e "s|REPLACE_WITH_REAL_KV_ID_BILLING|$BILLING_CACHE_ID|g" \
  -e "s|REPLACE_WITH_REAL_KV_ID_RETRY_PREVIEW|$RETRY_QUEUE_PREVIEW_ID|g" \
  -e "s|REPLACE_WITH_REAL_KV_ID_RETRY|$RETRY_QUEUE_ID|g" \
  wrangler.toml

# Use workers.dev for MVP (no custom domain required)
# Comment out the custom-domain routes block (3 lines) and flip workers_dev to true
# Match the 3-line block: [[routes]] ... zone_name = "sintem.example.com"
python -c '
import re, sys
p = "wrangler.toml"
with open(p, "r", encoding="utf-8") as f:
    t = f.read()
# Comment out routes block targeting example.com
t = re.sub(
    r"^\[\[routes\]\][^\n]*\npattern = \"bot\.sintem\.example\.com/\*\"[^\n]*\nzone_name = \"sintem\.example\.com\"[^\n]*\n",
    "# [[routes]] — disabled by bootstrap; using workers.dev URL for MVP\n"
    "# pattern = \"bot.sintem.example.com/*\"\n"
    "# zone_name = \"sintem.example.com\"\n",
    t, count=1, flags=re.M
)
# Flip workers_dev at top-level only (first match)
t = re.sub(r"^workers_dev = false", "workers_dev = true", t, count=1, flags=re.M)
# Update PUBLIC_BASE_URL top-level placeholder
t = re.sub(r"PUBLIC_BASE_URL = \"https://bot\.sintem\.example\.com\"",
           "PUBLIC_BASE_URL = \"https://sintem-bot.<your-cf-subdomain>.workers.dev\"  # FILL after first deploy", t)
with open(p, "w", encoding="utf-8") as f:
    f.write(t)
'

rm -f wrangler.toml.bak
echo "OK."

# ============================================================
# Step 6: Apply D1 migrations to remote
# ============================================================
separator
echo "Step 6/6 — Applying D1 migrations to remote 'sintem_db'"
echo "=================================================================="
if npx wrangler d1 migrations apply sintem_db --remote; then
  echo "OK — migrations applied."
else
  echo "WARNING: migrations failed. You can retry:"
  echo "  npx wrangler d1 migrations apply sintem_db --remote"
fi

# ============================================================
# Generate TELEGRAM_WEBHOOK_SECRET (random 64-char hex)
# ============================================================
if command -v openssl >/dev/null 2>&1; then
  WEBHOOK_SECRET=$(openssl rand -hex 32)
else
  WEBHOOK_SECRET=$(head -c 64 /dev/urandom | base64 | tr -d '/+=\n' | head -c 64)
fi

# ============================================================
# Final report
# ============================================================
cat << EOF

==================================================================
                    BOOTSTRAP COMPLETE
==================================================================

D1 database: sintem_db
  ID: $D1_ID

KV namespaces (all 8 IDs filled into wrangler.toml):
  PROMPTS:       $PROMPTS_ID  (preview: $PROMPTS_PREVIEW_ID)
  RATE_LIMITS:   $RATE_LIMITS_ID  (preview: $RATE_LIMITS_PREVIEW_ID)
  BILLING_CACHE: $BILLING_CACHE_ID  (preview: $BILLING_CACHE_PREVIEW_ID)
  RETRY_QUEUE:   $RETRY_QUEUE_ID  (preview: $RETRY_QUEUE_PREVIEW_ID)

wrangler.toml: patched
  - custom route to *.example.com → commented out (MVP uses workers.dev)
  - workers_dev = true (top-level)
  - all REPLACE_WITH_REAL_* placeholders filled
  - backup: $BACKUP_FILE

TELEGRAM_WEBHOOK_SECRET (random, set this in step 1 below; save it):
  $WEBHOOK_SECRET

==================================================================
            NEXT: SET 12 SECRETS (copy & run each line)
==================================================================

# 1 — webhook secret (random, generated above)
printf '%s' "$WEBHOOK_SECRET" | npx wrangler secret put TELEGRAM_WEBHOOK_SECRET

# 2 — Telegram Bot Token (BotFather; '@sintem_bot' is taken — register new username)
npx wrangler secret put TELEGRAM_BOT_TOKEN

# 3 — Groq (groq.com — free tier suffices for MVP)
npx wrangler secret put GROQ_API_KEY

# 4 — OpenRouter (openrouter.ai — fallback LLM)
npx wrangler secret put OPENROUTER_API_KEY

# 5-6 — Yandex Cloud (yandex.cloud — secondary fallback, РФ-resident)
npx wrangler secret put YANDEX_API_KEY
npx wrangler secret put YANDEX_FOLDER_ID

# 7-8 — NowPayments
# Note: post-expertise audit recommends YuKassa for РФ B2B; using stubs for MVP
printf 'STUB_FOR_MVP' | npx wrangler secret put NOWPAYMENTS_API_KEY
printf 'STUB_FOR_MVP' | npx wrangler secret put NOWPAYMENTS_IPN_SECRET

# 9-11 — CryptoCloud (same: stubs for MVP)
printf 'STUB_FOR_MVP' | npx wrangler secret put CRYPTOCLOUD_API_KEY
printf 'STUB_FOR_MVP' | npx wrangler secret put CRYPTOCLOUD_SECRET
printf 'STUB_FOR_MVP' | npx wrangler secret put CRYPTOCLOUD_SHOP_ID

# 12 — Admin Telegram user IDs (comma-separated; get yours from @userinfobot)
npx wrangler secret put ADMIN_TG_USER_IDS

==================================================================
            FINAL: TYPECHECK → DEPLOY → SEED → WEBHOOK
==================================================================

npm run typecheck
npx wrangler deploy                            # uses top-level config (workers.dev)
node scripts/seed-prompts.mjs                  # uploads 6 prompts to PROMPTS KV

# After deploy, copy worker URL printed by wrangler (looks like
# https://sintem-bot.<your-cf-subdomain>.workers.dev) and set webhook:

WORKER_URL="https://sintem-bot.<your-cf-subdomain>.workers.dev"
BOT_TOKEN="<paste your Telegram bot token>"
curl -X POST "https://api.telegram.org/bot\$BOT_TOKEN/setWebhook" \\
  -d "url=\$WORKER_URL/telegram/webhook" \\
  -d "secret_token=$WEBHOOK_SECRET"

# Verify webhook:
curl "https://api.telegram.org/bot\$BOT_TOKEN/getWebhookInfo"

# Test in Telegram: open the bot in Telegram, send /start.

==================================================================
EOF
