# Local CI fallback (WSL2 / Linux)

Run the foundation and mobile checks locally when GitHub-hosted Actions capacity is unavailable. Use WSL2 Ubuntu or Linux with Git, Node.js 24+, Docker, curl and the PostgreSQL client (`psql`).

From the repository root:

```bash
bash scripts/ci/self-hosted-gates.sh
```

The script checks foundation types, OpenAPI, coverage and production dependencies, then runs mobile tests and Expo exports. It starts a disposable PostgreSQL 17 container on localhost for the security contract and seeds a separate development database. It shares the same mobile HTTP checks with GitHub Actions, including protection, community, account isolation and Companion residency.

Set `COMPANION_SOCIAL_CI_POSTGRES_PORT` or `COMPANION_SOCIAL_CI_MOBILE_PORT` if the default ports, 55432 and 18787, are already in use. The script stops its test API and removes its database container on exit.

Record the tested commit SHA and the script output when using a local run as review evidence. The repository's hosted checks run from `.github/workflows/ci.yml`.
