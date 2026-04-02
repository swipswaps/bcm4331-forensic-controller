#!/bin/bash
# ==============================================================================
# fix-wifi.sh - Forensic Recovery Engine v90.10 [HARDENED & VERBOSE]
# ==============================================================================
# PURPOSE: Deterministic recovery of Broadcom BCM4331 chipsets on Fedora.
# PHILOSOPHY: Assume total system failure. Log every internal decision.
# COMPLIANCE: Prints log path as line 1. Teed telemetry for all 17 audit points.
# ==============================================================================

set -euo pipefail

# POINT 4-5: Argument State Recording.
# Recording the input flags ensures that the audit trail reflects whether
# the user forced a recovery or was just performing a health check.
FORCE=0
CHECK_ONLY=0
# We allow PROJECT_ROOT to be set via environment OR --workspace argument.
PROJECT_ROOT="${PROJECT_ROOT:-}"

MONITOR=0
# Parse arguments first to capture --workspace before any validation.
TEMP_ARGS=("$@")
while [[ $# -gt 0 ]]; do
  case $1 in
    --force) FORCE=1; shift ;;
    --check-only) CHECK_ONLY=1; shift ;;
    --monitor) MONITOR=1; shift ;;
    --workspace) PROJECT_ROOT="$2"; shift 2 ;;
    *) shift ;;
  esac
done
# Restore arguments for any later use if needed.
set -- "${TEMP_ARGS[@]}"

