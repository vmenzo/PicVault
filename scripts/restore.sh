#!/usr/bin/env bash
# PicVault restore: restores one backup directory created by scripts/backup.sh.
#
#   bash scripts/restore.sh /opt/picvault/backups/20261119-033000
#   bash scripts/restore.sh --postgres-only /path/to/backup   # only the DB
#   bash scripts/restore.sh --yes /path/to/backup            # skip prompt
#
# What it does, in order:
#   1. Validates the backup dir (must contain postgres.sql; SHA256SUMS is
#      verified when present).
#   2. Stops the backend so nothing writes to the DB or storage mid-restore.
#   3. Drops + recreates the database (equivalent to --clean --if-exists,
#      but also removes extensions/objects a plain restore would leave
#      behind), then loads postgres.sql.
#   4. Restores local-storage.tar.gz into the backend_storage volume
#      (existing volume contents are removed first).
#   5. Restores .env when the backup has one (the current .env is saved
#      as .env.pre-restore-<stamp> first; the restored copy gets mode 600).
#   6. Restarts the backend and verifies GET /api/system/ping answers ok.
#
# Redis is not restored (see backup.sh): the queue and rate-limit data
# are ephemeral and rebuild on restart. Jobs that were queued at backup
# time are lost; already-processed images are unaffected.
# DANGER: this overwrites the live database and local storage. There is
# no undo except another backup — make one first (scripts/backup.sh).
set -euo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FORCE=0
POSTGRES_ONLY=0
BACKUP_DIR=""

usage() {
  echo "Usage: $0 [--yes] [--postgres-only] /path/to/backup-dir" >&2
  echo "  --yes            skip the confirmation prompt" >&2
  echo "  --postgres-only  restore only postgres.sql (skip storage and .env)" >&2
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --yes) FORCE=1; shift ;;
    --postgres-only) POSTGRES_ONLY=1; shift ;;
    -h | --help) usage ;;
    --*) echo "Unknown option: $1" >&2; usage ;;
    *) BACKUP_DIR="$1"; shift ;;
  esac
done

[ -n "$BACKUP_DIR" ] || usage
# Resolve to an absolute path (the backup may live outside the install dir).
BACKUP_DIR_INPUT="$BACKUP_DIR"
BACKUP_DIR="$(cd "$BACKUP_DIR" 2>/dev/null && pwd)" || {
  echo "ERROR: backup directory '${BACKUP_DIR_INPUT}' does not exist." >&2
  exit 1
}

# --- validation ------------------------------------------------------------
[ -d "$BACKUP_DIR" ] || { echo "ERROR: '${BACKUP_DIR}' is not a directory." >&2; exit 1; }
[ -f "${BACKUP_DIR}/postgres.sql" ] || { echo "ERROR: '${BACKUP_DIR}/postgres.sql' not found — not a PicVault backup directory." >&2; exit 1; }
[ -s "${BACKUP_DIR}/postgres.sql" ] || { echo "ERROR: '${BACKUP_DIR}/postgres.sql' is empty." >&2; exit 1; }
if [ -f "${BACKUP_DIR}/SHA256SUMS" ]; then
  (cd "$BACKUP_DIR" && sha256sum -c SHA256SUMS) || { echo "ERROR: checksum verification failed; refusing to restore a corrupt backup." >&2; exit 1; }
fi

# --- load .env (same dotenv parsing as backup.sh) --------------------------
if [ -f "${ROOT_DIR}/.env" ]; then
  while IFS='=' read -r key value || [ -n "$key" ]; do
    case "$key" in
      '' | '#'*) continue ;;
      POSTGRES_USER | POSTGRES_DB | POSTGRES_PASSWORD)
        value="${value%$'\r'}"
        value="${value#\"}"; value="${value%\"}"
        value="${value#\'}"; value="${value%\'}"
        export "$key=$value"
        ;;
    esac
  done < "${ROOT_DIR}/.env"
fi
POSTGRES_USER="${POSTGRES_USER:-picvault}"
POSTGRES_DB="${POSTGRES_DB:-picvault}"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-$(basename "${ROOT_DIR}")}"
STORAGE_VOLUME="${PICVAULT_STORAGE_VOLUME:-${COMPOSE_PROJECT_NAME}_backend_storage}"

cd "$ROOT_DIR"
docker compose ps >/dev/null 2>&1 || { echo "ERROR: 'docker compose' does not work in ${ROOT_DIR}; is Docker running and is this the install directory?" >&2; exit 1; }

