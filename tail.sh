#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${1:-.env}"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "Error: $ENV_FILE not found."
  exit 1
fi

# shellcheck disable=SC1090
source "$ENV_FILE"

export CLOUDFLARE_API_TOKEN
export CLOUDFLARE_ACCOUNT_ID

npx wrangler tail --format json
