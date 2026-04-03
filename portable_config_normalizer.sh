#!/usr/bin/env bash
# =============================================================================
# portable_config_normalizer.sh
# =============================================================================
# PURPOSE:
#   Converts machine-specific configuration into portable templates.
#
# REMOVES:
#   - MAC addresses
#   - interface names (wlp*, eth*)
#   - IP addresses
#
# OUTPUT:
#   normalized_config.env
# =============================================================================

set -euo pipefail

INPUT="${1:-state/portable_config.env}"
OUTPUT="state/normalized_config.env"

mkdir -p state

sed -E \
  -e 's/[0-9a-f]{2}(:[0-9a-f]{2}){5}/<MAC>/gi' \
  -e 's/\b([0-9]{1,3}\.){3}[0-9]{1,3}\b/<IP>/g' \
  -e 's/wlp[0-9a-z]+/<WIFI_IFACE>/g' \
  -e 's/eth[0-9]+/<ETH_IFACE>/g' \
  "$INPUT" > "$OUTPUT"

echo "[NORMALIZER] Output → $OUTPUT"