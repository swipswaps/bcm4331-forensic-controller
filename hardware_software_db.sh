#!/usr/bin/env bash

# =============================================================================
# hardware_software_db.sh (STABLE + ZERO SHELL BREAKAGE)
# =============================================================================

# Enable strict mode ONLY when executed, never when sourced
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  set -euo pipefail
fi

# IMPORTANT:
# Do NOT use "set -u" globally in sourced scripts
# It breaks environments like SSH where variables may be unset

set -o pipefail

DB_FILE="config_db.jsonl"

# Safe DB initialization
if [[ ! -f "$DB_FILE" ]]; then
  touch "$DB_FILE" 2>/dev/null || {
    echo "[ERROR] Cannot create DB file"
    return 1 2>/dev/null || exit 1
  }
fi

# =============================================================================
# CORE FUNCTION
# =============================================================================
add_config_entry() {
  local type="${1:-}"
  local name="${2:-}"
  local json="${3:-}"

  if [[ -z "$type" || -z "$name" || -z "$json" ]]; then
    echo "[ERROR] add_config_entry requires: type, name, json"
    return 1
  fi

  local timestamp
  timestamp="$(date -Iseconds)"

  echo "{\"timestamp\":\"$timestamp\",\"type\":\"$type\",\"name\":\"$name\",\"data\":$json}" >> "$DB_FILE" || {
    echo "[ERROR] write failed"
    return 1
  }

  echo "[OK] Added -> $type / $name @ $timestamp"
}

# =============================================================================
# QUERY FUNCTIONS
# =============================================================================
get_configs_by_type() {
  local type="${1:-}"

  [[ -z "$type" ]] && { echo "[ERROR] type required"; return 1; }

  grep "\"type\":\"$type\"" "$DB_FILE" 2>/dev/null || true
}

get_latest_by_type() {
  local type="${1:-}"

  [[ -z "$type" ]] && { echo "[ERROR] type required"; return 1; }

  tac "$DB_FILE" 2>/dev/null | grep -m1 "\"type\":\"$type\"" || true
}

# =============================================================================
# EXPORT (fix: include correct function names)
# =============================================================================
export -f add_config_entry 2>/dev/null || true
export -f get_configs_by_type 2>/dev/null || true
export -f get_latest_by_type 2>/dev/null || true

# =============================================================================
# ENVIRONMENT SAFETY FIX
# =============================================================================
# Prevent SSH variable errors when strict environments reference it
# This avoids "unbound variable" crashes in some shells

: "${SSH_CONNECTION:=}"