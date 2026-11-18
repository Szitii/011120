# ADR-0002: Expo/React Native + Supabase + API-first backend

- **Status:** Accepted
- **Date:** 2026-09-12

## Context

V0 needs iOS and Android quickly, with useful web sharing, while keeping security-sensitive policy outside clients. Supabase provides PostgreSQL, Auth, RLS, Storage, Realtime, and pgvector without assembling many operators. Boilerplate inspection found useful patterns but no suitable social domain base.

## Decision

Start from the official Expo/React Native TypeScript scaffold. Use Expo Router, TanStack Query, and a small local store only for true client state. Use Supabase as the data platform, accessed through both RLS-protected safe projections and a dedicated Fastify API. Keep a lightweight landing site independently deployable.

Do not adopt a boilerplate wholesale. Obytes, Bluesky, Rocket.Chat, Ignite, and Wataru are pattern sources subject to file-level license and attribution review.

## Consequences

Mobile platforms share most presentation and domain-client code. Native escape hatches remain available. The backend is explicit rather than hidden in client SDK calls. RLS policies and generated OpenAPI types become first-class test targets.

## Security and privacy

Private memory, imports, provider calls, DLP, and compute operations go through the API. Realtime emits safe identifiers/projections only. Service keys never ship in a client.

## Portability and reversal

PostgreSQL and OpenAPI limit vendor lock-in. Supabase services can be self-hosted or replaced incrementally. Expo prebuild/native projects remain an escape route if platform requirements demand it.

## Constitution impact

Implements API-first enforcement and cross-platform reach; no principle is amended.
