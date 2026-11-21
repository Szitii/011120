import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ViewerSensitiveCache } from "../src/state/cache.ts";
import { createClientBootstrap } from "../src/adapters/index.ts";
import { RealApiAdapter, ApiProblemError, safeClientMessage } from "../src/adapters/real-api.ts";
import { toStage1MediaPresentation } from "../src/media.ts";
import { initialNavigationState, popRoute, pushRoute, saveScroll, scrollKey, selectTab } from "../src/state/navigation.ts";

describe("real client binding state architecture", () => {
  it("purges viewer-sensitive cache on identity switch", () => {
    const cache = new ViewerSensitiveCache();
    cache.set("encounter:1", { secret: "owner-view" });
    const before = cache.epoch;
    cache.purgeViewerSensitive();
    assert.equal(cache.epoch, before + 1);
    assert.equal(cache.size(), 0);
    assert.equal(cache.get("encounter:1"), undefined);
  });

  it("restores source route and per-identity World scroll position", () => {
    let state = initialNavigationState();
    state = saveScroll(state, "owner-1", "world", 428);
    state = pushRoute(state, { type: "encounter", encounterId: "enc-1", sourceTab: "world", sourceScrollY: 428 });
    state = pushRoute(state, {
      type: "profile",
      companionId: "sample_companion-1",
      source: "ENCOUNTER",
      fromEncounterId: "enc-1",
    });
    state = popRoute(state);
    state = popRoute(state);
    assert.deepEqual(state.stack, [{ type: "root", tab: "world" }]);
    assert.equal(state.scrollByIdentityAndTab[scrollKey("owner-1", "world")], 428);
  });

  it("keeps profile navigation distinct from explicit identity switching", () => {
    let state = initialNavigationState();
    state = selectTab(state, "my");
    state = pushRoute(state, {
      type: "profile",
      companionId: "sample_companion-1",
      source: "OWNER_ROSTER",
    });
    const route = state.stack.at(-1);
    assert.equal(route?.type, "profile");
    if (route?.type === "profile") {
      assert.equal(route.source, "OWNER_ROSTER");
      assert.equal("viewContext" in route, false);
    }
    assert.equal(state.rootTab, "my");
  });

  it("supports a real post-switch contextual route before Companion Social Platform", () => {
    let state = initialNavigationState();
    state = pushRoute(state, { type: "encounter", encounterId: "enc-1", sourceTab: "world", sourceScrollY: 0 });
    state = pushRoute(state, { type: "identity-context", encounterId: "enc-1", companionId: "sample_companion-1" });
    assert.equal(state.stack.at(-1)?.type, "identity-context");
    state = selectTab(state, "world");
    assert.deepEqual(state.stack, [{ type: "root", tab: "world" }]);
  });

  it("keeps root labels client-side and independent from API resources", () => {
    let state = initialNavigationState();
    state = selectTab(state, "home");
    assert.equal(state.rootTab, "home");
    state = selectTab(state, "my");
    assert.equal(state.rootTab, "my");
    assert.equal(state.stack[0]?.type, "root");

    state = pushRoute(state, { type: "bring-companion" });
    assert.equal(state.stack.at(-1)?.type, "bring-companion");
    state = popRoute(state);
    state = pushRoute(state, { type: "controls", companionId: "sample_companion-1" });
    assert.equal(state.stack.at(-1)?.type, "controls");
    state = popRoute(state);
    state = pushRoute(state, {
      type: "social-activation",
      companionId: "cici-1",
      identityId: "identity-cici-1",
      displayName: "Cici",
      approvedFields: ["displayName", "personaTraits"],
    });
    assert.equal(state.stack.at(-1)?.type, "social-activation");
  });
});

