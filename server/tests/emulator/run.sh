#!/usr/bin/env bash
# Runs the Adaptive engine's emulator tests (tests/emulator/*.test.ts) against a
# THROWAWAY Firestore emulator — its own container on 127.0.0.1:8085, project
# demo-adaptive-test — so a developer's running emulator and demo data are never
# touched. Needs Docker. Nothing here can reach a real Firebase project.
#
#   bash tests/emulator/run.sh            (from captive-server/server)
#   ADAPTIVE_TEST_EMULATOR=127.0.0.1:8085 bash tests/emulator/run.sh   (reuse a running one)
set -euo pipefail

cd "$(dirname "$0")/../.."
HOST="${ADAPTIVE_TEST_EMULATOR:-}"
CONTAINER=adaptive-engine-test-emulator
IMAGE="${ADAPTIVE_EMULATOR_IMAGE:-adaptive-verify-emulator:local}"
PROJECT=demo-adaptive-test
WORK="$(mktemp -d)"
CONTAINER_ID=""

cleanup() {
  # Only the container this run started — never another run's.
  if [ -n "$CONTAINER_ID" ]; then docker rm -f "$CONTAINER_ID" >/dev/null 2>&1 || true; fi
  rm -rf "$WORK"
}
trap cleanup EXIT

if [ -z "$HOST" ]; then
  if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    echo "Building the emulator image $IMAGE …"
    docker build -t "$IMAGE" ../../cms/e2e/captive-portal/docker/firebase-emulator >/dev/null
  fi
  cat >"$WORK/firebase.json" <<'JSON'
{ "emulators": { "firestore": { "port": 8080, "host": "0.0.0.0" }, "ui": { "enabled": false }, "singleProjectMode": true } }
JSON
  # One run at a time: the port and the emulator's data are shared by the whole suite.
  if [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || true)" = "true" ]; then
    echo "Another emulator test run is in progress (container $CONTAINER). Wait for it, or stop it: docker rm -f $CONTAINER" >&2
    exit 1
  fi
  docker rm "$CONTAINER" >/dev/null 2>&1 || true # a stopped leftover
  CONTAINER_ID="$(docker run -d --rm --name "$CONTAINER" -p 127.0.0.1:8085:8080 \
    -v "$WORK/firebase.json:/app/firebase.json:ro" \
    "$IMAGE" firebase emulators:start --project "$PROJECT" --only firestore)"
  HOST=127.0.0.1:8085
  printf 'Waiting for the test emulator on %s ' "$HOST"
  for _ in $(seq 1 60); do
    if curl -s "http://$HOST/" >/dev/null 2>&1; then echo ' ready'; break; fi
    printf '.'; sleep 2
  done
fi

# cert() parses the key at import time, so it must be a real (throwaway) PEM.
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$WORK/key.pem" 2>/dev/null

export FIRESTORE_EMULATOR_HOST="$HOST"
export FIREBASE_PROJECT_ID="$PROJECT"
export FIREBASE_CLIENT_EMAIL="test@$PROJECT.iam.gserviceaccount.com"
FIREBASE_PRIVATE_KEY="$(cat "$WORK/key.pem")"
export FIREBASE_PRIVATE_KEY
export GUEST_OTP_PEPPER=emulator-test-pepper
export INTERNAL_API_SECRET=emulator-test-secret
export ADAPTIVE_SANDBOX=1
# Email marketing fails closed without an unsubscribe link, so the tests set test values.
export UNSUBSCRIBE_SIGNING_SECRET=emulator-test-unsubscribe
export SERVER_PUBLIC_URL=http://api.test.local

failed=0
for f in tests/emulator/*.test.ts; do
  echo "── $f"
  if ! npx --yes tsx "$f"; then failed=$((failed + 1)); fi
done
[ "$failed" = 0 ] && echo "All emulator test files passed." || { echo "$failed emulator test file(s) failed."; exit 1; }
