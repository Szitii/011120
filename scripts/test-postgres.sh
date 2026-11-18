#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?Set DATABASE_URL to a disposable PostgreSQL database.}"
if [[ "${COMPANION_SOCIAL_TEST_DATABASE:-}" != "1" ]]; then
  echo "Refusing to initialize PostgreSQL without COMPANION_SOCIAL_TEST_DATABASE=1." >&2
  exit 2
fi

existing_relations="$(psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 -Atqc "select count(*) from pg_class where relnamespace = 'public'::regnamespace and relkind in ('r', 'p')")"
if [[ "${existing_relations}" != "0" ]]; then
  echo "Refusing to run against a database whose public schema already contains tables." >&2
  exit 2
fi

psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 -f tests/postgres/bootstrap.sql
for migration in supabase/migrations/*.sql; do
  psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 -f "${migration}"
done
psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 -f tests/postgres/security-contract.sql
node --experimental-strip-types tests/postgres/adapter-runtime.ts