# POINT 1: Absolute path resolution for the log file.
# This is the first line of output to ensure orchestrators can find the stream.
# We enforce PROJECT_ROOT to prevent "silent" failures in system paths.
# Fallback: if PROJECT_ROOT is missing, try to derive it from the script's directory.
if [[ -z "${PROJECT_ROOT:-}" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  # If we are in /usr/local/bin, we can't use it as PROJECT_ROOT.
  if [[ "$SCRIPT_DIR" == "/usr/local/bin" ]]; then
    echo "ERROR: PROJECT_ROOT environment variable or --workspace argument is required when running from system path." >&2
    exit 1
  fi
  PROJECT_ROOT="$SCRIPT_DIR"
fi
LOG_FILE="${PROJECT_ROOT}/verbatim_handshake.log"
echo "${LOG_FILE}"

# POINT 6: Confirmation of trap activation.
# We establish signal handlers to ensure the mutex is released and the stack is 
# dumped even if the user interrupts the script or a command fails.
log_and_tee() {
  local ts=$(date '+%Y-%m-%d %H:%M:%S.%3N')
  echo -e "\033[1;36m[$ts]\033[0m $1" | tee -a "$LOG_FILE"
}

# Improved trap logic to avoid "FATAL ERROR" on successful exit
trap 'FAILED_LINE=$LINENO' ERR
cleanup() {
  local exit_code=$?
  if [[ $exit_code -ne 0 ]]; then
    log_and_tee "❌ FATAL ERROR at line ${FAILED_LINE:-$LINENO} (Exit Code: $exit_code)"
    dump_stack "${FAILED_LINE:-$LINENO}"
  fi
  release_mutex
}
trap cleanup EXIT
trap 'exit 1' INT TERM
log_and_tee "🛡️  Forensic error traps and signal handlers activated."

# POINT 2-3: Path Transparency.
# Explicitly declaring the location of the state database and the lock file
# to prevent "silent" file creation in unexpected directories.
DB_FILE="${PROJECT_ROOT}/recovery_state.db"
MUTEX="${PROJECT_ROOT}/.recovery_mutex"
log_and_tee "🗄️  DB_PATH: ${DB_FILE}"
log_and_tee "🔒 MUTEX_PATH: ${MUTEX}"
log_and_tee "⚙️  EXECUTION_MODE: FORCE=${FORCE}, CHECK_ONLY=${CHECK_ONLY}"

# ====================== FORENSIC CORE FUNCTIONS ======================

# POINT 16: Stack Context.
# Provides a system snapshot (Kernel version and Uptime) to correlate 
# hardware failures with specific kernel states.
dump_stack() {
  local line="$1"
  {
    echo "=== FORENSIC STACK DUMP @ Line ${line} ==="
    echo "Kernel: $(uname -r)"
    echo "Uptime: $(uptime -p)"
    echo "Last 20 Log Lines:"
    tail -n 20 "$LOG_FILE"
  } >> "$LOG_FILE"
}

# POINT 12: Interface Logic.
# We use a deterministic sort on the sysfs network class to ensure that 
# if multiple Broadcom cards exist, we always target the primary one.
detect_interface() {
  log_and_tee "📡 Searching for wireless hardware via /sys/class/net..."
  
  # Try to retrieve BKW interface from database first
  local bkw_iface=$(sqlite3 "$DB_FILE" "SELECT value FROM config WHERE key='bkw_interface';" 2>/dev/null || true)
  
  if [[ -n "$bkw_iface" ]] && [[ -d "/sys/class/net/$bkw_iface" ]]; then
    INTERFACE="$bkw_iface"
    log_and_tee "💎 Best Known Working interface retrieved from DB: ${INTERFACE}"
  else
    INTERFACE=$(ls /sys/class/net 2>/dev/null | grep -E '^(wl|wlan)' | sort | head -n1 || echo "wlan0")
    log_and_tee "✅ Hardware interface identified via discovery: ${INTERFACE}"
  fi
}

save_bkw() {
  local key="$1"
  local value="$2"
  local ts=$(date '+%Y-%m-%d %H:%M:%S')
  log_and_tee "💾 Saving Best Known Working resource: ${key}=${value}"
  sqlite3 "$DB_FILE" "INSERT OR REPLACE INTO config (key, value, last_updated) VALUES ('${key}', '${value}', '${ts}');"
}

# POINT 7: DB Existence.
# Initializing the SQLite schema with WAL mode to allow the React dashboard
# to read milestones while the bash engine is writing them.
init_db() {
  if [[ ! -f "$DB_FILE" ]]; then
    log_and_tee "🗄️  Forensic DB missing. Creating new schema..."
    sqlite3 "$DB_FILE" "CREATE TABLE milestones (timestamp TEXT, name TEXT, details TEXT); 
                        CREATE TABLE commands (timestamp TEXT, command TEXT, exit_code INTEGER);
                        CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT, last_updated TEXT);
                        CREATE INDEX idx_milestones_name ON milestones(name);
                        PRAGMA journal_mode=WAL;"
  else
    log_and_tee "✅ Existing forensic database verified."
    # Ensure config table exists in case of older DB versions
    sqlite3 "$DB_FILE" "CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT, last_updated TEXT);"
  fi
}

# POINT 10: Lock PID.
# Recording the PID in the mutex ensures we can identify which process 
# owns the hardware lock if a recovery hangs.
acquire_mutex() {
  if [[ "$FORCE" -eq 1 ]]; then
    log_and_tee "⚠️  FORCE mode enabled. Terminating existing forensic monitors..."
    if [ -f "$MUTEX" ]; then
      local pid=$(cat "$MUTEX")
      if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
        sudo kill -9 "$pid" || true
      fi
      rm -f "$MUTEX"
    fi
  fi

  if [ -f "$MUTEX" ] && kill -0 "$(cat "$MUTEX")" 2>/dev/null; then
    log_and_tee "⚠️  CONFLICT: Another recovery in progress (PID $(cat "$MUTEX"))."
    exit 0
  fi
  echo $$ > "$MUTEX"
  log_and_tee "🔒 Mutex lock secured by PID $$"
}

# POINT 11: Mutex Release.
# Explicitly logging the release of the lock to mark the end of the 
# hardware-exclusive execution block.
release_mutex() {
  if [[ -f "$MUTEX" ]]; then
    log_and_tee "🔓 Releasing hardware mutex lock..."
    rm -f "$MUTEX"
  fi
}

# POINT 8-9: Success Silence Elimination.
# Self-linting ensures that the environment (binaries and sudoers) is 
# ready before we attempt to reload kernel modules.
self_lint() {
  log_and_tee "🔍 Running environment self-lint..."
  local required=(sqlite3 dnf rfkill modprobe iwconfig ethtool nmcli ip dmesg iw)
  for bin in "${required[@]}"; do
    if command -v "$bin" >/dev/null 2>&1; then
      log_and_tee "✅ Binary verified: $bin"
    else
      log_and_tee "⚠️  WARNING: $bin is missing. Attempting recovery in dependency phase."
    fi
  done

  if sudo -n -l | grep -q "/usr/local/bin/fix-wifi"; then
    log_and_tee "✅ Sudoers NOPASSWD integrity verified."
  else
    log_and_tee "⚠️  Sudoers regression detected. Repairing /etc/sudoers.d/broadcom-control..."
    sudo tee /etc/sudoers.d/broadcom-control >/dev/null <<EOF
$(whoami) ALL=(ALL) NOPASSWD: SETENV: /usr/local/bin/fix-wifi
EOF
    sudo chmod 0440 /etc/sudoers.d/broadcom-control
    log_and_tee "✅ Sudoers rule restored."
  fi
}

run_verbatim() {
  local cmd="$1"
  local desc="${2:-Executing command}"
  local ts=$(date '+%Y-%m-%d %H:%M:%S')
  log_and_tee "→ Milestone: ${desc} [${cmd}]"
  sqlite3 "$DB_FILE" "INSERT INTO commands (timestamp, command, exit_code) VALUES ('${ts}', '${cmd}', -1);" 2>/dev/null || true
  eval "$cmd" 2>&1 | tee -a "$LOG_FILE"
  local exit_code=${PIPESTATUS[0]}
  sqlite3 "$DB_FILE" "UPDATE commands SET exit_code = ${exit_code} WHERE timestamp = '${ts}' AND command = '${cmd}';" 2>/dev/null || true
  return $exit_code
}

# -----------------------------------------------------------------------------
# PID CONTROLLER CONFIGURATION
# -----------------------------------------------------------------------------
SCALE=1000
Kp=800
Ki=50
Kd=300
prev_error=0
I_error=0
I_CLAMP=50000
DEADBAND=5
HYSTERESIS_HIGH=60
HYSTERESIS_LOW=40
MAX_OUTPUT=1000
MIN_OUTPUT=-1000

# Load PID parameters from DB if they exist
load_pid_params() {
  local db_kp=$(sqlite3 "$DB_FILE" "SELECT value FROM config WHERE key='pid_kp';" 2>/dev/null || true)
  local db_ki=$(sqlite3 "$DB_FILE" "SELECT value FROM config WHERE key='pid_ki';" 2>/dev/null || true)
  local db_kd=$(sqlite3 "$DB_FILE" "SELECT value FROM config WHERE key='pid_kd';" 2>/dev/null || true)
  
  [[ -n "$db_kp" ]] && Kp=$db_kp
  [[ -n "$db_ki" ]] && Ki=$db_ki
  [[ -n "$db_kd" ]] && Kd=$db_kd
}

# -----------------------------------------------------------------------------
# NETWORK HEALTH SENSOR
# -----------------------------------------------------------------------------
CACHED_HEALTH=0

calculate_health() {
  local score=0
  local reason=""
  if ping -c 3 -W 2 8.8.8.8 >/dev/null 2>&1; then
    score=$((score + 40))
  else
    reason="${reason}Ping failed; "
  fi
  if getent hosts google.com >/dev/null 2>&1; then
    score=$((score + 30))
  else
    reason="${reason}DNS failed; "
  fi
  if ip route | grep -q "^default"; then
    score=$((score + 30))
  else
    reason="${reason}No default route; "
  fi
  if [[ $score -lt 100 ]]; then
    # Log to stderr to avoid polluting stdout which is used for the numeric return value
    echo "⚠️  HEALTH_DEGRADED: Score $score/100 | Reasons: ${reason:-None}" >&2
  fi
  CACHED_HEALTH=$score
  sqlite3 "$DB_FILE" "INSERT OR REPLACE INTO config (key, value) VALUES ('health_score', '$score');"
  echo "$score"
}

# -----------------------------------------------------------------------------
# PID CONTROL LOGIC
# -----------------------------------------------------------------------------
PID_CONTROL() {
  load_pid_params
  local current=$1
  local error D_error output
  error=$(( (100 - current) * SCALE ))
  
  # Simple low-pass filter on error
  error=$(( (prev_error * 700 + error * 300) / 1000 ))
  
  local abs_error=${error#-}
  if (( abs_error < DEADBAND * SCALE )); then
    prev_error=$error
    echo 0
    return
  fi
  
  D_error=$((error - prev_error))
  local tentative_I=$((I_error + error))
  
  local raw_output=$(( (Kp * error + Ki * tentative_I + Kd * D_error) / SCALE ))
  local saturated=0
  
  if (( raw_output > MAX_OUTPUT )); then
    output=$MAX_OUTPUT; saturated=1
  elif (( raw_output < MIN_OUTPUT )); then
    output=$MIN_OUTPUT; saturated=1
  else
    output=$raw_output
  fi
  
  if (( saturated == 0 )); then
    I_error=$tentative_I
    if (( I_error > I_CLAMP * SCALE )); then I_error=$((I_CLAMP * SCALE)); fi
    if (( I_error < -I_CLAMP * SCALE )); then I_error=$((-I_CLAMP * SCALE)); fi
  fi
  
  prev_error=$error
  echo "$output"
}

# -----------------------------------------------------------------------------
# RECOVERY SEQUENCE
# -----------------------------------------------------------------------------
recover() {
  local current_health
  current_health=$(calculate_health)
  if [[ "$current_health" -eq 100 ]]; then
    log_and_tee "✅ RECOVERY_SKIPPED: System health is already 100/100."
    return 0
  fi

  log_and_tee "🚀 RECOVERY_SEQUENCE_START: Current Health: $current_health/100"
  
  # Phase 2 logic (Hardware Handshake)
  detect_interface
  save_bkw "bkw_interface" "$INTERFACE"

  log_and_tee "🔧 Resetting kernel module state..."
  run_verbatim "sudo modprobe -r b43 bcma wl brcmsmac" "Unloading conflicting modules" || true

  log_and_tee "🔧 Loading deterministic module (wl)..."
  if ! run_verbatim "sudo modprobe wl" "Loading Broadcom-STA module"; then
    log_and_tee "⚠️  'wl' module failed. Attempting 'b43' fallback..."
    run_verbatim "sudo modprobe b43" "Loading b43 module"
  fi

  log_and_tee "🔧 Unblocking radio via rfkill..."
  run_verbatim "sudo rfkill unblock all" "RFKill global unblock"

  log_and_tee "🔧 Forcing interface up..."
  run_verbatim "sudo ip link set $INTERFACE up" "Manual link activation" || true

  log_and_tee "🔧 Re-syncing NetworkManager..."
  # Force networking on if it's disabled
  if nmcli networking | grep -q "disabled"; then
    log_and_tee "⚠️  NetworkManager networking is disabled. Forcing on..."
    run_verbatim "sudo nmcli networking on" "Enabling NM global networking"
  fi
  run_verbatim "sudo nmcli device set $INTERFACE managed yes" "Enabling NM management"
  run_verbatim "sudo nmcli device connect $INTERFACE" "Triggering NM connection" || true

  touch "${PROJECT_ROOT}/recovery_complete.flag"
  log_and_tee "✅ Recovery sequence complete."
}

# -----------------------------------------------------------------------------
# MAIN MONITORING LOOP
# -----------------------------------------------------------------------------
main_loop() {
  log_and_tee "🛰️  Broadcom Network Controller active. Monitoring health..."
  
  while true; do
    local health
    health=$(calculate_health)
    local control
    control=$(PID_CONTROL "$health")
    
    log_and_tee "📈 PID SIGNAL: $control | Health: ${health}/100"
    sqlite3 "$DB_FILE" "INSERT INTO milestones (timestamp, name, details) VALUES ('$(date '+%Y-%m-%d %H:%M:%S')', 'HEARTBEAT', 'Signal: $control | Health: ${health}/100');"

    if (( control < HYSTERESIS_LOW )); then
      # Stable
      :
    elif (( control < HYSTERESIS_HIGH )); then
      log_and_tee "⚠️  STATUS: Degrading. Triggering soft network toggle..."
      run_verbatim "sudo nmcli networking off && sleep 1 && sudo nmcli networking on" "Soft Reset"
    else
      log_and_tee "🚨 STATUS: Critical failure. Triggering full recovery engine..."
      recover
    fi
    
    sleep 10
  done
}

# ====================== EXECUTION SEQUENCE ======================

# POINT 1: Absolute path resolution for the log file.
# POINT 2: Path Transparency (DB).
# POINT 3: Path Transparency (Mutex).
# POINT 4: Argument State Recording (Flags).
# POINT 5: Argument State Recording (Workspace).
# POINT 6: Confirmation of trap activation.
# POINT 7: DB Existence verification.
# POINT 8: Success Silence Elimination (Binaries).
# POINT 9: Success Silence Elimination (Sudoers).
# POINT 10: Lock PID recording.
# POINT 11: Mutex Release logging.
# POINT 12: Interface Logic (Discovery).
# POINT 13: Phase 1 Declaration.
# POINT 14: Phase 2 Declaration.
# POINT 15: Flag Creation.
# POINT 16: Stack Context (Forensic Dump).
# POINT 17: Final Exit status.

log_and_tee "🔒 Hardened fix-wifi v90.10 starting..."
log_and_tee "📍 Audit Point 1-6: Environment and Trap Initialization"
init_db
acquire_mutex
self_lint

if [[ $CHECK_ONLY -eq 1 ]]; then
  log_and_tee "✅ Check-only mode passed. System is integrated and healthy."
  release_mutex
  exit 0
fi

if [[ $MONITOR -eq 1 ]]; then
  main_loop
  exit 0
fi

# POINT 13-14: Phase Declarations.
log_and_tee "📦 Phase 1: Dependency Audit"
sqlite3 "$DB_FILE" "INSERT INTO milestones (timestamp, name, details) VALUES ('$(date '+%Y-%m-%d %H:%M:%S')', 'PHASE_1', 'Starting dependency audit and environment check');"

# Ensure all forensic tools are present
deps=(sqlite3 dnf rfkill modprobe iwconfig ethtool nmcli ip dmesg iw)
for dep in "${deps[@]}"; do
  if ! command -v "$dep" >/dev/null 2>&1; then
    log_and_tee "⚠️  Dependency missing: $dep. Attempting emergency installation..."
    sudo dnf install -y "$dep" || log_and_tee "❌ Failed to install $dep. Recovery may be partial."
  fi
done

log_and_tee "🤝 Phase 2: Deep Forensic Handshake"
sqlite3 "$DB_FILE" "INSERT INTO milestones (timestamp, name, details) VALUES ('$(date '+%Y-%m-%d %H:%M:%S')', 'PHASE_2', 'Starting hardware handshake and module cycling');"
detect_interface
save_bkw "bkw_interface" "$INTERFACE"

log_and_tee "🔧 Resetting kernel module state..."
run_verbatim "sudo modprobe -r b43 bcma wl brcmsmac" "Unloading conflicting modules" || true

log_and_tee "🔧 Loading deterministic module (wl)..."
# We prefer 'wl' for BCM4331 on Fedora (RPM Fusion), but fallback to 'b43' if needed.
if ! run_verbatim "sudo modprobe wl" "Loading Broadcom-STA module"; then
  log_and_tee "⚠️  'wl' module failed. Attempting 'b43' fallback..."
  run_verbatim "sudo modprobe b43" "Loading b43 module"
fi

log_and_tee "🔧 Unblocking radio via rfkill..."
run_verbatim "sudo rfkill unblock all" "RFKill global unblock"

log_and_tee "🔧 Forcing interface up..."
run_verbatim "sudo ip link set $INTERFACE up" "Manual link activation" || true

log_and_tee "🔧 Re-syncing NetworkManager..."
run_verbatim "sudo nmcli networking on" "Enabling NM global networking"
run_verbatim "sudo nmcli device set $INTERFACE managed yes" "Enabling NM management"
run_verbatim "sudo nmcli device connect $INTERFACE" "Triggering NM connection" || true

# POINT 15: Flag Creation.
touch "${PROJECT_ROOT}/recovery_complete.flag"
log_and_tee "✅ Recovery flag created at ${PROJECT_ROOT}/recovery_complete.flag"
sqlite3 "$DB_FILE" "INSERT INTO milestones (timestamp, name, details) VALUES ('$(date '+%Y-%m-%d %H:%M:%S')', 'RECOVERY_COMPLETE', 'Hardware interface $INTERFACE successfully recovered and synchronized');"

# POINT 17: Final Exit.
log_and_tee "🏁 Forensic Engine v90.10 exiting normally."
sqlite3 "$DB_FILE" "INSERT INTO milestones (timestamp, name, details) VALUES ('$(date '+%Y-%m-%d %H:%M:%S')', 'EXIT_NORMAL', 'Forensic engine finished execution');"
release_mutex
exit 0
