#!/usr/bin/env bash
# =============================================================================
# network_autonomous_daemon.sh (HARDENED + DNS-POLICY AWARE + VERIFIED)
# =============================================================================

set -euo pipefail

LOG_TAG="[AUTO-NET]"

# -----------------------------------------------------------------------------
# CONFIGURATION (ENV OVERRIDES SUPPORTED)
# -----------------------------------------------------------------------------

REPO_DIR="${REPO_DIR:-}"
FALLBACK_DNS="${FALLBACK_DNS:-1.1.1.1 8.8.8.8}"

STATE_DIR="/opt/network-integrity/state"
CONFIG_FILE="${STATE_DIR}/portable_config.env"
KNOWN_GOOD_FILE="${STATE_DIR}/known_good.env"
LOG_FILE="${STATE_DIR}/autonomous.log"

GIT_REPO_URL="https://github.com/swipswaps/bcm4331-forensic-controller.git"
BRANCH="master"

SLEEP_INTERVAL=15

mkdir -p "${STATE_DIR}"

# -----------------------------------------------------------------------------
# LOGGING
# -----------------------------------------------------------------------------

log() {
  echo "$(date -Iseconds) $LOG_TAG $1" | tee -a "$LOG_FILE"
}

fail_hard() {
  log "[FATAL] $1"
  exit 1
}

fail_soft() {
  log "[WARN] $1"
}

# -----------------------------------------------------------------------------
# REPO DETECTION
# -----------------------------------------------------------------------------

detect_repo() {
  log "Detecting repository path"

  if [[ -n "${REPO_DIR}" && -d "${REPO_DIR}/.git" ]]; then
    log "Using provided REPO_DIR: ${REPO_DIR}"
    return
  fi

  for path in \
    "$HOME/Broadcom-BCM4331-Deterministic-Network-Controller-Unified-v39.7-" \
    "$HOME"/*Deterministic* \
    "$HOME"/*bcm4331*; do

    if [[ -d "$path/.git" ]]; then
      REPO_DIR="$path"
      log "Auto-detected repo: $REPO_DIR"
      return
    fi
  done

  fail_hard "Unable to locate git repository"
}

enter_repo() {
  cd "$REPO_DIR" || fail_hard "Cannot cd into repo: $REPO_DIR"
}

# -----------------------------------------------------------------------------
# DNS INTELLIGENCE LAYER (NO HARD OVERRIDES)
# -----------------------------------------------------------------------------

get_current_dns() {
  nmcli dev show | awk '/IP4.DNS/ {print $2}' | sort -u || true
}

validate_dns() {
  getent hosts github.com >/dev/null 2>&1
}

repair_dns() {
  log "Attempting DNS repair (policy-aware, non-invasive)"

  ACTIVE_CON=$(nmcli -t -f NAME connection show --active | head -n1 || true)

  if [[ -z "$ACTIVE_CON" ]]; then
    fail_soft "No active connection detected"
    return
  fi

  CURRENT_DNS=$(get_current_dns)

  if [[ -n "$CURRENT_DNS" ]]; then
    log "Existing DNS detected → respecting system configuration"
    log "DNS in use: $CURRENT_DNS"
    return
  fi

  log "No DNS detected → applying fallback DNS (configurable)"

  nmcli con mod "$ACTIVE_CON" ipv4.dns "$FALLBACK_DNS" || true
  nmcli con mod "$ACTIVE_CON" ipv4.ignore-auto-dns yes || true
  nmcli con reload || true

  log "Fallback DNS applied: $FALLBACK_DNS"
  sudo systemctl restart NetworkManager || true
}

sanitize_proxy() {
  unset http_proxy https_proxy ALL_PROXY || true
  git config --global --unset http.proxy 2>/dev/null || true
}

# -----------------------------------------------------------------------------
# GIT OPERATIONS
# -----------------------------------------------------------------------------

validate_git() {
  enter_repo
  git ls-remote "$GIT_REPO_URL" >/dev/null 2>&1
}

check_for_updates() {
  enter_repo
  git fetch origin "$BRANCH" >/dev/null 2>&1 || return 1

  LOCAL=$(git rev-parse HEAD)
  REMOTE=$(git rev-parse "origin/$BRANCH")

  [[ "$LOCAL" != "$REMOTE" ]]
}

apply_update() {
  enter_repo

  log "Applying update"

  if git pull --rebase origin "$BRANCH"; then
    log "Update success"
    return 0
  else
    log "Update failed → rollback"
    git rebase --abort || true
    return 1
  fi
}

# -----------------------------------------------------------------------------
# CONFIG SNAPSHOT
# -----------------------------------------------------------------------------

capture_portable_config() {
  log "Capturing portable configuration"

  {
    echo "# --- DNS ---"
    get_current_dns

    echo "# --- ROUTE ---"
    ip route | grep default | awk '{print $3}' || true

    echo "# --- OS ---"
    uname -srm

    echo "# --- STACK ---"
    nmcli --version || true
    git --version || true
  } > "${CONFIG_FILE}.tmp"

  mv "${CONFIG_FILE}.tmp" "${CONFIG_FILE}"
}

save_known_good() {
  cp "$CONFIG_FILE" "$KNOWN_GOOD_FILE"
  log "Saved known-good config snapshot"
}

# -----------------------------------------------------------------------------
# MAIN LOOP
# -----------------------------------------------------------------------------

main_loop() {

  detect_repo

  while true; do
    log "----- LOOP START -----"

    sanitize_proxy

    if ! validate_dns; then
      fail_soft "DNS validation failed"
      repair_dns
    else
      log "DNS OK"
    fi

    if ! validate_git; then
      fail_soft "Git validation failed"
      sleep "$SLEEP_INTERVAL"
      continue
    else
      log "Git OK"
    fi

    capture_portable_config

    if check_for_updates; then
      log "Update available"

      if apply_update; then
        save_known_good
      else
        fail_soft "Update failed"
      fi
    else
      log "No updates"
    fi

    log "Sleeping ${SLEEP_INTERVAL}s"
    sleep "$SLEEP_INTERVAL"
  done
}

# -----------------------------------------------------------------------------
# ENTRY
# -----------------------------------------------------------------------------

main_loop