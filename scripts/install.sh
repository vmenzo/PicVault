#!/usr/bin/env bash
# PicVault one-click installer (Debian 13 / Docker Compose).
# Usage: curl -fsSL https://raw.githubusercontent.com/vmenzo/PicVault/main/scripts/install.sh | sudo bash
# Env overrides: PICVAULT_PORT, APP_PUBLIC_URL, APP_BIND_ADDRESS (default
# 127.0.0.1), PICVAULT_INSTALL_DIR (default /opt/picvault),
# PICVAULT_REPO_URL, PICVAULT_GIT_RESET=1 (discard local changes on update).
set -Eeuo pipefail

REPO_URL="${PICVAULT_REPO_URL:-https://github.com/vmenzo/PicVault.git}"
INSTALL_URL="${PICVAULT_INSTALL_URL:-https://raw.githubusercontent.com/vmenzo/PicVault/main/scripts/install.sh}"
INSTALL_DIR="${PICVAULT_INSTALL_DIR:-/opt/picvault}"
PICVAULT_PORT_INPUT="${PICVAULT_PORT:-}"
APP_HOST_PORT="${PICVAULT_PORT_INPUT:-7899}"
APP_BIND_ADDRESS_EXPLICIT="${APP_BIND_ADDRESS:-}"
APP_BIND_ADDRESS="${APP_BIND_ADDRESS:-127.0.0.1}"
APP_PUBLIC_URL="${APP_PUBLIC_URL:-}"

# get.docker.com publishes no checksum or signature, so the download can
# only be sanity-checked, not cryptographically verified. The installer
# checks the script looks like the Docker installer before running it and
# always removes the temp file (see the EXIT trap in install_docker).
GET_DOCKER_URL="https://get.docker.com"
GET_DOCKER_TMP=""
MIN_FREE_DISK_KB=$((2 * 1024 * 1024)) # 2 GiB
PLACEHOLDER_PASSWORDS="change-this-postgres-password change-me changeme password postgres picvault"

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

# ---------------------------------------------------------------------------
# Preflight checks (run before anything is installed or changed)
# ---------------------------------------------------------------------------

validate_port() {
  case "$APP_HOST_PORT" in
    '' | *[!0-9]*)
      fail "PICVAULT_PORT / APP_HOST_PORT '${APP_HOST_PORT}' is not a number (use 1-65535, e.g. PICVAULT_PORT=7899)"
      ;;
  esac
  if [ "$APP_HOST_PORT" -lt 1 ] || [ "$APP_HOST_PORT" -gt 65535 ]; then
    fail "port ${APP_HOST_PORT} is out of range (1-65535)"
  fi
  if [ "$APP_HOST_PORT" -lt 1024 ]; then
    log "WARNING: port ${APP_HOST_PORT} is privileged (<1024); the install still works, but a reverse proxy on 80/443 is the usual setup"
  fi
}

validate_bind_address() {
  case "$APP_BIND_ADDRESS" in
    127.0.0.1 | 0.0.0.0 | localhost) return ;;
  esac
  if ! printf '%s' "$APP_BIND_ADDRESS" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; then
    fail "APP_BIND_ADDRESS '${APP_BIND_ADDRESS}' is not an IPv4 address (use 127.0.0.1, 0.0.0.0, or a local interface IP)"
  fi
  if ! ip -4 addr show 2>/dev/null | grep -qw "$APP_BIND_ADDRESS"; then
    log "WARNING: APP_BIND_ADDRESS ${APP_BIND_ADDRESS} is not assigned to any local interface; the frontend port will fail to bind. Use 127.0.0.1 or an address from 'ip -4 addr show'."
  fi
}