describe("real API adapter boundary", () => {
  it("uses bearer authentication and the OpenAPI 0.7 resource paths", async () => {
    const original = globalThis.fetch;
    const calls: { url: string; auth: string | null; method: string; idempotency: string | null; ifMatch: string | null }[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      calls.push({
        url,
        auth: headers.get("Authorization"),
        method: init?.method ?? "GET",
        idempotency: headers.get("Idempotency-Key"),
        ifMatch: headers.get("If-Match"),
      });
      const body = url.includes("identity-context")
        ? { viewer: { ownerId: "owner" }, activeSubject: { kind: "OWNER", id: "owner", presentation: { displayName: "SampleUser" } }, relationship: "SELF", viewMode: "OWNER", capabilities: {} }
        : url.endsWith("/v0/companions")
          ? { items: [{ companionId: "c", displayName: "Cici", identityId: "identity-c", identityVersion: 1, approvedFields: ["displayName", "personaTraits"], status: "ACTIVE", socialReady: true, socialTwinId: "s", handle: "cici" }] }
          : url.includes("world-items")
          ? { items: [], nextCursor: null }
          : url.includes("/life-continuity")
            ? { items: [], nextCursor: null }
          : url.includes("/encounters/")
            ? { encounterId: "e", invitationId: "i", status: "DELIVERED", initiatorTwinId: "a", responderTwinId: "b", participants: [{ role: "INITIATOR", socialTwinId: "a", presentationAvailable: true, companionId: "c", displayName: "SampleCompanion", profileAvailable: true }, { role: "RESPONDER", socialTwinId: "b", presentationAvailable: false, profileAvailable: false }], occurredAt: "2026-09-18T00:00:00Z", capabilities: {}, completeness: "COMPLETE" }
            : url.includes("/life-event-inbox/") && url.endsWith("/read")
              ? { id: "li-1", companionId: "c", lifeEventId: "le-1", title: "new", createdAt: "2026-09-18T00:00:00Z", readAt: "2026-09-18T01:00:00Z", linkedObject: { type: "LIFE_EVENT", id: "le-1" } }
              : url.includes("/life-event-inbox")
                ? { items: [], nextCursor: null }
                : url.includes("/companion-imports/") && url.endsWith("/approve")
                  ? { id: "identity-1", companionId: "c", version: 1, displayName: "SampleCompanion", sourceManifest: {}, contentHash: "a".repeat(64), createdBy: "IMPORT_FIREWALL", approvedByOwnerAt: "2026-09-18T00:00:00Z" }
                  : url.endsWith("/v0/companion-imports")
                    ? { id: "import-1", status: "REVIEWABLE", statusHistory: ["UPLOADED", "QUARANTINED", "REVIEWABLE"], originalSha256: "a".repeat(64), byteLength: 10, parserVersion: "1", policyVersion: "1", sourceFormat: "CHARACTER_CARD_JSON_V2", findings: [], draft: { candidates: [{ id: "candidate-1", field: "displayName", value: "SampleCompanion", sourcePath: "$.name", sourceTrust: "EXTERNAL_UNTRUSTED", approvable: true, blockedByFindingIds: [] }] } }
                    : url.includes("/social-persona")
                      ? { persona: { id: "p1", companionId: "c", version: 1, handle: "sample_companion_social", displayName: "SampleCompanion", profileVisibility: "PRIVATE" }, twin: { id: "t1", companionId: "c", activeSocialPersonaId: "p1", status: "ACTIVE", autonomyMode: "QUIET" } }
                      : url.includes("/controls")
                      ? { companionId: "c", schemaVersion: 1, revision: init?.method === "PATCH" ? 2 : 1, settings: { socialTwinVisibility: "PUBLIC", socialAutonomyMode: "QUIET", memorySharingScope: "PERMISSION_GATED_SOCIAL_ONLY", notificationsEnabled: true }, supported: { socialTwinVisibility: ["PRIVATE", "FRIENDS", "PUBLIC"], socialAutonomyMode: ["QUIET", "NORMAL", "ACTIVE", "CUSTOM"], memorySharingScope: ["PERMISSION_GATED_SOCIAL_ONLY"], notificationsEnabled: true } }
                      : { companionId: "c", socialTwinId: "s", socialPersonaId: "p", handle: "sample_companion", displayName: "SampleCompanion", profileVisibility: "PUBLIC", identityVersion: 1, socialPersonaVersion: 1, publicProfile: {}, viewer: { relationship: "OWNER_OF", capabilities: {} }, completeness: "COMPLETE" };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      const api = new RealApiAdapter({ baseUrl: "https://api.example.test", bearerToken: "token" });
      await api.identityContext();
      await api.identityContext({ kind: "COMPANION", id: "sample_companion-id" });
      await api.ownerCompanions();
      await api.worldItems();
      await api.lifeContinuity();
      await api.lifeContinuity({ kind: "COMPANION", id: "companion-id" });
      await api.encounterDetail("encounter-id");
      await api.companionProfile("companion-id");
      await api.companionProfile("companion-id", { kind: "COMPANION", id: "companion-id" });
      await api.lifeEventInbox();
      await api.acknowledgeLifeEvent("life-item-id");
      const review = await api.createCompanionImport({ name: "SampleCompanion" });
      await api.approveCompanionImport(review.id, ["candidate-1"]);
      await api.projectSocialPersona("companion-id", {
        sourceIdentityVersionId: "identity-1",
        handle: "sample_companion_social",
        profileVisibility: "PRIVATE",
        autonomyMode: "QUIET",
        selections: [{ sourceField: "displayName", targetField: "displayName" }],
      });
      const controls = await api.controls("companion-id");
      await api.updateControls("companion-id", controls.revision, { notificationsEnabled: false });

      assert.ok(calls.every((call) => call.auth === "Bearer token"));
      assert.ok(calls.some((call) => call.url.includes("/v0/identity-context?activeSubjectKind=COMPANION&activeSubjectId=sample_companion-id")));
      assert.ok(calls.some((call) => call.url.endsWith("/v0/companions")));
      assert.ok(calls.some((call) => call.url.endsWith("/v0/world-items?limit=20")));
      assert.ok(calls.some((call) => call.url.endsWith("/v0/life-continuity?limit=30&activeSubjectKind=OWNER")));
      assert.ok(calls.some((call) => call.url.endsWith("/v0/life-continuity?limit=30&activeSubjectKind=COMPANION&activeSubjectId=companion-id")));
      assert.ok(calls.some((call) => call.url.endsWith("/v0/encounters/encounter-id")));
      assert.ok(calls.some((call) => call.url.endsWith("/v0/companions/companion-id/profile?activeSubjectKind=OWNER")));
      assert.ok(calls.some((call) => call.url.endsWith("/v0/companions/companion-id/profile?activeSubjectKind=COMPANION&activeSubjectId=companion-id")));
      assert.ok(calls.some((call) => call.url.endsWith("/v0/life-event-inbox?limit=20")));
      assert.ok(calls.some((call) => call.url.endsWith("/v0/life-event-inbox/life-item-id/read") && call.method === "PUT"));
      assert.ok(calls.some((call) => call.url.endsWith("/v0/companion-imports") && call.method === "POST" && call.idempotency !== null));
      assert.ok(calls.some((call) => call.url.endsWith("/v0/companion-imports/import-1/approve") && call.method === "POST" && call.idempotency !== null));
      assert.ok(calls.some((call) => call.url.endsWith("/v0/companions/companion-id/social-persona") && call.method === "PUT" && call.idempotency !== null));
      assert.ok(calls.some((call) => call.url.includes("/v0/controls?companionId=companion-id") && call.method === "GET"));
      assert.ok(calls.some((call) => call.url.includes("/v0/controls?companionId=companion-id") && call.method === "PATCH" && call.ifMatch === "1" && call.idempotency !== null));
    } finally {
      globalThis.fetch = original;
    }
  });

  it("keeps mock mode explicit and presentation-data free", () => {
    const mock = createClientBootstrap({ EXPO_PUBLIC_DATA_MODE: "mock" });
    assert.equal(mock.dataMode, "mock");
    assert.throws(() => createClientBootstrap({}), /EXPO_PUBLIC_API_BASE_URL/);
  });

  it("maps required safe public errors without exposing server internals", () => {
    for (const [status, expected] of [
      [401, { title: "会话过期了。", retry: false }],
      [403, { title: "这里不能进。", retry: false }],
      [404, { title: "这条已经不在这儿。", retry: false }],
      [409, { title: "东西变了。", retry: true }],
      [501, { title: "这个还没开。", retry: false }],
      [503, { title: "现在没连上。", retry: true }],
    ] as const) {
      assert.deepEqual(
        safeClientMessage(new ApiProblemError(status, "SAFE", "INTERNAL", status === 409 ? "REFRESH_AND_RETRY" : "DO_NOT_RETRY", "trace")),
        expected,
      );
    }
  });
});


describe("Stage 1 media resilience", () => {
  it("renders safe https images and fails closed for unsupported media", () => {
    assert.deepEqual(
      toStage1MediaPresentation({ type: "IMAGE", url: "https://cdn.example.test/a.jpg", alt: "A moment" }),
      { kind: "IMAGE", url: "https://cdn.example.test/a.jpg", alt: "A moment" },
    );
    assert.deepEqual(
      toStage1MediaPresentation({ type: "VIDEO", url: "https://cdn.example.test/a.mp4" }),
      { kind: "UNAVAILABLE", label: "视频暂时不能在这里播放。" },
    );
    assert.deepEqual(
      toStage1MediaPresentation({ type: "IMAGE", url: "file:///private/path.jpg" }),
      { kind: "UNAVAILABLE", label: "这段媒体暂时打不开。" },
    );
  });
});
