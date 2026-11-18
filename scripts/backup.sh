#!/usr/bin/env bash
# PicVault host backup: Postgres dump + local-storage archive + .env copy.
#
# Backup-path rule (this is the canonical host/container mapping):
#   * PICVAULT_BACKUP_DIR in .env is the path AS SEEN INSIDE the backend
#     container (default /app/backups, which compose mounts from
#     <install-dir>/backups). The backend's in-app maintenance view uses
#     that container path.
#   * This host script resolves the HOST path instead: the legacy container
#     value /app/backups (or anything under /app/) maps to
#     <install-dir>/backups, and any other value is used as-is (relative
#     values resolve against the install dir).
#   * Override the host location directly with PICVAULT_BACKUP_DIR_HOST.
# Redis is intentionally NOT backed up: it only holds the ephemeral
# BullMQ queue and rate-limit counters, which are rebuilt on restart.
# Retention: backup directories older than 14 days are deleted.
set -euo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# --- load .env (dotenv-style, no shell eval) so pg_dump uses the real
# credentials instead of shell-environment defaults -----------------------
if [ -f "${ROOT_DIR}/.env" ]; then
  while IFS='=' read -r key value || [ -n "$key" ]; do
    case "$key" in
      '' | '#'*) continue ;;
      POSTGRES_USER | POSTGRES_DB | POSTGRES_PASSWORD | PICVAULT_BACKUP_DIR)
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
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-}"

# --- resolve the HOST backup directory ------------------------------------
if [ -n "${PICVAULT_BACKUP_DIR_HOST:-}" ]; then
  BACKUP_DIR="${PICVAULT_BACKUP_DIR_HOST}"
elif [ -n "${PICVAULT_BACKUP_DIR:-}" ]; then
  case "${PICVAULT_BACKUP_DIR}" in
    /app/backups | /app/*)
      echo "NOTE: PICVAULT_BACKUP_DIR='${PICVAULT_BACKUP_DIR}' is the in-container path; using host directory ${ROOT_DIR}/backups" >&2
      BACKUP_DIR="${ROOT_DIR}/backups"
      ;;
    /*) BACKUP_DIR="${PICVAULT_BACKUP_DIR}" ;;
    *)  BACKUP_DIR="${ROOT_DIR}/${PICVAULT_BACKUP_DIR}" ;;
  esac
else
  BACKUP_DIR="${ROOT_DIR}/backups"
fi

COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-$(basename "${ROOT_DIR}")}"
STORAGE_VOLUME="${PICVAULT_STORAGE_VOLUME:-${COMPOSE_PROJECT_NAME}_backend_storage}"
STAMP="$(date +%Y%m%d-%H%M%S)"
DEST="${BACKUP_DIR}/${STAMP}"

mkdir -p "${DEST}"
chmod 700 "${BACKUP_DIR}" "${DEST}"
cd "${ROOT_DIR}"

# Postgres dump. The password comes from .env above (exported only for
# this process); pg_dump itself runs inside the container, so no password
# is passed on the host command line.
if [ -z "${POSTGRES_PASSWORD}" ]; then
  echo "ERROR: POSTGRES_PASSWORD is not set in ${ROOT_DIR}/.env; refusing to back up with a default credential." >&2
  exit 1
fi
docker compose exec -T postgres pg_dump -U "${POSTGRES_USER}" "${POSTGRES_DB}" > "${DEST}/postgres.sql"
if [ ! -s "${DEST}/postgres.sql" ]; then
  echo "ERROR: pg_dump produced an empty ${DEST}/postgres.sql; backup aborted." >&2
  exit 1
fi

# Local storage (named volume, or the dev fallback directory).
if docker volume inspect "${STORAGE_VOLUME}" >/dev/null 2>&1; then
  docker run --rm -v "${STORAGE_VOLUME}:/data" -v "${DEST}:/backup" alpine:3.20 sh -c 'tar -C /data -czf /backup/local-storage.tar.gz .'
elif [ -d "${ROOT_DIR}/backend/storage" ]; then
  tar -C "${ROOT_DIR}/backend" -czf "${DEST}/local-storage.tar.gz" storage
fi

# --- .env copy -------------------------------------------------------------
# WARNING: this is a PLAINTEXT copy of your production secrets (database
# password, SMTP credentials, S3 keys). It is stored with mode 600 inside
# the 700 backup directory, and it is required for a full restore — but
# treat the backup directory like a secret: do not upload it to untrusted
# storage or share it. If you need encrypted off-site copies, encrypt the
# backup directory afterwards, e.g.:
#   tar -czf - <backup-dir> | openssl enc -aes-256-cbc -salt -pbkdf2 -out backup.tar.gz.enc
# and keep the passphrase separate from the backup.
if [ -f "${ROOT_DIR}/.env" ]; then
  cp "${ROOT_DIR}/.env" "${DEST}/.env"
  chmod 600 "${DEST}/.env"
  echo "WARNING: backup includes a plaintext copy of .env (mode 600) — keep this backup private." >&2
fi

sha256sum "${DEST}"/* > "${DEST}/SHA256SUMS"
cat > "${DEST}/manifest.json" <<JSON
{
  "createdAt": "$(date -Is)",
  "path": "${DEST}",
  "postgresSqlBytes": $(wc -c < "${DEST}/postgres.sql"),
  "localStorageArchive": $([ -f "${DEST}/local-storage.tar.gz" ] && echo '"local-storage.tar.gz"' || echo "null"),
  "envIncluded": $([ -f "${DEST}/.env" ] && echo "true" || echo "false"),
  "redisBackedUp": false,
  "redisNote": "Redis holds only the ephemeral job queue and rate-limit counters and is intentionally not backed up.",
  "retentionDays": 14
}
JSON
chmod 600 "${DEST}/manifest.json" "${DEST}/SHA256SUMS"

find "${BACKUP_DIR}" -mindepth 1 -maxdepth 1 -type d -mtime +14 -exec rm -rf {} +

echo "Backup written to ${DEST}"
