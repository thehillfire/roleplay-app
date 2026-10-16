#!/usr/bin/env bash
# Runs everything CI runs against a throwaway server: unit/API tests, build,
# two-browser e2e and the accessibility audit. Exits non-zero on any failure.
# Usage: npm run verify   (CHROMIUM_PATH=... if Playwright's browser isn't installed)
set -euo pipefail

PORT="${VERIFY_PORT:-3999}"
TMP="$(mktemp -d)"
LOG="$TMP/server.log"
cleanup() {
  [[ -n "${SERVER_PID:-}" ]] && kill "$SERVER_PID" 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT

echo "▶ server tests"
npm test --silent > "$TMP/tests.log" 2>&1 || { tail -40 "$TMP/tests.log"; exit 1; }
grep -E '^# (pass|fail)' "$TMP/tests.log"

echo "▶ build"
npm run build --silent > /dev/null

echo "▶ starting a throwaway server on :$PORT"
PORT="$PORT" SQLITE_FILE="$TMP/verify.db" ADMIN_EMAILS=mod@e2e.test AUTH_RATE_LIMIT=1000 \
  node --disable-warning=ExperimentalWarning server/src/index.js > "$LOG" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 50); do curl -fs "http://localhost:$PORT/api/health" > /dev/null && break; sleep 0.2; done

echo "▶ e2e"
SHOTS_DIR="${SHOTS_DIR:-}" BASE_URL="http://localhost:$PORT" MOD_EMAIL=mod@e2e.test MAIL_LOG="$LOG" node e2e/smoke.mjs
echo "▶ accessibility"
BASE_URL="http://localhost:$PORT" node e2e/a11y.mjs | tail -1
echo "✅ all checks passed"
