#!/usr/bin/env bash
set -Eeuo pipefail

REPO_URL="${PICVAULT_REPO_URL:-https://github.com/vmenzo/image-bed.git}"
INSTALL_URL="${PICVAULT_INSTALL_URL:-https://raw.githubusercontent.com/vmenzo/image-bed/main/scripts/install.sh}"
INSTALL_DIR="${PICVAULT_INSTALL_DIR:-/opt/picvault}"
PICVAULT_PORT_INPUT="${PICVAULT_PORT:-}"
APP_HOST_PORT="${PICVAULT_PORT_INPUT:-7899}"
APP_PUBLIC_URL="${APP_PUBLIC_URL:-}"

log() {
  printf '[PicVault] %s\n' "$*"
}

fail() {
  printf '[PicVault] ERROR: %s\n' "$*" >&2
  exit 1
}

need_root() {
  if [ "$(id -u)" -ne 0 ]; then
    fail "please run as root, for example: curl -fsSL ${INSTALL_URL} | sudo bash"
  fi
}

has_cmd() {
  command -v "$1" >/dev/null 2>&1
}

install_base_packages() {
  if has_cmd apt-get; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get install -y ca-certificates curl git openssl
    return
  fi

  if has_cmd dnf; then
    dnf install -y ca-certificates curl git openssl
    return
  fi

  if has_cmd yum; then
    yum install -y ca-certificates curl git openssl
    return
  fi

  fail "unsupported Linux distribution: install Docker, Git, Curl, and OpenSSL manually first"
}

install_docker() {
  if has_cmd docker; then
    return
  fi

  log "Docker not found, installing Docker Engine"
  install_base_packages
  curl -fsSL https://get.docker.com -o /tmp/picvault-get-docker.sh
  sh /tmp/picvault-get-docker.sh
}

ensure_docker_compose() {
  if docker compose version >/dev/null 2>&1; then
    return
  fi

  if has_cmd apt-get; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get install -y docker-compose-plugin
  fi

  docker compose version >/dev/null 2>&1 || fail "Docker Compose plugin is not available"
}

ensure_docker_running() {
  if has_cmd systemctl; then
    systemctl enable --now docker >/dev/null 2>&1 || true
  fi

  docker info >/dev/null 2>&1 || fail "Docker daemon is not running"
}

random_token() {
  openssl rand -hex 24
}

detect_public_url() {
  if [ -n "$APP_PUBLIC_URL" ]; then
    printf '%s' "$APP_PUBLIC_URL"
    return
  fi

  local host_ip
  host_ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  if [ -z "$host_ip" ]; then
    host_ip="127.0.0.1"
  fi

  printf 'http://%s:%s' "$host_ip" "$APP_HOST_PORT"
}

set_env() {
  local key="$1"
  local value="$2"
  local file="$3"
  local escaped
  escaped="$(printf '%s' "$value" | sed 's/[\/&]/\\&/g')"

  if grep -q "^${key}=" "$file"; then
    sed -i "s/^${key}=.*/${key}=${escaped}/" "$file"
  else
    printf '%s=%s\n' "$key" "$value" >> "$file"
  fi
}

set_env_if_missing() {
  local key="$1"
  local value="$2"
  local file="$3"

  if ! grep -q "^${key}=" "$file"; then
    printf '%s=%s\n' "$key" "$value" >> "$file"
  fi
}

sync_source() {
  if [ -d "$INSTALL_DIR/.git" ]; then
    log "Updating existing installation at ${INSTALL_DIR}"
    git -C "$INSTALL_DIR" pull --ff-only
    return
  fi

  if [ -d "$INSTALL_DIR" ] && [ -n "$(ls -A "$INSTALL_DIR" 2>/dev/null)" ]; then
    fail "${INSTALL_DIR} already exists and is not empty"
  fi

  log "Cloning PicVault to ${INSTALL_DIR}"
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
}

prepare_env() {
  local env_file="${INSTALL_DIR}/.env"
  local public_url

  if [ ! -f "$env_file" ]; then
    public_url="$(detect_public_url)"
    log "Creating production .env"
    cp "${INSTALL_DIR}/.env.production.example" "$env_file"
    set_env POSTGRES_PASSWORD "$(random_token)" "$env_file"
    set_env APP_PUBLIC_URL "$public_url" "$env_file"
    set_env APP_HOST_PORT "$APP_HOST_PORT" "$env_file"
    set_env ALLOW_REGISTER "true" "$env_file"
    set_env VITE_ALLOW_REGISTER "true" "$env_file"
  else
    log "Using existing .env"
    if [ -n "$PICVAULT_PORT_INPUT" ]; then
      set_env APP_HOST_PORT "$APP_HOST_PORT" "$env_file"
    else
      set_env_if_missing APP_HOST_PORT "$APP_HOST_PORT" "$env_file"
      APP_HOST_PORT="$(
        grep '^APP_HOST_PORT=' "$env_file" | tail -n 1 | cut -d '=' -f 2-
      )"
      APP_HOST_PORT="${APP_HOST_PORT:-7899}"
    fi

    if [ -n "$APP_PUBLIC_URL" ]; then
      set_env APP_PUBLIC_URL "$APP_PUBLIC_URL" "$env_file"
    fi
  fi
}

start_stack() {
  cd "$INSTALL_DIR"
  log "Starting Docker Compose stack"
  docker compose up -d --build
}

wait_for_app() {
  local url="http://127.0.0.1:${APP_HOST_PORT}/healthz"
  local attempt

  log "Waiting for ${url}"
  for attempt in $(seq 1 60); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return
    fi
    sleep 2
  done

  docker compose ps || true
  docker compose logs --tail=120 frontend backend || true
  fail "PicVault did not become healthy in time"
}

main() {
  need_root
  install_base_packages
  install_docker
  ensure_docker_compose
  ensure_docker_running
  sync_source
  prepare_env
  start_stack
  wait_for_app

  log "Installed successfully"
  log "URL: $(detect_public_url)"
  log "Directory: ${INSTALL_DIR}"
  log "The first registered user becomes the admin account."
}

main "$@"
