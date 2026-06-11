#!/usr/bin/env bash
# Read the local .env and apply it to Forge:
#   - export APP_ID so manifest.yml's ${APP_ID} resolves at deploy time
#   - push runtime variables (read via process.env in the resolver)
#
# Usage:
#   source scripts/forge-env.sh           # export APP_ID into the current shell
#   scripts/forge-env.sh --set-variables  # also run `forge variables set ...`
#
# The Forge CLI does not auto-load .env, so this is the bridge. Requires that
# you are authenticated (forge login, or FORGE_EMAIL/FORGE_API_TOKEN exported).

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/.env"

if [ ! -f "$ENV_FILE" ]; then
  echo "No .env found at $ENV_FILE — copy .env.example to .env and fill it in." >&2
  return 1 2>/dev/null || exit 1
fi

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

export APP_ID
echo "APP_ID exported (${APP_ID})."

if [ "${1:-}" = "--set-variables" ]; then
  echo "Pushing runtime variables to Forge…"
  forge variables set CYCLE_TIME_FILTER_ID "${CYCLE_TIME_FILTER_ID:-}"
  forge variables set WAIT_SLA_FIELD "${WAIT_SLA_FIELD:-}"
  forge variables set EXEC_SLA_FIELD "${EXEC_SLA_FIELD:-}"
  forge variables set REQUEST_TYPE_FIELD "${REQUEST_TYPE_FIELD:-}"
  if [ -n "${CYCLE_TIME_FALLBACK_JQL:-}" ]; then
    forge variables set CYCLE_TIME_FALLBACK_JQL "${CYCLE_TIME_FALLBACK_JQL}"
  fi
  echo "Done. Run 'forge deploy' for the variables to take effect."
fi
