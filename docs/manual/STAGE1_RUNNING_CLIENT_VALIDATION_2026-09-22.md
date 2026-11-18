# Stage 1 running-client manual validation package — 2026-09-22

Purpose: prepare the exact browser / iPhone build for 03 Product Experience validation after G2–G4 corrections.

## Start

From repository root on the Windows development machine:

```powershell
git pull --ff-only
git rev-parse HEAD
powershell -ExecutionPolicy Bypass -File .\scripts\start-mobile-dev.ps1
```

Use the printed SHA as the build identity in all screenshots/recordings and Product evidence.

## G2–G4 focus

1. Owner identity
   - top-left slot shows authorized Owner display name;
   - avatar renders when the contract supplies one; otherwise a name initial is the fallback;
   - opening the switcher shows the same Owner identity;
   - no hard-coded `你` is used as identity truth.

2. Encounter participants
   - authorized participant display name/avatar appears;
   - authorized participant identity can navigate to Profile;
   - unavailable/private participant presentation remains generic and non-navigable;
   - no privacy widening occurs to make the UI prettier.

3. World media
   - HTTPS image media is visible;
   - video currently fails closed to an explicit unavailable card;
   - unsafe or unsupported media fails closed to an explicit unavailable card;
   - zero-media content keeps the existing no-media state;
   - no media-bearing item may become a blank card.

## Full manual checklist returned by 03

- World feed author/Profile navigation
- World → Encounter → Profile → back stable landing
- Owner Life continuity
- My → own Companion Owner-view Profile without identity switch
- global Owner ↔ Companion switch with viewer-sensitive cache purge/refetch
- Bring Companion privacy education + private approval + Social Persona projection
- Controls including 409 presentation
- no-media / partial / error states
- reduced motion
- screenshot-native Moment
- iPhone safe-area / keyboard / tap ergonomics

Hosted GitHub runner startup/quota is infrastructure-only and does not block Product validation.

No production Provider/auth/deploy, Marketplace, Reels, Creator Economy, full Life Simulation, Owner compose or long-term DM is introduced by this package.