validate_public_url() {
  [ -z "$APP_PUBLIC_URL" ] && return
  case "$APP_PUBLIC_URL" in
    http://* | https://*) ;;
    *) fail "APP_PUBLIC_URL '${APP_PUBLIC_URL}' must start with http:// or https:// (e.g. APP_PUBLIC_URL=https://img.example.com)" ;;
  esac
  # Strip scheme, then require a host (optionally :port, optionally /path).
  local rest="${APP_PUBLIC_URL#*://}"
  local hostport="${rest%%/*}"
  local host="${hostport%%:*}"
  if [ -z "$host" ]; then
    fail "APP_PUBLIC_URL '${APP_PUBLIC_URL}' has no host"
  fi
  case "$host" in
    *[!A-Za-z0-9.-]*) fail "APP_PUBLIC_URL host '${host}' contains invalid characters" ;;
  esac
  if [ "$host" != "${hostport}" ]; then
    local url_port="${hostport##*:}"
    case "$url_port" in
      '' | *[!0-9]* | 0) fail "APP_PUBLIC_URL port '${url_port}' is not valid" ;;
    esac
  fi
  case "$APP_PUBLIC_URL" in
    https://*) log "APP_PUBLIC_URL is https: ENABLE_HSTS and TRUST_PROXY_HEADERS will be enabled" ;;
  esac
}

check_port_free() {
  if has_cmd ss; then
    if ss -tlnH 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]${APP_HOST_PORT}$"; then
      fail "port ${APP_HOST_PORT} is already in use on this host (check 'ss -tlnp | grep ${APP_HOST_PORT}'). Set PICVAULT_PORT to a free port, e.g. PICVAULT_PORT=7900"
    fi
  elif has_cmd netstat; then
    if netstat -tln 2>/dev/null | grep -Eq "[:.]${APP_HOST_PORT}[[:space:]]"; then
      fail "port ${APP_HOST_PORT} is already in use on this host. Set PICVAULT_PORT to a free port, e.g. PICVAULT_PORT=7900"
    fi
  else
    # Fallback: try to connect; a successful connect means something listens.
    if (exec 3<>"/dev/tcp/127.0.0.1/${APP_HOST_PORT}") 2>/dev/null; then
      fail "port ${APP_HOST_PORT} is already in use on this host. Set PICVAULT_PORT to a free port, e.g. PICVAULT_PORT=7900"
    fi
  fi
}

check_disk_space() {
  local dir="${INSTALL_DIR}"
  while [ ! -d "$dir" ]; do dir="$(dirname "$dir")"; done
  local free_kb
  free_kb="$(df -k --output=avail "$dir" 2>/dev/null | tail -n 1 | tr -d ' ')"
  if [ -n "$free_kb" ] && [ "$free_kb" -lt "$MIN_FREE_DISK_KB" ]; then
    fail "only $((free_kb / 1024)) MiB free under ${dir}; PicVault needs at least 2 GiB free (images, database and Docker layers). Free disk space and retry."
  fi
}

check_docker_versions() {
  if ! has_cmd docker; then
    return # install_docker() handles the missing case below
  fi
  local version
  version="$(docker version --format '{{.Server.Version}}' 2>/dev/null || true)"
  if [ -n "$version" ]; then
    local major="${version%%.*}"
    if [ "$major" -lt 24 ] 2>/dev/null; then
      fail "Docker ${version} is too old; PicVault needs Docker Engine >= 24. Upgrade Docker (https://docs.docker.com/engine/install/debian/) and retry."
    fi
  fi
  if ! docker compose version >/dev/null 2>&1; then
    log "Docker Compose v2 plugin not found; ensure_docker_compose will install it"
  fi
}

check_existing_containers() {
  if ! has_cmd docker || ! docker info >/dev/null 2>&1; then
    return
  fi
  local existing
  existing="$(docker ps -a --format '{{.Names}}' --filter 'name=picvault-' 2>/dev/null || true)"
  if [ -n "$existing" ]; then
    log "WARNING: existing PicVault containers found:"
    printf '%s\n' "$existing" | while read -r name; do log "  - ${name}"; done
    log "The installer will reuse/recreate them via 'docker compose up'. If they belong to a different install directory, stop and remove them first ('docker compose -p <project> down' or 'docker rm -f <name>')."
  fi
}

