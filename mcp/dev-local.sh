#!/usr/bin/env bash
# Run the MCP service locally with .env.local (prod gets env from Coolify).
#   ./dev-local.sh          build + run
#   ./dev-local.sh --watch  run from TypeScript with auto-reload (needs npx tsx)
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f .env.local ]; then
  echo "Missing .env.local — see docs/env-vars.md (AI / MCP section)" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
source .env.local
set +a

if [ "${1:-}" = "--watch" ]; then
  exec npx tsx watch src/server.ts
fi

npm run build
exec node dist/server.js
