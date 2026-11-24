#!/usr/bin/env bash
set -euo pipefail

for suite in protection community account agent chat home memory connection wallet heartbeat admin autopost companion; do
  node --experimental-strip-types "backend/db-tests/${suite}-runtime.ts"
done

export MOBILE_DEV_HOST=127.0.0.1
export MOBILE_DEV_PORT="${MOBILE_DEV_PORT:-8787}"
export MOBILE_DEV_OWNER_TOKEN=companion-social-stage1-owner
export MOBILE_DEV_API_BASE_URL="http://127.0.0.1:${MOBILE_DEV_PORT}"

api_log="$(mktemp)"
node --experimental-strip-types backend/src/dev/mobile-http-server.ts >"$api_log" 2>&1 &
api_pid=$!
cleanup() {
  kill "$api_pid" 2>/dev/null || true
  wait "$api_pid" 2>/dev/null || true
  rm -f "$api_log"
}
trap cleanup EXIT

for attempt in {1..30}; do
  if grep -q "Stage 1 mobile dev API listening" "$api_log" &&
    curl -fsS "${MOBILE_DEV_API_BASE_URL}/healthz" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$api_pid" 2>/dev/null || [[ "$attempt" -eq 30 ]]; then
    cat "$api_log" >&2
    exit 1
  fi
  sleep 1
done

check_response() {
  local path="$1" expected="$2"
  if ! curl -fsS -H "Authorization: Bearer ${MOBILE_DEV_OWNER_TOKEN}" "${MOBILE_DEV_API_BASE_URL}${path}" | grep -F "$expected" >/dev/null; then
    echo "Unexpected Stage 1 response for $path (expected $expected)." >&2
    exit 1
  fi
}

check_response '/v0/identity-context' '"kind":"OWNER"'
check_response '/v0/world-items?limit=20' '"displayName":"AnotherSample"'
check_response '/v0/life-continuity?limit=30&activeSubjectKind=OWNER' '"kind":"ENCOUNTER"'
check_response '/v0/companions/00000000-0000-0000-0000-0000000002a1/profile?activeSubjectKind=OWNER' '"relationship":"OWNER_OF"'
npm run test:mobile:residency
