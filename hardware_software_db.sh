# FILE: hardware_software_db.sh
# =============================================================================
# PURPOSE:
#   Persist multiple known configurations (hardware + software) directly inside
#   the Git repository, replacing the single "known_good" concept with a
#   versioned, queryable configuration database.
#
# DESIGN:
#   - JSONL (one JSON object per line) for append-only history
#   - Safe for git tracking
#   - Works without external DB dependencies
# =============================================================================

set -euo pipefail

DB_FILE="${REPO_DIR:-$PWD}/config_db.jsonl"

# Ensure DB file exists
touch "$DB_FILE"

# -----------------------------------------------------------------------------
# Add a new configuration entry
# -----------------------------------------------------------------------------
add_config_entry() {
  local type="$1"         # "hardware" or "software"
  local label="$2"        # human-readable label
  local payload="$3"      # JSON string payload

  # Append a JSON object (one per line)
  # This ensures Git diffs remain readable and mergeable
  echo "{\"timestamp\":\"$(date -Iseconds)\",\"type\":\"$type\",\"label\":\"$label\",\"data\":$payload}" >> "$DB_FILE"
}

# -----------------------------------------------------------------------------
# Query entries by type
# -----------------------------------------------------------------------------
get_configs_by_type() {
  local type="$1"

  grep "\"type\":\"$type\"" "$DB_FILE" || true
}

# -----------------------------------------------------------------------------
# Export latest entry of a type
# -----------------------------------------------------------------------------
get_latest_by_type() {
  local type="$1"

  grep "\"type\":\"$type\"" "$DB_FILE" | tail -n 1 || true
}

# =============================================================================
# EXAMPLE USAGE (SAFE, NON-INTERACTIVE)
# =============================================================================
# add_config_entry "hardware" "intel_wifi" '{"driver":"iwlwifi","fw":"46.6"}'
# add_config_entry "software" "node_server" '{"node":"18","npm":"9"}'
# get_configs_by_type "hardware"
# get_latest_by_type "software"