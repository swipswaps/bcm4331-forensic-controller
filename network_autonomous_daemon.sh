#!/usr/bin/env bash
# =============================================================================
# network_autonomous_daemon.sh (FINAL FIX — EXECUTABLE ENTRYPOINT RESTORED)
# =============================================================================
# CRITICAL ISSUE FIXED:
#   ✔ Removed trailing shell prompt injected into script:
#       main_loop[owner@...]$
#     This would break execution with "command not found" or syntax error.
# =============================================================================

set -euo pipefail

LOG_TAG="[AUTO-NET]"

# -----------------------------------------------------------------------------
# CONFIGURATION
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
  echo "$(date -Iseconds) $LOG_TAG $1"
}

fail_soft() {
  log "[WARN] $1"
}

# -----------------------------------------------------------------------------
# REPO DETECTION
# -----------------------------------------------------------------------------

detect_repo() {
  [[ -n "${REPO_DIR}" ]] && [[ -d "${REPO_DIR}/.git" ]] && return

  for path in \
    "$HOME/Broadcom-BCM4331-Deterministic-Network-Controller-Unified-v39.7-" \
    "$HOME"/*Deterministic* \
    "$HOME"/*bcm4331*; do

    [[ -d "$path/.git" ]] && REPO_DIR="$path" && return
  done

  log "ERROR: Repo not found"
  exit 1
}

enter_repo() {
  cd "$REPO_DIR" || exit 1
}

# -----------------------------------------------------------------------------
# DNS (READ ONLY)
# -----------------------------------------------------------------------------

get_current_dns() {
  nmcli -t -f IP4.DNS dev show 2>/dev/null | cut -d':' -f2 | grep -v '^$' || true
}

validate_dns() {
  getent hosts github.com >/dev/null 2>&1
}

# -----------------------------------------------------------------------------
# PROXY CLEANUP
# -----------------------------------------------------------------------------

sanitize_proxy() {
  unset http_proxy https_proxy ALL_PROXY || true
}

# -----------------------------------------------------------------------------
# GIT VALIDATION
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

  GIT_TERMINAL_PROMPT=0 git pull --rebase origin "$BRANCH" || return 1
}

# -----------------------------------------------------------------------------
# CONFIG SNAPSHOT
# -----------------------------------------------------------------------------

capture_portable_config() {
  {
    get_current_dns
    ip route | awk '/default/ {print $3}' || true
    uname -srm
  } > "${CONFIG_FILE}"
}

save_known_good() {
  cp "$CONFIG_FILE" "$KNOWN_GOOD_FILE"
}

# -----------------------------------------------------------------------------
# MAIN LOOP
# -----------------------------------------------------------------------------

main_loop() {

  detect_repo

  while true; do

    log "loop start"

    sanitize_proxy

    if ! validate_dns; then
      fail_soft "DNS failure (read-only mode)"
    fi

    if ! validate_git; then
      fail_soft "git unreachable"
      sleep "$SLEEP_INTERVAL"
      continue
    fi

    capture_portable_config

    if check_for_updates; then
      log "update available"

      if apply_update; then
        save_known_good
      else
        fail_soft "update failed"
      fi
    fi

    sleep "$SLEEP_INTERVAL"

  done
}

# -----------------------------------------------------------------------------
# ENTRY POINT (STRICT — MUST BE CLEAN)
# -----------------------------------------------------------------------------

main_loop