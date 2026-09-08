#!/usr/bin/env bash
# Serve the SpellLang demo (demo/blocks.html) on http://127.0.0.1:8177
# Uses scripts/serve-demo.mjs (no-store headers — fresh dist/ on every refresh).
# Usage: pnpm demo   (or: bash scripts/serve-demo.sh)
set -euo pipefail

PORT="${PORT:-8177}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
URL="http://127.0.0.1:${PORT}/demo/blocks.html"

if curl -fs -o /dev/null --max-time 2 "$URL"; then
  echo "Demo server is already running."
  echo "Open: $URL"
  exit 0
fi

if [ ! -f "$ROOT/dist/blocks/index.js" ]; then
  echo "dist/ not built — building first..."
  (cd "$ROOT" && pnpm build)
fi

echo "Serving $ROOT on http://127.0.0.1:${PORT} (Ctrl+C to stop)"
echo "Open: $URL"
cd "$ROOT"
exec node scripts/serve-demo.mjs
