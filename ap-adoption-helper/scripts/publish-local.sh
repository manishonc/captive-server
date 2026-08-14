#!/usr/bin/env bash
# Build the AP Adoption Helper installers locally and publish them to the CDN —
# the local twin of .github/workflows/ap-adoption-helper-publish.yml, for when you
# want to ship without waiting on CI (or CI is down).
#
# Usage, from anywhere inside the repo:
#   ap-adoption-helper/scripts/publish-local.sh              # test + build mac & win + upload
#   ap-adoption-helper/scripts/publish-local.sh --skip-build # upload whatever is in release/
#   ap-adoption-helper/scripts/publish-local.sh --dry-run    # build, print what would upload
#
# Credentials, in order of preference:
#   1. BUNNY_STORAGE_ZONE / BUNNY_STORAGE_KEY in the environment
#   2. NEXT_PUBLIC_BUNNY_CDN_STORAGE_ZONE / BUNNY_CDN_ACCESS_KEY read from the sibling
#      cms repo's .env.local (../cms relative to this repo — the dev-machine layout)
# Optional: BUNNY_API_KEY (account key) purges the stable URLs so the new build is
# served immediately instead of when the CDN cache expires.
#
# Uploads FOUR names, same as CI:
#   heidifi/HeidiFi-AP-Adoption-Helper-<version>-mac-universal.dmg   (archive)
#   heidifi/HeidiFi-AP-Adoption-Helper-<version>-win-x64.exe         (archive)
#   heidifi/HeidiFi-AP-Adoption-Helper-mac.dmg                       (stable — what the dashboard links)
#   heidifi/HeidiFi-AP-Adoption-Helper-win.exe                       (stable — what the dashboard links)

set -euo pipefail

HELPER_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "$HELPER_DIR/.." && pwd)"
CDN_BASE="https://askheidi.b-cdn.net/heidifi"

SKIP_BUILD=false
DRY_RUN=false
for arg in "$@"; do
  case "$arg" in
    --skip-build) SKIP_BUILD=true ;;
    --dry-run) DRY_RUN=true ;;
    *) echo "Unknown flag: $arg" >&2; exit 2 ;;
  esac
done

# ── Credentials ───────────────────────────────────────────────────────────────
if [ -z "${BUNNY_STORAGE_ZONE:-}" ] || [ -z "${BUNNY_STORAGE_KEY:-}" ]; then
  CMS_ENV="$REPO_ROOT/../cms/.env.local"
  if [ -f "$CMS_ENV" ]; then
    BUNNY_STORAGE_ZONE="${BUNNY_STORAGE_ZONE:-$(grep '^NEXT_PUBLIC_BUNNY_CDN_STORAGE_ZONE=' "$CMS_ENV" | cut -d= -f2)}"
    BUNNY_STORAGE_KEY="${BUNNY_STORAGE_KEY:-$(grep '^BUNNY_CDN_ACCESS_KEY=' "$CMS_ENV" | cut -d= -f2)}"
  fi
fi
if [ -z "${BUNNY_STORAGE_ZONE:-}" ] || [ -z "${BUNNY_STORAGE_KEY:-}" ]; then
  echo "No Bunny credentials: set BUNNY_STORAGE_ZONE and BUNNY_STORAGE_KEY, or keep them in ../cms/.env.local" >&2
  exit 1
fi

# ── Build ─────────────────────────────────────────────────────────────────────
cd "$HELPER_DIR"
VERSION=$(node -p "require('./package.json').version")
DMG="release/HeidiFi-AP-Adoption-Helper-${VERSION}-mac-universal.dmg"
EXE="release/HeidiFi-AP-Adoption-Helper-${VERSION}-win-x64.exe"

if [ "$SKIP_BUILD" = false ]; then
  echo "── Building ${VERSION} (tests first) ──"
  npm test
  npm run dist:mac
  npm run dist:win
  # electron-builder leaves unpacked apps macOS registers as duplicate installs — clean them.
  rm -rf release/mac-universal release/mac-universal-arm64-temp release/mac-universal-x64-temp release/win-unpacked
fi

test -f "$DMG" || { echo "Missing $DMG — build first (or drop --skip-build)" >&2; exit 1; }
test -f "$EXE" || { echo "Missing $EXE — build first (or drop --skip-build)" >&2; exit 1; }

# ── Upload ────────────────────────────────────────────────────────────────────
put() {
  if [ "$DRY_RUN" = true ]; then
    echo "would upload $1 -> heidifi/$2"
    return
  fi
  curl -sf -X PUT "https://storage.bunnycdn.com/${BUNNY_STORAGE_ZONE}/heidifi/$2" \
    -H "AccessKey: ${BUNNY_STORAGE_KEY}" \
    -H "Content-Type: application/octet-stream" \
    --data-binary "@$1" > /dev/null
  echo "uploaded heidifi/$2"
}

put "$DMG" "HeidiFi-AP-Adoption-Helper-${VERSION}-mac-universal.dmg"
put "$EXE" "HeidiFi-AP-Adoption-Helper-${VERSION}-win-x64.exe"
put "$DMG" "HeidiFi-AP-Adoption-Helper-mac.dmg"
put "$EXE" "HeidiFi-AP-Adoption-Helper-win.exe"

[ "$DRY_RUN" = true ] && exit 0

# ── Purge + verify ────────────────────────────────────────────────────────────
if [ -n "${BUNNY_API_KEY:-}" ]; then
  for f in HeidiFi-AP-Adoption-Helper-mac.dmg HeidiFi-AP-Adoption-Helper-win.exe; do
    curl -sf -X POST "https://api.bunny.net/purge?url=https%3A%2F%2Faskheidi.b-cdn.net%2Fheidifi%2F${f}&async=false" \
      -H "AccessKey: ${BUNNY_API_KEY}" > /dev/null && echo "purged ${f}" || echo "purge failed for ${f} (non-fatal)"
  done
else
  echo "BUNNY_API_KEY not set — skipping cache purge; stable URLs update when the CDN cache expires."
fi

for f in "HeidiFi-AP-Adoption-Helper-mac.dmg" "HeidiFi-AP-Adoption-Helper-win.exe"; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "${CDN_BASE}/${f}")
  echo "${CDN_BASE}/${f} -> HTTP ${code}"
  [ "$code" = "200" ] || exit 1
done

echo "✓ Published ${VERSION}"
