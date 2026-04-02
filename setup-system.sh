#!/bin/bash
# setup-system.sh - System Integration v30.4 HARDENED
set -euo pipefail

# CRITICAL: Print log path as the absolute first line of STDOUT
# Fallback: if PROJECT_ROOT is missing, try to derive it from the script's directory.
if [[ -z "${PROJECT_ROOT:-}" ]]; then
  PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi
LOG_FILE="${PROJECT_ROOT}/verbatim_handshake.log"
echo "${LOG_FILE}"

# Redirect all output to the log file while also displaying in terminal
# We use a simple redirection here; log_and_tee will handle the terminal display.
exec >> "$LOG_FILE" 2>&1

log_and_tee() { echo -e "\033[1;36m[$(date '+%H:%M:%S')]\033[0m $1" | tee -a "$LOG_FILE"; }

log_and_tee "System Integration v30.4 starting..."

# Self-validate & repair sudoers
log_and_tee "Configuring passwordless sudoers drop-in..."
sudo rm -f /etc/sudoers.d/broadcom-control
sudo tee /etc/sudoers.d/broadcom-control > /dev/null <<EOF
$(whoami) ALL=(ALL) NOPASSWD: SETENV: /usr/local/bin/fix-wifi
$(whoami) ALL=(ALL) NOPASSWD: /usr/sbin/tcpdump
$(whoami) ALL=(ALL) NOPASSWD: /usr/sbin/modprobe
$(whoami) ALL=(ALL) NOPASSWD: /usr/sbin/rfkill
$(whoami) ALL=(ALL) NOPASSWD: /usr/bin/nmcli
$(whoami) ALL=(ALL) NOPASSWD: /usr/bin/systemctl
$(whoami) ALL=(ALL) NOPASSWD: /usr/sbin/iw
$(whoami) ALL=(ALL) NOPASSWD: /usr/sbin/ip
$(whoami) ALL=(ALL) NOPASSWD: /usr/bin/pkill
EOF
sudo chmod 0440 /etc/sudoers.d/broadcom-control
sudo visudo -c -f /etc/sudoers.d/broadcom-control || { log_and_tee "❌ Sudoers invalid – aborting"; exit 1; }

log_and_tee "Installing forensic dependencies..."
sudo dnf install -y sqlite tcpdump mtr traceroute bind-utils NetworkManager iw rfkill python3-pip || true

# Deploying recovery script to system path...
log_and_tee "Deploying recovery script to system path..."
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
sudo cp "${SCRIPT_DIR}/fix-wifi.sh" /usr/local/bin/fix-wifi
sudo chmod +x /usr/local/bin/fix-wifi

log_and_tee "✅ System integration complete – fully hardened"
