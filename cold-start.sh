#!/bin/bash
# cold-start.sh - Nuclear Orchestrator v30.4 HARDENED
set -euo pipefail

# CRITICAL: Print log path as the absolute first line of STDOUT
# Fallback: if PROJECT_ROOT is missing, try to derive it from the script's directory.
if [[ -z "${PROJECT_ROOT:-}" ]]; then
  PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi
LOG_FILE="${PROJECT_ROOT}/verbatim_handshake.log"
echo "${LOG_FILE}"

# Redirect all output to the log file while also displaying in terminal
exec > >(tee -a "$LOG_FILE") 2>&1

log_and_tee() {
  echo -e "\033[1;36m[$(date '+%H:%M:%S')]\033[0m $1" | tee -a "$LOG_FILE"
}

log_and_tee "Cold-Start Nuclear Orchestrator v30.4 starting..."

if [ -f "${PROJECT_ROOT}/recovery_complete.flag" ] && [ "${1:-}" != "--force" ]; then
  log_and_tee "Idempotent skip – already complete. Use --force to override."
  exit 0
fi

acquire_mutex() {
  if [ -f "${PROJECT_ROOT}/.recovery_mutex" ] && kill -0 "$(cat ${PROJECT_ROOT}/.recovery_mutex)" 2>/dev/null; then
    log_and_tee "⚠️  Another recovery in progress – skipping"
    exit 0
  fi
  echo $$ > "${PROJECT_ROOT}/.recovery_mutex"
}

retry_command() {
  local cmd="$1" desc="${2:-Command}" max=5
  for i in $(seq 1 $max); do
    log_and_tee "→ [RETRY $i/$max] $desc"
    if eval "$cmd"; then
      return 0
    fi
    sleep $((2**i))
  done
  log_and_tee "❌ Failed after $max retries: $desc"
  return 1
}

acquire_mutex

# Rapid recovery block: clear vite hmr port only, don't kill the main server port 3000
# as it would cause a NetworkError in the browser.
sudo fuser -k 24678/tcp 2>/dev/null || true

# Execute the core engine. We use sudo -E to preserve PROJECT_ROOT environment variable.
# The sudoers rule includes SETENV, which allows this.
retry_command "sudo -n -E /usr/local/bin/fix-wifi --workspace \"${PROJECT_ROOT}\" --force" "Nuclear recovery"

touch "${PROJECT_ROOT}/recovery_complete.flag"
rm -f "${PROJECT_ROOT}/.recovery_mutex"

log_and_tee "Cold-Start COMPLETE – dashboard ready at http://localhost:3000"
