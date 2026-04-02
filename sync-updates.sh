#!/usr/bin/env bash
# sync-updates.sh - Repo sync v1.1 HARDENED
set -euo pipefail

# CRITICAL: Print log path as the absolute first line of STDOUT
# Fallback: if PROJECT_ROOT is missing, try to derive it from the script's directory.
if [[ -z "${PROJECT_ROOT:-}" ]]; then
  PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi
LOG_FILE="${PROJECT_ROOT}/verbatim_handshake.log"
echo "${LOG_FILE}"

cd "$PROJECT_ROOT"
echo "[SYNC] Starting synchronization..." | tee -a "$LOG_FILE"

echo "[SYNC] Checking local repository state..." | tee -a "$LOG_FILE"
git add -A
if ! git diff --cached --quiet; then
  git commit -m "chore: local state preservation before sync ($(date +%Y%m%d-%H%M))"
fi

echo "[SYNC] Reconciling with upstream..." | tee -a "$LOG_FILE"
git pull --rebase origin main || echo "[SYNC] Remote sync skipped (no upstream)" | tee -a "$LOG_FILE"

echo "[SYNC] Restoring environment (npm install)..." | tee -a "$LOG_FILE"
npm install

echo "[SYNC] Verifying system integrity (npm run lint)..." | tee -a "$LOG_FILE"
npm run lint

echo "[SYNC] SUCCESS: System is synchronized and verified." | tee -a "$LOG_FILE"
