# Self-hosted CI fallback (WSL2 / Linux)

Status: Stage 1 CI infrastructure fallback. This does not change test standards or product scope.

## Why this exists

GitHub-hosted Actions jobs have recently failed before any step starts (`steps: null`), which is consistent with a hosted-runner quota/budget/startup problem rather than a known code or SQL failure.

The fallback keeps the same gates while moving execution to a Linux self-hosted runner that does not consume GitHub-hosted Actions minutes.

## Recommended lowest-cost setup

Use the developer Windows machine with **WSL2 Ubuntu** as the primary fallback runner.

Required on the WSL2 distro:

- Git
- curl
- Node.js 24+
- Docker Engine / Docker Desktop WSL integration
- PostgreSQL client (`psql`)
- enough disk space for npm dependencies and Expo exports

The runner must be registered to `ProjectOwner/companion-social` with the custom label:

`companion-social-ci`

The workflow also requires the standard self-hosted labels:

`self-hosted`, `Linux`, `X64`.

Do not commit the runner registration token. Obtain a short-lived registration token from GitHub when installing the runner.

## One-time WSL2 preparation

Example packages:

```bash
sudo apt update
sudo apt install -y git curl postgresql-client
node --version   # must be 24+
docker version   # must work from this WSL distro
psql --version
```

Install the official GitHub Actions runner using the current commands shown by GitHub under:

Repository Settings → Actions → Runners → New self-hosted runner → Linux → x64

During `config.sh`, add the label:

```text
companion-social-ci
```

Prefer installing the runner as a service so CI can run without an open shell.

## Workflow

`.github/workflows/self-hosted-ci.yml`

Triggers:
- push to `main`
- pull requests
- manual `workflow_dispatch`

It runs only on:

```yaml
runs-on: [self-hosted, Linux, X64, companion-social-ci]
```

If no matching runner is online, the job queues rather than silently falling back to GitHub-hosted minutes.

## Gate parity

The workflow calls:

`bash scripts/ci/self-hosted-gates.sh`

That script preserves the existing Stage 1 gates:

1. `npm ci`
2. Foundation typecheck
3. OpenAPI validation
4. Foundation coverage thresholds
5. root production dependency audit
6. Mobile dependency install
7. Mobile TypeScript + tests
8. Expo iOS export
9. Expo Web export
10. PostgreSQL 17 security/runtime contract
11. disposable mobile dev database initialization
12. Stage 1 HTTP smoke
13. Companion residency smoke

PostgreSQL 17 runs in a disposable Docker container bound to localhost only and is removed on exit.

## Security / operations

- Keep the runner dedicated to this repository if possible.
- Do not expose the runner host to untrusted public repositories.
- Never place GitHub registration tokens or repository secrets in committed files.
- Treat pull-request execution carefully if external contributors are ever enabled; self-hosted runners execute repository code on the local machine.
- The fallback does not imply production deployment or production credentials.
- Keep the existing GitHub-hosted workflow unchanged. When hosted capacity returns, both paths can provide evidence; the self-hosted path exists to prevent hosted-minute exhaustion from blocking Stage 1.

## Evidence standard

A successful fallback run must record:
- exact commit SHA;
- self-hosted workflow run ID;
- `full-gates = success`;
- Foundation test count and coverage;
- Mobile test count;
- audit result;
- PostgreSQL contract result;
- Expo iOS/Web export result;
- HTTP/residency smoke result.

Until a self-hosted runner is actually registered and a run completes, the fallback is **configured but not yet proven green**.
