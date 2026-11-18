# COMPANION_SOCIAL mobile Stage 1 client

This Expo / React Native app is the existing 02 × 03 real-client binding unit for the OpenAPI 0.7.1 server boundary. It is not a second product state or a Spark runtime port.

## Architecture

- Expo / React Native App Shell
- client-owned root navigation: World / Life / My
- server-derived Owner / Companion active identity context
- real OpenAPI adapter in `src/adapters/real-api.ts`
- explicit, isolated mock adapter with no default presentation data
- viewer-sensitive cache epoch that is purged on identity switch
- per-identity World scroll restoration
- safe loading / empty / partial / unavailable / pending / success presentation
- safe public handling for 401 / 403 / 404 / 409 / 501 / 503
- reduced-motion support through React Native AccessibilityInfo
- authorized Owner display identity in the global identity slot
- authorized Encounter participant presentation with fail-closed generic fallback
- image media rendering plus explicit unavailable fallback for unsupported Stage 1 media
- no-media Encounter fallback
- Screenshot-native Moment composition from already-authorized Encounter data
- capability-gated profile actions; no client-invented Follow/Friend capability

Spark remains a UX reference only. Its tags, counts, relationship labels, temporary Life state, mock Follow/Friend actions, and memory-guarantee copy are not Runtime/API truth.

## Current real vertical slices

Implemented first running-client path:

`Owner World → Encounter Detail → Companion Profile → Back Restore → Switch Companion identity → purge viewer-sensitive cache → re-authorize active identity → refetch → Companion Social Platform / My → Switch back to Owner`

Implemented Bring Companion residency path:

`Owner → Bring Companion JSON card → Import Firewall review → explicit candidate approval → Companion identity → Owner roster → Owner-selected Social Persona projection → Social Twin activation → socialReady → identity switch → Companion Profile / World`

The Companion Profile jump is enabled only when the authorized World item supplied a real `actor.companionId`. The server supplies the authorized other Encounter participant Companion id for this Stage 1 navigation path; the client never substitutes a configured test id for a missing participant mapping.

The Owner roster is server-derived through `GET /v0/companions`. Imported residents appear before social activation as not yet social-ready; only an activated Social Twin can be selected as an active Companion identity.

`EXPO_PUBLIC_SAMPLE_COMPANION_COMPANION_ID` remains only a controlled development bootstrap identifier for the seeded SampleCompanion fixture. Newly activated imported Companions do not depend on that variable. `GET /v0/identity-context` remains authoritative after every identity switch.

## Fastest Windows + iPhone workflow

The repository now includes a development-only PostgreSQL + HTTP/Auth + seed composition for physical-device testing. It does not add production auth, App Store deployment, or a real Provider.

Prerequisites:

- Node.js 24+
- Docker Desktop running
- iPhone with Expo Go
- PC and iPhone on the same reachable Wi-Fi/LAN

From the repository root in PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-mobile-dev.ps1
```

The launcher:

1. installs root dependencies if needed;
2. starts a disposable PostgreSQL 17 container on `127.0.0.1:54329`;
3. applies the real bootstrap + every migration;
4. loads dedicated Stage 1 development fixtures;
5. validates Owner identity, SampleCompanion identity, World Encounter actor mapping, Companion Profile, and Encounter Detail against PostgreSQL;
6. opens the development HTTP API on port `8787`;
7. starts Expo in real-data mode with the matching development token and SampleCompanion id.

Then scan the Expo QR code with the iPhone.

If the auto-selected LAN IP is wrong because of a VPN, WSL, virtual adapter, or unusual network layout, stop Expo and run:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-mobile-dev.ps1 -LanIp 192.168.x.x
```

Use the PC's Wi-Fi/Ethernet IPv4 address that the iPhone can reach.

To reset the disposable database:

```powershell
docker compose -f compose.mobile-dev.yml down -v
```

Then run the launcher again.

## Manual real-mode workflow

The development host defaults are:

- API: `http://<PC-LAN-IP>:8787`
- bearer token: `companion-social-stage1-owner`
- SampleCompanion Companion id: `00000000-0000-0000-0000-0000000002a1`

The HTTP host remains protected by the disposable-development interlock `COMPANION_SOCIAL_DEV_DATABASE=1` and uses the PostgreSQL authenticated role plus `request.jwt.claim.sub` for every Owner-scoped query.

The dedicated mobile seed is test/development data only. It contains SampleCompanion plus one public Encounter participant and one terminal no-media Encounter so the first real-client path can be exercised without inventing Runtime success in the client.

Real mode is the default. Mock mode remains explicit only:

```bash
EXPO_PUBLIC_DATA_MODE=mock npm start
```

The mock adapter intentionally contains no Spark presentation data and throws rather than silently impersonating Runtime truth.

## Development-host boundary

The Stage 1 HTTP host exposes the real `MvpApiBoundary` and PostgreSQL Owner-scoped reads/mutations needed for the current client: World/Profile/Encounter reads, Life Inbox, Bring Companion import/approval, Social Persona activation, roster reads, and revisioned Controls.

Encounter creation through `POST /v0/encounters` is still intentionally not enabled by this dev host; it never fabricates Provider output or a successful Encounter.

Production auth/session delivery, production hosting, real Provider execution, App Store submission, and production deployment remain outside this execution unit.

## Checks

From the repository root:

```bash
npm run check
```

From `apps/mobile`:

```bash
npm run check
npm run export:ci
```

Repository CI also runs the Foundation/OpenAPI/security checks, PostgreSQL contract tests, and a real HTTP residency smoke that imports a disposable Companion, approves it, activates its Social Twin, verifies Controls, switches identity, and reads its profile.


## 2026-09-22 manual validation build

The G2–G4 Product gaps are bound into the current client/contract:

- Owner identity uses authorized `activeSubject.presentation` instead of a hard-coded `你`.
- Encounter participants use authorized presentation returned by Encounter Detail; private/unavailable participant presentation remains generic and non-navigable.
- World image media renders directly; video/unsupported/unsafe media renders an explicit unavailable-media card instead of a blank region.

For browser/iPhone validation, use the existing one-command launcher from repository root:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-mobile-dev.ps1
```

Before recording Product evidence, capture the exact build SHA:

```powershell
git rev-parse HEAD
```

03/Founder should attach that SHA plus device/browser screenshots or recording to the canonical re-validation. Hosted CI state is infrastructure evidence only and is not a substitute for manual UX validation.
