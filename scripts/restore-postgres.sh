#!/usr/bin/env bash
# Deprecated: use scripts/restore.sh instead.
# This wrapper only restores a raw postgres.sql dump (no storage, no .env,
# no verification). It is kept for backwards compatibility.
set -euo pipefail

if [ "${1:-}" = "" ]; then
  echo "Usage: $0 /path/to/postgres.sql" >&2
  echo "For a full restore (database + storage + .env, with verification), use:" >&2
  echo "  bash scripts/restore.sh /path/to/backup-dir" >&2
  exit 1
fi

echo "WARNING: scripts/restore-postgres.sh is deprecated and restores ONLY the database dump." >&2
echo "For a full restore with storage, .env and verification, use scripts/restore.sh instead." >&2

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "${ROOT_DIR}"
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 --single-transaction \
  -U "${POSTGRES_USER:-picvault}" -d "${POSTGRES_DB:-picvault}" < "$1"