# Reject placeholder / weak Postgres passwords in an EXISTING .env too, not
# just on fresh installs: a re-run must never silently keep a known value.
check_env_password() {
  local env_file="${INSTALL_DIR}/.env"
  [ -f "$env_file" ] || return
  local password
  password="$(grep '^POSTGRES_PASSWORD=' "$env_file" | tail -n 1 | cut -d '=' -f 2-)"
  [ -n "$password" ] || fail "${env_file} has an empty POSTGRES_PASSWORD; set a random one (openssl rand -hex 24) and retry"
  local placeholder
  for placeholder in $PLACEHOLDER_PASSWORDS; do
    if [ "$password" = "$placeholder" ]; then
      fail "${env_file} still uses the placeholder POSTGRES_PASSWORD '${placeholder}'. Replace it with a generated password (openssl rand -hex 24), update the database if one already exists, and retry."
    fi
  done
  if [ "${#password}" -lt 16 ]; then
    fail "${env_file} POSTGRES_PASSWORD is only ${#password} characters; use at least 16 random characters (openssl rand -hex 24) and retry"
  fi
}

preflight() {
  validate_port
  validate_bind_address
  validate_public_url
  check_port_free
  check_disk_space
  check_docker_versions
  check_existing_containers
  check_env_password
}

# ---------------------------------------------------------------------------
# Dependencies
# ---------------------------------------------------------------------------

install_base_packages() {
  if has_cmd apt-get; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get install -y ca-certificates curl git openssl iproute2
    return
  fi

  if has_cmd dnf; then
    dnf install -y ca-certificates curl git openssl iproute
    return
  fi

  if has_cmd yum; then
    yum install -y ca-certificates curl git openssl iproute
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
  GET_DOCKER_TMP="$(mktemp /tmp/picvault-get-docker.XXXXXX.sh)"
  trap 'rm -f "$GET_DOCKER_TMP"' EXIT
  curl -fsSL "$GET_DOCKER_URL" -o "$GET_DOCKER_TMP"
  # get.docker.com publishes no checksum/signature, so verify the download
  # is plausibly the installer before executing it, and never leave it
  # behind (the EXIT trap above removes it even on failure).
  if [ ! -s "$GET_DOCKER_TMP" ] \
    || ! head -n 1 "$GET_DOCKER_TMP" | grep -q '^#!.*sh' \
    || ! grep -q 'docker' "$GET_DOCKER_TMP"; then
    fail "downloaded Docker installer from ${GET_DOCKER_URL} failed the sanity check (empty or not a shell script); refusing to run it. Install Docker manually: https://docs.docker.com/engine/install/debian/"
  fi
  sh "$GET_DOCKER_TMP"
  rm -f "$GET_DOCKER_TMP"
  GET_DOCKER_TMP=""
}

