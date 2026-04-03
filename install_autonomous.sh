#!/usr/bin/env bash
# =============================================================================
# install_autonomous.sh (HARDENED)
# =============================================================================
# FIXES APPLIED:
#   ✔ Ensures absolute paths (systemd requirement)
#   ✔ Validates source files before install
#   ✔ Fixes incorrect ExecStart path mismatch
#   ✔ Prevents silent failure
# =============================================================================

set -euo pipefail

LOG_TAG="[INSTALL-AUTO]"

log() {
  echo "$LOG_TAG $1"
}

fail() {
  echo "$LOG_TAG [ERROR] $1" >&2
  exit 1
}

INSTALL_DIR="/opt/network-integrity"
SERVICE_FILE="/etc/systemd/system/autonomous.service"

# -----------------------------------------------------------------------------
# STEP 1 — VALIDATE FILES EXIST
# -----------------------------------------------------------------------------

REQUIRED=(
  "network_autonomous_daemon.sh"
  "portable_config_normalizer.sh"
  "autonomous.service"
)

for f in "${REQUIRED[@]}"; do
  [[ -f "$f" ]] || fail "Missing required file: $f"
done

log "All required files present"

# -----------------------------------------------------------------------------
# STEP 2 — INSTALL FILES
# -----------------------------------------------------------------------------

mkdir -p "$INSTALL_DIR"

cp network_autonomous_daemon.sh "$INSTALL_DIR/"
cp portable_config_normalizer.sh "$INSTALL_DIR/"

chmod +x "$INSTALL_DIR/"*.sh

log "Scripts installed to $INSTALL_DIR"

# -----------------------------------------------------------------------------
# STEP 3 — FIX SERVICE FILE PATH (CRITICAL)
# -----------------------------------------------------------------------------
# Your original service had:
#   /opt/network_autonomous_daemon.sh   ❌ WRONG PATH
#
# Actual install path:
#   /opt/network-integrity/network_autonomous_daemon.sh
# -----------------------------------------------------------------------------

sed "s|/opt/network_autonomous_daemon.sh|$INSTALL_DIR/network_autonomous_daemon.sh|g" \
  autonomous.service > "$SERVICE_FILE"

log "Service file installed"

# -----------------------------------------------------------------------------
# STEP 4 — ENABLE SERVICE
# -----------------------------------------------------------------------------

systemctl daemon-reexec
systemctl daemon-reload
systemctl enable autonomous.service
systemctl restart autonomous.service

log "Autonomous system ACTIVE"

# -----------------------------------------------------------------------------
# STEP 5 — STATUS
# -----------------------------------------------------------------------------

systemctl status autonomous.service --no-pager

echo
log "Logs:"
echo "journalctl -u autonomous.service -f"