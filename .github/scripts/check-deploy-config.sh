#!/usr/bin/env bash
set -euo pipefail

missing_secret=0
for secret_name in CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_API_TOKEN; do
  if [[ -z "${!secret_name:-}" ]]; then
    echo "::error title=Missing deployment secret::Add ${secret_name} in Settings > Secrets and variables > Actions > Repository secrets."
    missing_secret=1
  fi
done

if [[ "$missing_secret" == 1 ]]; then
  exit 1
fi

if [[ -n "${TELEGRAM_BOT_TOKEN:-}" && -n "${TELEGRAM_SECRET_TOKEN:-}" ]]; then
  echo "telegram_enabled=true" >> "$GITHUB_OUTPUT"
else
  echo "telegram_enabled=false" >> "$GITHUB_OUTPUT"
  echo "::notice title=Telegram setup skipped::To enable the optional bot, add both TELEGRAM_BOT_TOKEN and TELEGRAM_SECRET_TOKEN to Repository secrets."
fi
