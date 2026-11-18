# ADR-0005: Selective permissive adoption; legal gates for AGPL/BSL

- **Status:** Accepted
- **Date:** 2026-09-12

## Context

The radar includes mature AGPL applications, a BUSL Companion runtime, permissive libraries, and a no-license character-card specification. Repository-level license labels may differ from actual files or subdirectories. Whole-product forks also import domain assumptions unrelated to Companion Social Platform.

## Decision

Prefer MIT, Apache-2.0, and BSD components as pinned dependencies or selectively attributed code. Do not copy AGPL, BUSL/BSL, unlicensed, or separately licensed enterprise code without a written legal evaluation and a superseding adoption ADR. A full-product fork requires proof of domain fit, license fitness, security fit, deletion cost, and exit path.

## Consequences

Yuralume, SillyTavern, LettuceAI, Mastodon, and the unlicensed Character Card repository are reference-only under the current decision. YuriOS and mobile apps may inform or supply narrow permissively licensed implementations after file-level review. Automated SBOM/license scanning is a release gate.

## Security and privacy

Permissive licensing does not imply security fitness. Cryptography, secret storage, authentication, authorization, parsers, and sandboxing receive independent review and may not be copied solely because the license allows it.

## Portability and reversal

Internal interfaces and canonical PostgreSQL state make dependencies replaceable. A component with changed licensing can be removed without surrendering identity, memory permissions, or compute history.

## Constitution impact

Protects project direction from upstream architecture; no principle is amended.
