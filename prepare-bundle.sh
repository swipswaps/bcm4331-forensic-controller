#!/usr/bin/env bash
set -euo pipefail
REPO_DIR="./offline_bundle"
mkdir -p "$REPO_DIR"
FW_URL="https://raw.githubusercontent.com/LibreELEC/wlan-firmware/master/firmware/b43"
echo "=== Downloading b43 Firmware for Offline Use ==="
for f in ucode29_mimo.fw ht0initvals29.fw ht0bsinitvals29.fw; do
    wget -q -O "$REPO_DIR/$f" "$FW_URL/$f" || echo "Failed to download $f"
done
echo "=== Downloading Recovery Tools ==="
# Note: dnf download might not work in all environments
dnf download --destdir="$REPO_DIR" --resolve b43-fwcutter wget rfkill 2>/dev/null || echo "dnf download skipped (not on Fedora/RHEL or no dnf-plugins-core)"
echo "Bundle created in $REPO_DIR"
