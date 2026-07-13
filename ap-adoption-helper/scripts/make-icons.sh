#!/usr/bin/env bash
# Generates build/icon.png (1024x1024) and build/icon.icns from the HeidiFi
# logo using macOS-native tooling (sips + iconutil). Run: npm run icons
set -euo pipefail
cd "$(dirname "$0")/.."

SRC=assets/heidifi-logo.png
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

mkdir -p build

# Upscale the logo, then center it on a 1024x1024 white tile (the navy logo
# needs a light background; sips cannot pad transparently).
sips --resampleWidth 680 "$SRC" --out "$TMP/logo-big.png" >/dev/null
sips --padToHeightWidth 1024 1024 --padColor FFFFFF "$TMP/logo-big.png" --out build/icon.png >/dev/null

ICONSET="$TMP/icon.iconset"
mkdir -p "$ICONSET"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" build/icon.png --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  dbl=$((size * 2))
  sips -z "$dbl" "$dbl" build/icon.png --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o build/icon.icns

echo "Wrote build/icon.png and build/icon.icns"
