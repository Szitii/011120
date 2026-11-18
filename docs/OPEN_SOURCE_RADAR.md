# Open Source Component Radar

**Snapshot date:** 2026-09-12
**Decision status:** Research baseline; every adopted dependency still requires version pinning, SBOM, security review, and license verification.
**Evaluation question:** Does the component help Companion Social Platform build durable identity, relationships, social life, and portability without weakening the Project Constitution?

## Method

The radar combines repository metadata with code-level inspection. For the four named Companion projects and five mobile candidates, the repository was cloned and inspected at the commit shown below. We reviewed directory structure, manifests, licenses, persistence models, core flows, and tests—not only README files.

Stars and last activity are volatile health signals, not quality guarantees. License conclusions are engineering triage, not legal advice. Before shipping, an automated license/SBOM scan and counsel review are mandatory for any copyleft, source-available, ambiguous, or dual-licensed component.

### Decision vocabulary

- **Use/pilot:** consume a pinned release behind our interface; do not fork by default.
- **Selective reuse:** permissively licensed code or patterns may be ported with attribution and tests.
- **Reference only:** learn from architecture/protocol behavior; do not copy code.
- **Reject:** conflicts with the Constitution, license, security posture, or V0 scope.

## Executive conclusion

Do not fork Yuralume, YuriOS, SillyTavern, LettuceAI, Bluesky, Rocket.Chat, or a generic boilerplate as the Companion Social Platform product base. Build a small domain-first modular monolith and selectively consume permissive libraries. Of the mobile starters, Obytes is the closest scaffold reference, but a clean Expo app with selected patterns has a lower deletion cost than inheriting an unrelated product architecture.

The most reusable ideas are:

- Yuralume's scheduled-life candidate pipeline and explicit usage recording;
- YuriOS's quarantined imports, rebuildable memory index, bounded character-card parser, and export canaries;
- SillyTavern's provider/card interoperability tests, but not its trust model;
- LettuceAI's local memory lifecycle and provider test matrix, but not its AGPL code;
- Bluesky's typed feed queries, optimistic mutations, moderation selection, and notification cache;
- Rocket.Chat's local optimistic DM state machine and offline/error UX;
- Presidio plus deterministic detectors for PII/DLP, with policy enforcement owned by Companion Social Platform;
- PostgreSQL/pgvector and RLS rather than a separate V0 vector database.

## Candidate matrix

Metadata below is a point-in-time snapshot from GitHub on 2026-09-12.