echo "This will OVERWRITE the live '${POSTGRES_DB}' database"
[ "$POSTGRES_ONLY" -eq 1 ] || echo "and the contents of the '${STORAGE_VOLUME}' storage volume"
echo "from backup: ${BACKUP_DIR}"
if [ "$FORCE" -ne 1 ]; then
  printf 'Type RESTORE to continue: '
  read -r answer
  [ "$answer" = "RESTORE" ] || { echo "Aborted."; exit 1; }
fi

# --- stop the backend so nothing writes during the restore -----------------
echo "Stopping backend..."
docker compose stop backend

# --- database: drop + recreate, then load the dump -------------------------
# Dropping/recreating is stronger than psql --clean --if-exists (which
# leaves behind objects the dump does not mention); either way the dump
# itself is loaded with --single-transaction for atomicity.
echo "Recreating database ${POSTGRES_DB}..."
docker compose exec -T postgres psql -U "${POSTGRES_USER}" -d postgres -v ON_ERROR_STOP=1 -c \
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${POSTGRES_DB}' AND pid <> pg_backend_pid();"
docker compose exec -T postgres psql -U "${POSTGRES_USER}" -d postgres -v ON_ERROR_STOP=1 -c \
  "DROP DATABASE IF EXISTS \"${POSTGRES_DB}\";"
docker compose exec -T postgres psql -U "${POSTGRES_USER}" -d postgres -v ON_ERROR_STOP=1 -c \
  "CREATE DATABASE \"${POSTGRES_DB}\" OWNER \"${POSTGRES_USER}\";"
echo "Loading postgres.sql..."
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 --single-transaction \
  -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" < "${BACKUP_DIR}/postgres.sql"

# --- verify the database ----------------------------------------------------
TABLES="$(docker compose exec -T postgres psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" -tAc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';" | tr -d '[:space:]')"
echo "Restored database has ${TABLES} tables in schema public."
[ "${TABLES:-0}" -gt 0 ] || { echo "ERROR: restored database has no tables; restore failed." >&2; exit 1; }

# --- local storage ----------------------------------------------------------
if [ "$POSTGRES_ONLY" -eq 0 ]; then
  if [ -f "${BACKUP_DIR}/local-storage.tar.gz" ]; then
    if docker volume inspect "${STORAGE_VOLUME}" >/dev/null 2>&1; then
      echo "Restoring local-storage.tar.gz into volume ${STORAGE_VOLUME}..."
      docker run --rm -v "${STORAGE_VOLUME}:/data" -v "${BACKUP_DIR}:/backup:ro" alpine:3.20 sh -c \
        'rm -rf /data/* /data/.[!.]* /data/..?* 2>/dev/null; tar -C /data -xzf /backup/local-storage.tar.gz'
      echo "Storage volume now contains:"
      docker run --rm -v "${STORAGE_VOLUME}:/data" alpine:3.20 sh -c 'ls /data | head -5'
    else
      echo "WARNING: volume ${STORAGE_VOLUME} does not exist; extracting storage to ${ROOT_DIR}/backend/storage instead." >&2
      mkdir -p "${ROOT_DIR}/backend/storage"
      tar -C "${ROOT_DIR}/backend/storage" -xzf "${BACKUP_DIR}/local-storage.tar.gz"
    fi
  else
    echo "NOTE: no local-storage.tar.gz in this backup; storage left untouched."
  fi

  # --- .env -----------------------------------------------------------------
  if [ -f "${BACKUP_DIR}/.env" ]; then
    STAMP="$(date +%Y%m%d-%H%M%S)"
    if [ -f "${ROOT_DIR}/.env" ]; then
      cp "${ROOT_DIR}/.env" "${ROOT_DIR}/.env.pre-restore-${STAMP}"
      chmod 600 "${ROOT_DIR}/.env.pre-restore-${STAMP}"
      echo "Current .env saved as .env.pre-restore-${STAMP}"
    fi
    cp "${BACKUP_DIR}/.env" "${ROOT_DIR}/.env"
    chmod 600 "${ROOT_DIR}/.env"
    echo "Restored .env from backup (mode 600)."
  else
    echo "NOTE: no .env in this backup; current .env left untouched."
  fi
fi

# --- restart + verify --------------------------------------------------------
echo "Starting backend..."
docker compose up -d backend
echo "Waiting for the backend to answer /api/system/ping..."
for attempt in $(seq 1 30); do
  if docker compose exec -T backend node -e \
    "fetch('http://127.0.0.1:3000/api/system/ping').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
    echo "Restore complete and verified: backend answers /api/system/ping."
    exit 0
  fi
  sleep 2
done

echo "ERROR: backend did not become healthy after restore; check 'docker compose logs backend'." >&2
exit 1