ensure_docker_compose() {
  if docker compose version >/dev/null 2>&1; then
    return
  fi

  # NOTE: docker-compose-plugin is NOT in Debian's official repositories;
  # it only exists in Docker's own apt repo. Try apt first (works when the
  # Docker repo is configured), then fall back to the official release
  # binary from GitHub.
  if has_cmd apt-get; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get install -y docker-compose-plugin 2>/dev/null || true
    if docker compose version >/dev/null 2>&1; then
      return
    fi
  fi

  log "Installing Docker Compose v2 plugin from the official GitHub release"
  local arch
  arch="$(uname -m)"
  case "$arch" in
    x86_64) arch="x86_64" ;;
    aarch64 | arm64) arch="aarch64" ;;
    *) fail "unsupported CPU architecture '${arch}' for the Compose plugin download; install Docker Compose v2 manually: https://docs.docker.com/compose/install/" ;;
  esac
  local compose_version
  compose_version="$(curl -fsSL https://api.github.com/repos/docker/compose/releases/latest 2>/dev/null | grep -m 1 '"tag_name"' | sed 's/.*"tag_name": *"\([^"]*\)".*/\1/')"
  if [ -z "$compose_version" ]; then
    compose_version="v2.29.7" # last-known-good fallback if the API is unreachable
    log "Could not query the latest Compose release; falling back to ${compose_version}"
  fi
  mkdir -p /usr/local/lib/docker/cli-plugins
  curl -fsSL "https://github.com/docker/compose/releases/download/${compose_version}/docker-compose-linux-${arch}" \
    -o /usr/local/lib/docker/cli-plugins/docker-compose
  chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

  docker compose version >/dev/null 2>&1 || fail "Docker Compose plugin is not available after install; install it manually: https://docs.docker.com/compose/install/"
}

ensure_docker_running() {
  if has_cmd systemctl; then
    systemctl enable --now docker >/dev/null 2>&1 || true
  fi

  docker info >/dev/null 2>&1 || fail "Docker daemon is not running (tried 'systemctl enable --now docker'). Start it with 'systemctl start docker' and check 'journalctl -u docker' for errors."
}

random_token() {
  openssl rand -hex 24
}

# Pick the first public (non-private, non-loopback, non-link-local) IPv4
# address; hostname -I's first address is often a Docker bridge (172.17.x)
# or a private LAN address, which is useless as a public URL.
detect_public_url() {
  if [ -n "$APP_PUBLIC_URL" ]; then
    printf '%s' "$APP_PUBLIC_URL"
    return
  fi

  local ip
  for ip in $(hostname -I 2>/dev/null); do
    case "$ip" in
      127.* | 10.* | 192.168.* | 169.254.*) continue ;;
      172.1[6-9].* | 172.2[0-9].* | 172.3[0-1].*) continue ;;
      *) printf 'http://%s:%s' "$ip" "$APP_HOST_PORT"; return ;;
    esac
  done

  # No public IP (e.g. behind NAT with only private addresses): use the
  # first private address rather than a Docker bridge address, if any.
  local first
  first="$(hostname -I 2>/dev/null | awk '{print $1}')"
  if [ -n "$first" ]; then
    printf 'http://%s:%s' "$first" "$APP_HOST_PORT"
    return
  fi

  printf 'http://127.0.0.1:%s' "$APP_HOST_PORT"
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

# When the public URL is https://, the app must send HSTS and trust the
# reverse proxy's X-Forwarded-* headers, or browsers/proxies misbehave.
# Only fills in missing keys (or keys still at the insecure default on a
# fresh file) so an explicit operator choice of "false" is respected.
apply_https_defaults() {
  local env_file="$1"
  local public_url="$2"
  case "$public_url" in
    https://*)
      set_env_if_missing ENABLE_HSTS "true" "$env_file"
      set_env_if_missing TRUST_PROXY_HEADERS "true" "$env_file"
      ;;
  esac
}

sync_source() {
  if [ -d "$INSTALL_DIR/.git" ]; then
    log "Updating existing installation at ${INSTALL_DIR}"
    if [ -n "$(git -C "$INSTALL_DIR" status --porcelain 2>/dev/null)" ]; then
      if [ "${PICVAULT_GIT_RESET:-}" = "1" ]; then
        log "WARNING: PICVAULT_GIT_RESET=1 — discarding local changes in ${INSTALL_DIR}"
        git -C "$INSTALL_DIR" fetch origin
        git -C "$INSTALL_DIR" reset --hard "origin/$(git -C "$INSTALL_DIR" rev-parse --abbrev-ref HEAD)"
      else
        fail "${INSTALL_DIR} has local changes (see 'git -C ${INSTALL_DIR} status'). Commit or stash them, or re-run with PICVAULT_GIT_RESET=1 to discard them. Refusing to run 'git pull' over a dirty tree."
      fi
    else
      git -C "$INSTALL_DIR" pull --ff-only || fail "git pull --ff-only failed (diverged history?). Inspect with 'git -C ${INSTALL_DIR} status' and resolve manually, or re-run with PICVAULT_GIT_RESET=1."
    fi
    return
  fi

  if [ -d "$INSTALL_DIR" ] && [ -n "$(ls -A "$INSTALL_DIR" 2>/dev/null)" ]; then
    fail "${INSTALL_DIR} already exists and is not empty (and is not a git checkout). Move it aside or set PICVAULT_INSTALL_DIR to another path."
  fi

  log "Cloning PicVault to ${INSTALL_DIR}"
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
  chmod 700 "$INSTALL_DIR"
}

