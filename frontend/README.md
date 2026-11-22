# COMPANION_SOCIAL mobile Stage 1 client

This Expo / React Native app is the existing 02 × 03 real-client binding unit for the OpenAPI 0.7.1 server boundary. It is not a second product state or a Spark runtime port.

## Architecture

- Expo / React Native App Shell
- client-owned root navigation: Public Community / Private Home / My
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

## Supabase sign-in for internal testers

For a dedicated test Supabase project:

1. Apply all repository migrations in `backend/supabase/migrations`. Enable email/password Auth and disable public signup in the project settings, then invite testers by email through Supabase Auth. Disabling public signup is what keeps the beta invite-only.
2. A tester's first signed-in request creates their Owner automatically (`public.claim_owner()`, migration `202611220033`). Only to attach a tester to existing seeded test data, set that Owner's `public.owners.auth_user_id` to their Supabase user UUID before they first sign in. Suspending an Owner (`status = 'SUSPENDED'`) blocks access; signing in again does not reactivate it.
3. Start the authenticated API from the repository root with `npm run start:mobile:api`. Set `DATABASE_URL`, `SUPABASE_URL`, and `SUPABASE_PUBLISHABLE_KEY`. The backend database login must be a member of role `companion_api` (migration `202611220036` grants it to the role that runs migrations; run `grant companion_api to <login>;` if the API uses another login). The API listens on `127.0.0.1:8787` by default. Set `MOBILE_API_HOST` and `MOBILE_API_PORT` as needed. Use an HTTPS endpoint reachable from the iPhone or Web client.
4. Start or export Expo with the following public environment variables. Use the publishable key or legacy anon key for the same test project.

   ```bash
   EXPO_PUBLIC_DATA_MODE=real
   EXPO_PUBLIC_API_BASE_URL=https://api.example.test
   EXPO_PUBLIC_SUPABASE_URL=https://your-test-project.supabase.co
   EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY=your-test-publishable-key
   ```

Supabase Auth manages password sign-in and token refresh. The mobile API verifies the bearer with Supabase Auth before resolving the active Owner under PostgreSQL RLS. The mobile app persists the session in native SecureStore or browser localStorage. In **我的 → 退出登录或切换账号**, sign out of this device and enter the other tester's credentials. The login screen is limited to sign-in.

Real mode is the default and requires both API and Supabase configuration. Loopback HTTP is supported for local tests. The fixed-bearer path requires explicit `dev` mode and the development host.

### iPhone acceptance checks

Use an iPhone build configured for the test API and test Supabase project above. Record the build commit, iOS version and outcome for each step.

1. Sign in as tester A. Verify the human identity and its Companion roster. Publish a short test post as A. Select an authorized Companion, then verify that the three main tabs still work.
2. Force-quit and reopen the app. Verify that the account restores under A and only A's roster is available. Send the app to the background and reopen it after the test access token's expiry time. Verify that requests succeed again with the refreshed session.
3. Leave a community draft, open **我的 → 退出登录或切换账号** and sign in as tester B. Verify that the draft is empty, the starting identity is B, and the identity picker shows only B's Companions.
4. Have B follow A. Verify that A’s test post appears in B’s human following feed and that A receives a follow notification from B. Check that B’s Companion following feed omits the post and that neither B nor A’s Companion can see A’s notification.
5. Sign out B, then force-quit and reopen. Verify that the login screen persists. For the expiry recovery check, revoke a test session from Supabase and attempt to refresh the community page. Verify that the app returns to login and the account can sign in again.

## Fastest Windows + iPhone workflow

The local launcher uses a development-only PostgreSQL, API and seed configuration for physical-device testing.

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
7. starts Expo in explicit `dev` mode with the matching development token and SampleCompanion id.

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

## Local development configuration

The development host defaults are:

- API: `http://<PC-LAN-IP>:8787`
- bearer token: `companion-social-stage1-owner`
- SampleCompanion Companion id: `00000000-0000-0000-0000-0000000002a1`

The HTTP host remains protected by the disposable-development interlock `COMPANION_SOCIAL_DEV_DATABASE=1` and uses the PostgreSQL authenticated role plus `request.jwt.claim.sub` for every Owner-scoped query.

The dedicated mobile seed is test/development data only. It contains SampleCompanion plus one public Encounter participant and one terminal no-media Encounter so the first real-client path can be exercised without inventing Runtime success in the client.

To use the separate mock adapter:

```bash
EXPO_PUBLIC_DATA_MODE=mock npm start
```

The mock adapter intentionally contains no Spark presentation data and throws rather than silently impersonating Runtime truth.

## Development-host boundary

The Stage 1 HTTP host exposes the real `MvpApiBoundary` and PostgreSQL Owner-scoped reads/mutations needed for the current client: World/Profile/Encounter reads, Life Inbox, Bring Companion import/approval, Social Persona activation, roster reads, and revisioned Controls.

Encounter creation through `POST /v0/encounters` is still intentionally not enabled by this dev host; it never fabricates Provider output or a successful Encounter.



## Checks

From the repository root:

```bash
npm run check
```

From `frontend`:

```bash
npm run check
npm run export:ci
npm run export:web:ci
```

Repository CI also runs the Foundation and PostgreSQL security checks, the community HTTP suite, an account isolation contract against PostgreSQL with an Auth HTTP test double, and the development residency smoke.

To run the account contract against real Auth, set `COMPANION_SOCIAL_REAL_AUTH_TEST=1`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `AUTH_TEST_EMAIL_A`, `AUTH_TEST_PASSWORD_A`, `AUTH_TEST_EMAIL_B`, and `AUTH_TEST_PASSWORD_B`. Use a disposable database with the mobile seed's domain rows and Owner IDs linked to the two real Auth user IDs. Create the Auth users through Supabase and use their IDs in place of the placeholder subjects in the fixture. Run from the repository root:

```bash
# Point DATABASE_URL at the disposable seeded database.
COMPANION_SOCIAL_DEV_DATABASE=1 node --experimental-strip-types backend/db-tests/account-runtime.ts
```

The real-Auth run adds password grants, refresh-token rotation, device logout and rejection of revoked sessions to the isolation checks. With a disposable Auth instance issuing JWTs with a lifetime of 5–30 seconds, set `AUTH_TEST_VERIFY_TOKEN_EXPIRY=1` to also verify a naturally expired bearer and refresh back into the same Owner.


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
