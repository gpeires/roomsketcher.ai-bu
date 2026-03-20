#!/usr/bin/env bash
set -euo pipefail

# ─── Load .env ────────────────────────────────────────────────────────────────
ENV_FILE="${1:-.env}"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "Error: $ENV_FILE not found. Copy .env.example to .env and fill in your values."
  exit 1
fi

# shellcheck disable=SC1090
source "$ENV_FILE"

# ─── Validate required vars ──────────────────────────────────────────────────
missing=()
[[ -z "${CLOUDFLARE_API_TOKEN:-}" ]] && missing+=("CLOUDFLARE_API_TOKEN")
[[ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]] && missing+=("CLOUDFLARE_ACCOUNT_ID")
if [[ ${#missing[@]} -gt 0 ]]; then
  echo "Error: Missing required env vars: ${missing[*]}"
  exit 1
fi

export CLOUDFLARE_API_TOKEN
export CLOUDFLARE_ACCOUNT_ID

DB_NAME="${D1_DATABASE_NAME:-roomsketcher-help}"
WORKER_NAME="${WORKER_NAME:-roomsketcher-help-mcp}"

echo "==> Deploying $WORKER_NAME"
echo "    Account:  $CLOUDFLARE_ACCOUNT_ID"
echo "    Database: $DB_NAME"
echo ""

# ─── Step 0: Ensure workers.dev subdomain exists ─────────────────────────────
echo "--- Checking workers.dev subdomain..."

CF_API="https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/subdomain"
CF_HEADERS=(-H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" -H "Content-Type: application/json")

# Helper: extract subdomain from API JSON response
extract_subdomain() {
  node -e "
    let buf=''; process.stdin.on('data',d=>buf+=d);
    process.stdin.on('end',()=>{
      const r=JSON.parse(buf);
      if(r.result && r.result.subdomain) process.stdout.write(r.result.subdomain);
    })
  "
}

# Helper: try to create a subdomain, return it on success or empty on failure
try_create_subdomain() {
  local name="$1"
  local resp
  resp=$(curl -s -X PUT "$CF_API" "${CF_HEADERS[@]}" --data "{\"subdomain\":\"${name}\"}")
  echo "$resp" | extract_subdomain
}

# 1. Check if one already exists
SUBDOMAIN=$(curl -s "$CF_API" "${CF_HEADERS[@]}" | extract_subdomain)

if [[ -n "$SUBDOMAIN" ]]; then
  echo "    Found: ${SUBDOMAIN}.workers.dev"
else
  # 2. If WORKERS_SUBDOMAIN is set in env, try that first
  if [[ -n "${WORKERS_SUBDOMAIN:-}" ]]; then
    echo "    Trying '${WORKERS_SUBDOMAIN}.workers.dev'..."
    SUBDOMAIN=$(try_create_subdomain "$WORKERS_SUBDOMAIN")
  fi

  # 3. If still empty, let Cloudflare auto-generate one
  if [[ -z "$SUBDOMAIN" ]]; then
    echo "    Auto-generating subdomain..."
    # Cloudflare auto-generates when you open Workers in the dashboard.
    # Via API, we can trigger this by using the account ID prefix as a throwaway name.
    # If that's taken too, use a random suffix.
    AUTO_NAME="${CLOUDFLARE_ACCOUNT_ID:0:8}-workers"
    SUBDOMAIN=$(try_create_subdomain "$AUTO_NAME")
  fi

  if [[ -z "$SUBDOMAIN" ]]; then
    # Last resort: random suffix
    RANDOM_NAME="workers-$(head -c 4 /dev/urandom | xxd -p)"
    echo "    '${AUTO_NAME}' taken, trying '${RANDOM_NAME}'..."
    SUBDOMAIN=$(try_create_subdomain "$RANDOM_NAME")
  fi

  if [[ -z "$SUBDOMAIN" ]]; then
    echo "Error: Could not create a workers.dev subdomain after multiple attempts."
    echo "  Create one manually: https://dash.cloudflare.com -> Workers & Pages"
    exit 1
  fi
  echo "    Created: ${SUBDOMAIN}.workers.dev"
fi

# ─── Step 1: Ensure D1 database exists ───────────────────────────────────────
echo "--- Checking D1 database..."
DB_ID=$(npx wrangler d1 list --json 2>/dev/null \
  | node -e "
    let buf=''; process.stdin.on('data',d=>buf+=d);
    process.stdin.on('end',()=>{
      const dbs=JSON.parse(buf);
      const db=dbs.find(d=>d.name==='$DB_NAME');
      if(db) process.stdout.write(db.uuid);
    })
  ")

if [[ -z "$DB_ID" ]]; then
  echo "    Creating D1 database '$DB_NAME'..."
  CREATE_OUTPUT=$(npx wrangler d1 create "$DB_NAME" 2>&1)
  DB_ID=$(echo "$CREATE_OUTPUT" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')
  if [[ -z "$DB_ID" ]]; then
    echo "Error: Failed to extract database ID from create output:"
    echo "$CREATE_OUTPUT"
    exit 1
  fi
  echo "    Created: $DB_ID"
else
  echo "    Found:   $DB_ID"
fi

# ─── Step 1b: Ensure AI Gateway exists ───────────────────────────────────────
echo "--- Checking AI Gateway..."
AI_GW_API="https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai-gateway/gateways"
AI_GW_ID="roomsketcher-ai"

AI_GW_EXISTS=$(curl -s "${AI_GW_API}/${AI_GW_ID}" "${CF_HEADERS[@]}" \
  | node -e "
    let buf=''; process.stdin.on('data',d=>buf+=d);
    process.stdin.on('end',()=>{
      const r=JSON.parse(buf);
      if(r.success && r.result && r.result.id) process.stdout.write('yes');
    })
  ")

if [[ "$AI_GW_EXISTS" == "yes" ]]; then
  echo "    Found: AI Gateway '${AI_GW_ID}'"
else
  echo "    Creating AI Gateway '${AI_GW_ID}'..."
  CREATE_GW_RESP=$(curl -s -X POST "$AI_GW_API" "${CF_HEADERS[@]}" \
    --data "{\"id\":\"${AI_GW_ID}\",\"name\":\"RoomSketcher AI Gateway\",\"cache_invalidate_on_update\":true,\"cache_ttl\":86400,\"collect_logs\":true,\"rate_limiting_interval\":60,\"rate_limiting_limit\":100}")
  GW_SUCCESS=$(echo "$CREATE_GW_RESP" | node -e "
    let buf=''; process.stdin.on('data',d=>buf+=d);
    process.stdin.on('end',()=>{
      const r=JSON.parse(buf);
      process.stdout.write(r.success ? 'yes' : 'no');
    })
  ")
  if [[ "$GW_SUCCESS" == "yes" ]]; then
    echo "    Created: AI Gateway '${AI_GW_ID}'"
  else
    echo "    Warning: Could not create AI Gateway. AI enrichment will be unavailable."
    echo "    Response: $CREATE_GW_RESP"
  fi
fi

# ─── Step 2: Patch wrangler.toml with real database_id ───────────────────────
echo "--- Updating wrangler.toml with database_id..."
if [[ "$(uname)" == "Darwin" ]]; then
  sed -i '' "s/^database_id = .*/database_id = \"$DB_ID\"/" wrangler.toml
else
  sed -i "s/^database_id = .*/database_id = \"$DB_ID\"/" wrangler.toml
fi

# ─── Step 3: Run D1 schema migration ─────────────────────────────────────────
echo "--- Running schema migration..."
npx wrangler d1 execute "$DB_NAME" --remote --file=src/db/schema.sql --yes

# ─── Step 4: Install dependencies ────────────────────────────────────────────
echo "--- Installing dependencies..."
npm ci --silent

# ─── Step 5: Deploy worker ───────────────────────────────────────────────────
echo "--- Deploying worker..."
npx wrangler deploy

# ─── Step 6: Get worker URL and trigger initial sync ─────────────────────────
WORKER_URL="https://${WORKER_NAME}.${SUBDOMAIN}.workers.dev"

# Try to get the actual route from deploy output; fall back to subdomain
echo "--- Triggering initial sync..."
echo "    POST $WORKER_URL/admin/sync"

SYNC_RESPONSE=$(curl -s -X POST "$WORKER_URL/admin/sync" \
  -H "Content-Type: application/json" \
  --max-time 60 \
  -w "\n%{http_code}" 2>&1)

HTTP_CODE=$(echo "$SYNC_RESPONSE" | tail -1)
BODY=$(echo "$SYNC_RESPONSE" | sed '$d')

if [[ "$HTTP_CODE" == "200" ]]; then
  echo "    Sync OK: $BODY"
else
  echo "    Warning: Sync returned HTTP $HTTP_CODE"
  echo "    $BODY"
  echo "    You may need to trigger sync manually once DNS propagates:"
  echo "    curl -X POST $WORKER_URL/admin/sync"
fi

# ─── Step 7: Health check ────────────────────────────────────────────────────
echo "--- Health check..."
HEALTH=$(curl -s "$WORKER_URL/health" --max-time 10 2>&1 || true)
echo "    $HEALTH"

echo ""
echo "==> Deployment complete!"
echo "    Worker:   $WORKER_URL"
echo "    MCP:      $WORKER_URL/mcp"
echo "    Health:   $WORKER_URL/health"
echo "    Sync:     POST $WORKER_URL/admin/sync"
echo "    Database: $DB_ID"