prepare_env() {
  local env_file="${INSTALL_DIR}/.env"
  local public_url

  mkdir -p "$INSTALL_DIR"
  chmod 700 "$INSTALL_DIR"

  if [ ! -f "$env_file" ]; then
    public_url="$(detect_public_url)"
    log "Creating production .env"
    cp "${INSTALL_DIR}/.env.production.example" "$env_file"
    chmod 600 "$env_file"
    set_env POSTGRES_PASSWORD "$(random_token)" "$env_file"
    set_env APP_PUBLIC_URL "$public_url" "$env_file"
    set_env APP_HOST_PORT "$APP_HOST_PORT" "$env_file"
    set_env APP_BIND_ADDRESS "$APP_BIND_ADDRESS" "$env_file"
    set_env ALLOW_REGISTER "false" "$env_file"
    set_env VITE_ALLOW_REGISTER "false" "$env_file"
    set_env TRUST_PROXY_HEADERS "false" "$env_file"
    apply_https_defaults "$env_file" "$public_url"
    chmod 600 "$env_file"
  else
    log "Using existing .env"
    chmod 600 "$env_file"
    check_env_password
    if [ -n "$PICVAULT_PORT_INPUT" ]; then
      set_env APP_HOST_PORT "$APP_HOST_PORT" "$env_file"
    else
      set_env_if_missing APP_HOST_PORT "$APP_HOST_PORT" "$env_file"
      APP_HOST_PORT="$(
        grep '^APP_HOST_PORT=' "$env_file" | tail -n 1 | cut -d '=' -f 2-
      )"
      APP_HOST_PORT="${APP_HOST_PORT:-7899}"
    fi

    if [ -n "$APP_BIND_ADDRESS_EXPLICIT" ]; then
      # Only override the stored bind address when explicitly requested.
      set_env APP_BIND_ADDRESS "$APP_BIND_ADDRESS" "$env_file"
    else
      set_env_if_missing APP_BIND_ADDRESS "127.0.0.1" "$env_file"
    fi

    if [ -n "$APP_PUBLIC_URL" ]; then
      set_env APP_PUBLIC_URL "$APP_PUBLIC_URL" "$env_file"
      apply_https_defaults "$env_file" "$APP_PUBLIC_URL"
    else
      local stored_url
      stored_url="$(grep '^APP_PUBLIC_URL=' "$env_file" | tail -n 1 | cut -d '=' -f 2-)"
      apply_https_defaults "$env_file" "$stored_url"
    fi
    chmod 600 "$env_file"
  fi
}

start_stack() {
  cd "$INSTALL_DIR"
  log "Starting Docker Compose stack"
  docker compose up -d --build
}

# Probe the address the frontend is actually bound to (0.0.0.0 means
# "all interfaces", so probe loopback) and require a REAL API answer, not
# just a static /healthz: /api/system/ping is proxied to the backend, so
# it proves frontend + backend + database path are up.
wait_for_app() {
  local bind_host="$APP_BIND_ADDRESS"
  [ "$bind_host" = "0.0.0.0" ] && bind_host="127.0.0.1"
  local health_url="http://${bind_host}:${APP_HOST_PORT}/healthz"
  local api_url="http://${bind_host}:${APP_HOST_PORT}/api/system/ping"
  local attempt

  log "Waiting for ${health_url} and ${api_url}"
  for attempt in $(seq 1 60); do
    if curl -fsS "$health_url" >/dev/null 2>&1 \
      && curl -fsS "$api_url" | grep -q '"status":"ok"'; then
      log "PicVault is up: ${health_url}"
      return
    fi
    sleep 2
  done

  docker compose ps || true
  docker compose logs --tail=120 frontend backend || true
  fail "PicVault did not become healthy in time (checked ${health_url} and ${api_url}). See the logs above; common causes: the backend is still migrating, Postgres/Redis are unhealthy, or port ${APP_HOST_PORT} is blocked."
}

main() {
  need_root
  preflight
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
  log "Directory: ${INSTALL_DIR} (permissions 700, .env is 600)"
  log "By default the app only listens on 127.0.0.1 — put nginx/Caddy in front of it (see ops/nginx.conf, ops/Caddyfile) for public HTTPS access."
  log "The first registered user becomes the admin account."
}

main "$@"