| Module | Project | Activity | Stack | License / commercial constraint | Reusable scope | Architecture reference only | Principal risks | Fork? |
|---|---|---:|---|---|---|---|---|---|
| Companion runtime, life | [Yuralume Core](https://github.com/Yuralume/yuralume-core) | 32★; pushed 2026-08-28 | Python 3.13, FastAPI, SQLAlchemy, PostgreSQL/pgvector, Vue | BUSL-1.1; production use limited to noncommercial unless separately licensed; version converts later per license | No code for commercial V0 without license | Candidate scheduling, fail-soft jobs, salience/feed scoring, usage receipts | Monolithic character row; single-owner assumptions; bespoke secret cipher; license | **No** |
| Companion runtime, import/export | [YuriOS](https://github.com/yuri-os/YuriOS) | 14★; pushed 2026-09-03 | Python, FastAPI, SQLite, filesystem/Git vault | Apache-2.0 | Bounded card parsing and privacy-test patterns may be ported with attribution | File-as-source-of-truth vault, rebuildable vector cache, quarantined partner edits | Very young/small; local single-user design; limited hosted/multi-tenant evidence | **No full fork** |
| Character card, BYOK, frontend | [SillyTavern](https://github.com/SillyTavern/SillyTavern) | 33,284★; pushed 2026-09-07 | Node/Express, browser JavaScript, filesystem | AGPL-3.0; network deployment creates source obligations | None planned | Provider/card compatibility and power-user UX | Imported prompt fields are trusted too deeply; memory is prompt summarization, not permissions; AGPL | **No** |
| Companion runtime, memory, BYOK | [LettuceAI](https://github.com/LettuceAI/app) | 131★; pushed 2026-09-12 | React/Vite, Tauri 2, Rust, SQLite | AGPL-3.0 | None planned | Memory lifecycle, usage schema, provider URL/header tests | Local app, no multi-owner social authorization; AGPL; young | **No** |
| Social feed/profile/follow/comment/notification | [Bluesky Social App](https://github.com/bluesky-social/social-app) | 18,288★; pushed 2026-09-11 | TypeScript, React Native, Expo, TanStack Query | MIT | Query/cache/moderation patterns and small utilities after review | AT Protocol schemas, optimistic follow, paginated feed and unread separation | Large protocol-specific app; federation complexity; incompatible domain ownership | **No full fork** |
| DM/notification/offline | [Rocket.Chat React Native](https://github.com/RocketChat/Rocket.Chat.ReactNative) | 2,412★; pushed 2026-09-11 | TypeScript, React Native, Expo modules, WatermelonDB, native iOS/Android | MIT | Local message state-machine patterns after review | Optimistic TEMP→SENT/ERROR, offline sync, push, E2EE UX | Strong Rocket.Chat server coupling; legacy state stacks; native burden | **No full fork** |
| Mobile scaffold | [Obytes React Native Template](https://github.com/obytes/react-native-template-obytes) | 4,339★; pushed 2026-06-02 | TypeScript, Expo Router, TanStack Query, Zustand, Uniwind | MIT | Feature layout, CI/EAS, testing, i18n patterns | Its sample feed is demo CRUD, not a social domain | Opinionated dependencies; template drift; false sense of backend completeness | **Conditional scaffold only** |
| Mobile scaffold | [Ignite](https://github.com/infinitered/ignite) | 19,939★; pushed 2026-06-07 | TypeScript, React Native/Expo, React Navigation, MMKV | MIT | Generators, navigation/testing conventions | Dependency boundaries and upgrade practices | More ceremony than V0 needs; not Expo Router/social specific | **No; reference** |
| Mobile scaffold | [React Native Boilerplate](https://github.com/wataru-maeda/react-native-boilerplate) | 516★; pushed 2026-09-10 | TypeScript, Expo Router, Redux Toolkit, EAS | MIT | Environment and CI examples | Minimal screen/store organization | Smaller proof base; Redux overhead; sample data only | **No; reference** |
| Federated social backend | [Mastodon](https://github.com/mastodon/mastodon) | 50,297★; pushed 2026-09-12 | Ruby/Rails, PostgreSQL, Redis, Sidekiq | AGPL-3.0 | None planned | Mature follows, timelines, moderation, notifications | Federation and human-account assumptions; AGPL; operational weight | **No** |
| Long-term memory | [Mem0](https://github.com/mem0ai/mem0) | 65,176★; pushed 2026-09-11 | Python/TypeScript ecosystem | Apache-2.0 | Pilot behind our `MemoryEngine` interface | Extraction/dedup/update pipelines | A remembered fact is not an authorization grant; hosted telemetry/data terms require separate review | **No; dependency pilot** |
| Stateful agents/memory | [Letta](https://github.com/letta-ai/letta) | 24,712★; pushed 2026-09-10 | Python, agent server | Apache-2.0 | Evaluate isolated runtime concepts | Agent state and archival memory | Agent-centric schema may swallow Companion Identity; operational scope | **No; evaluate** |
| Long-term memory | [LangMem](https://github.com/langchain-ai/langmem) | 1,660★; pushed 2026-09-09 | Python | MIT | Evaluate extraction/reconciliation utilities | Semantic/procedural memory organization | LangGraph coupling; no social permission semantics | **No; dependency pilot** |
| Social/graph memory | [Cognee](https://github.com/topoteretes/cognee) | 30,656★; pushed 2026-09-12 | Python, graph/vector pipelines | Apache-2.0 | Research graph projection outside source-of-truth | Entity/relationship graph retrieval | Extra stores and consistency burden; permissions still ours | **No in V0** |
| Provider router/BYOK | [LiteLLM](https://github.com/BerriAI/litellm) | 58,563★; pushed 2026-09-12 | Python proxy/library | MIT outside separately licensed `enterprise/` tree | Strong candidate as isolated provider gateway | Normalized model/provider API, budgets/fallbacks | Fast-moving dependency; enterprise boundary; gateway is not our compute ledger | **No; pin dependency/service** |
| Provider router/BYOK | [Portkey Gateway](https://github.com/Portkey-AI/gateway) | 12,972★; pushed 2026-05-25 | TypeScript | MIT | Evaluate gateway adapter | Routing, retries, observability | Another policy plane; hosted terms and data path need review | **No; evaluate** |
| Prompt injection/DLP | [LLM Guard](https://github.com/protectai/llm-guard) | 3,205★; pushed 2026-07-08; archived | Python | MIT | Reuse only pinned scanners after benchmark | Scanner composition | Archived; classifier bypasses; latency | **No; selective only** |
| LLM safety | [NeMo Guardrails](https://github.com/NVIDIA-NeMo/Guardrails) | 7,107★; pushed 2026-09-11 | Python | Apache-2.0 | Evaluate for selected policy flows | Input/output rail composition | Complex DSL/runtime; cannot enforce DB permissions | **No; evaluate** |
| PII/DLP | [Presidio](https://github.com/data-privacy-stack/presidio) | 10,826★; pushed 2026-09-10 | Python, NLP services | MIT | Pilot analyzer/anonymizer with custom recognizers | Detection/anonymization service boundary | False positives/negatives; language/model coverage; requires deterministic secret detectors | **No; dependency pilot** |
| Safety evaluation | [Promptfoo](https://github.com/promptfoo/promptfoo) | 25,045★; pushed 2026-09-12 | TypeScript | MIT | Use in CI/red-team suites | Attack/evaluation corpus organization | Evaluation only, not runtime protection | **No; dev dependency** |
| Injection protection | [Arcjet JS](https://github.com/arcjet/arcjet-js) | 682★; pushed 2026-09-11 | TypeScript | Apache-2.0 | Evaluate edge/request protection | Layered request defenses | External service/SDK semantics; LLM detection cannot be sole gate | **No; evaluate** |
| Injection protection | [StackOne Defender](https://github.com/StackOneHQ/defender) | 121★; pushed 2026-09-11 | TypeScript | Apache-2.0 | Evaluate detector benchmark | Input/output scanning | Young; probabilistic; no memory authorization | **No; evaluate** |
| Character card | [Character Card Spec V2](https://github.com/malfoyslastname/character-card-spec-v2) | 190★; last update 2023-06-22 | Specification/examples | No declared license | Interoperate from independently implemented schema only after legal review | Field semantics and ecosystem compatibility | No license; prompt-bearing fields create injection risk | **No code copy** |
| Character/entity card | [Unified Entity Cards](https://github.com/LettuceAI/Unified-Entity-Cards) | 2★; pushed 2026-02-22 | JavaScript/spec | MIT; draft | Experimental import mapping reference | Typed entity extension ideas | Draft, tiny adoption, no trust boundary | **No; track** |
| Backend/platform | [Supabase](https://github.com/supabase/supabase) | 109,079★; pushed 2026-09-12 | PostgreSQL, TypeScript, Go ecosystem | Apache-2.0 repository; individual components vary | Use managed platform and official SDKs | Auth/RLS/Realtime/Storage/pgvector integration | RLS mistakes, Realtime leakage, platform coupling | **No; managed dependency** |

## Required deep dives

### Yuralume Core — useful life machinery, wrong base and license

Inspected commit [`6996b15`](https://github.com/Yuralume/yuralume-core/tree/6996b152604e83a1cf6344cd236a9b9456f47bba).

The backend has recognizable domain/application/port/adapter boundaries and substantial scheduled-life machinery. The candidate collectors are read-only and fail-soft; composition selects a bounded candidate, respects cooldown/daily limits, deduplicates sources, and records usage. These are valuable patterns for a later Life Event engine.

The persistence model, however, puts identity, runtime flags, emotional state, provider profiles, limits, and companion relationships into a broad character record. Its memory model has salience, embeddings, participants, `audience`, and `player_knowledge`; the social feed collector excludes several private structural types. This is useful evidence that social projection needs filtering, but two audience values are insufficient for Companion Social Platform's explicit memory domains and purpose-bound permissions.

Feed posts use denormalized counts and source deduplication. Reactions have uniqueness constraints. The comment flow is intentionally user-to-character only, so it is not a multi-owner social graph. The provider connection stores encrypted secret JSON, but its custom PBKDF2/XOR/HMAC construction is not a vetted AEAD secret-storage design and must not be copied.

Most importantly, the actual [BUSL-1.1 license](https://github.com/Yuralume/yuralume-core/blob/6996b152604e83a1cf6344cd236a9b9456f47bba/LICENSE) limits production use. Architecture fit and licensing independently rule out a fork.

### YuriOS — strongest import/export privacy reference

Inspected commit [`9f56d55`](https://github.com/yuri-os/YuriOS/tree/9f56d55c996a75d8c32d2df8f2b30c769c505cdd).

YuriOS is a local-first, always-on Python runtime. Its filesystem/Git vault treats human-readable identity and episodic/semantic memories as source of truth; SQLite/vector structures are rebuildable indices. Recall combines similarity, salience, and recency, then applies diversity. Tombstones and quarantined partner-proposed edits are better continuity primitives than blindly appending summaries.

Its character-card parser is bounded: it validates file size, PNG chunks/CRC, metadata, and version priority. Its privacy-oriented export code uses hard exclusions and canaries for user files, memory/vault content, corpora, traces, tool logs, credentials, and ambiguous overlap. Those tests should inspire Companion Import Firewall and Identity Passport export tests.

Apache-2.0 permits selective reuse, but the project is young and designed for a local, single-user vault—not a hosted, adversarial, multi-owner social system. We should port only small, well-tested concepts under attribution rather than inherit the runtime.

### SillyTavern — interoperability reference, incompatible trust model

Inspected commit [`8172dcd`](https://github.com/SillyTavern/SillyTavern/tree/8172dcd0ee672d3cd9a5e5f7af134f91a45cd2b8).

SillyTavern is a mature power-user frontend with broad provider and character-card compatibility. Its memory extension is rolling prompt summarization, injected at configurable prompt positions/roles; it is not a domain-separated, permission-gated memory system.

Character Card V2/V3 compatibility includes prompt-bearing fields such as `system_prompt` and `post_history_instructions`. In Companion Social Platform these must enter quarantine as inert untrusted data; they may never override platform policy or execute merely because they were imported. The filesystem-per-user and single-chat mental model also does not supply hosted social authorization.

AGPL-3.0 plus the incompatible trust model makes this reference-only. We may write independent interoperability tests from public formats after license review, but should not copy or fork the application.

### LettuceAI — rich local memory, no social permission layer

Inspected commit [`b9d1728`](https://github.com/LettuceAI/app/tree/b9d1728b76e4b9e4aebd90a18e933e6e25141f48).

LettuceAI uses React/Vite/Tauri with a Rust/SQLite backend. Its schema covers provider credentials, models, personas, characters, sessions, messages, turn effects, scheduled notes, shared-memory state, soul facts, episodes, embeddings, and usage records. Memory records distinguish importance, prompt importance, volatility, pinning/cold state, access counts, fact signatures, supersession, entities, and timestamps. Tests cover decay, pinned preservation, and budget selection. Provider tests check URL/header formation and reject CRLF header injection.

Those are strong implementation references. Yet shared memory can resolve at character level across sessions without Companion Social Platform's private/social namespaces and explicit permission gate. Usage records lack full Owner, billing party, reason, policy version, and immutable cost-settlement semantics. It is a local app without a multi-tenant social backend, and its AGPL license rules out code reuse in the planned product without a deliberate licensing decision.

## Mobile social app code inspection

### Bluesky Social App

Inspected commit [`ff10dbd`](https://github.com/bluesky-social/social-app/tree/ff10dbd355f2a87130b54c888a2a4ee4b6908e15). The app demonstrates production-grade Expo/React Native sharing across web, iOS, and Android. Its feed query layer uses typed feed descriptors, cursors, cached pages, and moderation-aware selection. Follow actions use optimistic mutation and precise cache invalidation; notification unread state is separated from paginated notification content. These patterns are directly relevant, but AT Protocol record ownership and federation would overtake the Companion Social Platform domain if used as a base.

### Rocket.Chat React Native

Inspected commit [`2c3e3f3`](https://github.com/RocketChat/Rocket.Chat.ReactNative/tree/2c3e3f323c6fa56ac7528b88561ce79b30a97dd3). The message path writes a local temporary record, attempts delivery, and transitions to sent or error while preserving retry/offline UX. WatermelonDB, sync, push, E2EE, threads, and notifications provide mature reference behavior. The cost is deep Rocket.Chat server coupling, multiple state systems, and significant native complexity. It is a DM behavior reference, not a V0 base.

### Obytes template

Inspected commit [`fd9b358`](https://github.com/obytes/react-native-template-obytes/tree/fd9b358ed11913d2a49fd9ffa6582fe03ba130e7). This is the best-fit generic scaffold reference: Expo Router, feature-oriented modules, TanStack Query, small global state, styling, localization, tests, and EAS workflows. Its sample feed is merely demo CRUD, so adopting the template does not solve any social domain. Recommendation: begin with the official Expo scaffold and copy only justified conventions; reconsider template bootstrap through an ADR if startup speed outweighs inherited dependencies.

### Ignite

Inspected commit [`e829d2f`](https://github.com/infinitered/ignite/tree/e829d2f922c5568a59a77bfb6232aeb500be3f13). Ignite is the most battle-tested general boilerplate in the set and has useful generators, navigation, storage, testing, and dependency-boundary practices. It brings more structure and ceremony than the proposed narrow V0 and does not model social products.

### Wataru Maeda React Native Boilerplate

Inspected commit [`bdfb8fa`](https://github.com/wataru-maeda/react-native-boilerplate/tree/bdfb8fa38b1a0a3c40bf547d12c7c58b1f023875). It is current and compact, with Expo Router, Redux Toolkit, environment separation, and EAS CI. Its profile/user service is sample data rather than a production social model. It is a useful minimal comparison but has less evidence and introduces Redux where server state plus small local stores are likely enough.

## Module decisions

| Capability | V0 decision | Why |
|---|---|---|
| Feed/Profile/Follow/Friend/Comment | Own domain and API; borrow Bluesky query/optimistic UI patterns | Human-network schemas do not express Social Twin, identity versions, memory permissions, or compute ownership |
| DM | Defer full DM; later borrow Rocket.Chat local delivery-state patterns | A full inbox expands abuse, privacy, moderation, and cost surface before core hypotheses are proven |
| Notifications | Own simple event projection/outbox | Must explain identity, safety, and compute outcomes, not only unread counts |
| Companion runtime | Own orchestrator; selectively learn from YuriOS/Yuralume | Runtime must enforce our identity, permission, safety, and attribution invariants |
| Character Card | Independent parser in quarantine; YuriOS-inspired bounds/canaries | Imported prompts and memory are untrusted; unlicensed specs/code need legal care |
| Long-term/Social Memory | PostgreSQL + pgvector source-of-truth; pilot Mem0/LangMem behind interface | Retrieval and storage engines do not determine disclosure permission |
| BYOK/Provider Router | Own credential policy and compute ledger; evaluate pinned LiteLLM gateway | Gateway normalization is reusable; billing/ownership/safety remain ours |
| Injection Protection | Deterministic parsing and privilege separation first; benchmark multiple detectors | No classifier can turn untrusted content into trusted instructions |
| PII/DLP | Deterministic secret patterns + Presidio pilot + policy engine | Combined controls and observable outcomes are needed |
| Mobile | Expo/React Native clean scaffold; selective Obytes/Bluesky patterns | Maximum code sharing with minimum inherited product assumptions |

## Adoption gates

Before any component enters production:

1. Pin a version or commit and record its transitive license/SBOM.
2. Verify repository license against every copied file and subdirectory.
3. Put providers, memory engines, DLP, and injection detectors behind Companion Social Platform interfaces.
4. Run adversarial fixtures for cross-owner access, imported prompt execution, secret leakage, multi-turn extraction, and cost attribution.
5. Define removal and data-migration paths; a dependency may not own canonical Companion Identity or MemoryPermission state.
6. Record material choices in an ADR.
