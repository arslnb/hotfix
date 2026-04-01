#!/bin/zsh

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
BACKEND_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
ROOT_DIR=$(cd "$BACKEND_DIR/.." && pwd)
ENV_FILE="$ROOT_DIR/.env"

if [[ -z "${HOTFIX_DATABASE_URL:-}" && -f "$ENV_FILE" ]]; then
  set -a
  source "$ENV_FILE"
  set +a
fi

: "${HOTFIX_DATABASE_URL:?HOTFIX_DATABASE_URL is required. Export it or define it in $ENV_FILE.}"

for migration in "$BACKEND_DIR"/migrations/*.sql; do
  [[ -f "$migration" ]] || continue
  echo "Applying $(basename "$migration")"
  psql "$HOTFIX_DATABASE_URL" -v ON_ERROR_STOP=1 -f "$migration"
done

echo "Migrations applied successfully."
