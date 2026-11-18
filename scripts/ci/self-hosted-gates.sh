#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

for command in node npm docker psql curl grep; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Missing required command: $command" >&2
    exit 2
  fi
done

node_major="$(node -p 'process.versions.node.split(".")[0]')"
if [[ "$node_major" -lt 24 ]]; then
  echo "Node 24+ required; found $(node --version)." >&2
  exit 2
fi

container="companion-social-ci-postgres-${GITHUB_RUN_ID:-local}-$$"
postgres_port="${COMPANION_SOCIAL_CI_POSTGRES_PORT:-55432}"
postgres_password="postgres"
postgres_db="companion_social"
api_pid=""

cleanup() {
  if [[ -n "$api_pid" ]]; then
    kill "$api_pid" 2>/dev/null || true
    wait "$api_pid" 2>/dev/null || true
  fi
  docker rm -f "$container" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

echo "== Foundation / OpenAPI / coverage =="
npm ci
npm run check

echo "== Root production dependency audit =="
npm audit --omit=dev

echo "== Mobile typecheck / tests / Expo exports =="
npm install --prefix apps/mobile --ignore-scripts
npm run check --prefix apps/mobile
npm run export:ci --prefix apps/mobile
npm run export:web:ci --prefix apps/mobile

echo "== PostgreSQL 17 contract =="
docker run -d --rm   --name "$container"   -e POSTGRES_DB="$postgres_db"   -e POSTGRES_PASSWORD="$postgres_password"   -p "127.0.0.1:${postgres_port}:5432"   postgres:17 >/dev/null

ready=0
for attempt in $(seq 1 60); do
  if docker exec "$container" pg_isready -U postgres -d "$postgres_db" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [[ "$ready" -ne 1 ]]; then
  docker logs "$container" >&2 || true
  echo "PostgreSQL 17 did not become ready." >&2
  exit 1
fi

export PGPASSWORD="$postgres_password"
export DATABASE_URL="postgresql://postgres:${postgres_password}@127.0.0.1:${postgres_port}/${postgres_db}"
export COMPANION_SOCIAL_TEST_DATABASE=1
bash scripts/test-postgres.sh

echo "== Disposable mobile dev database =="
mobile_db="companion_social_mobile_dev_ci"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "create database ${mobile_db}"
export DATABASE_URL="postgresql://postgres:${postgres_password}@127.0.0.1:${postgres_port}/${mobile_db}"
export COMPANION_SOCIAL_DEV_DATABASE=1
npm run dev:mobile:db:init

echo "== Stage 1 mobile HTTP smoke =="
export MOBILE_DEV_HOST=127.0.0.1
export MOBILE_DEV_PORT="${COMPANION_SOCIAL_CI_MOBILE_PORT:-18787}"
export MOBILE_DEV_OWNER_TOKEN=companion-social-stage1-owner
export MOBILE_DEV_API_BASE_URL="http://127.0.0.1:${MOBILE_DEV_PORT}"

npm run dev:mobile:api >/tmp/companion-social-mobile-dev-api.log 2>&1 &
api_pid=$!

api_ready=0
for attempt in $(seq 1 30); do
  if curl -fsS "${MOBILE_DEV_API_BASE_URL}/healthz" >/tmp/companion-social-mobile-health.json; then
    api_ready=1
    break
  fi
  sleep 1
done
if [[ "$api_ready" -ne 1 ]]; then
  cat /tmp/companion-social-mobile-dev-api.log >&2 || true
  exit 1
fi

auth=(-H "Authorization: Bearer ${MOBILE_DEV_OWNER_TOKEN}")
curl -fsS "${auth[@]}"   "${MOBILE_DEV_API_BASE_URL}/v0/identity-context"   | grep -q '"kind":"OWNER"'

curl -fsS "${auth[@]}"   "${MOBILE_DEV_API_BASE_URL}/v0/world-items?limit=20"   | grep -q '"displayName":"AnotherSample"'

curl -fsS "${auth[@]}"   "${MOBILE_DEV_API_BASE_URL}/v0/life-continuity?limit=30&activeSubjectKind=OWNER"   | grep -q '"kind":"ENCOUNTER"'

curl -fsS "${auth[@]}"   "${MOBILE_DEV_API_BASE_URL}/v0/companions/00000000-0000-0000-0000-0000000002a1/profile?activeSubjectKind=OWNER"   | grep -q '"relationship":"OWNER_OF"'

npm run test:mobile:residency

echo "All self-hosted fallback gates passed."
