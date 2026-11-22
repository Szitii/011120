import assert from "node:assert/strict";
import { it } from "node:test";
import { RealApiAdapter, ApiProblemError } from "../src/adapters/real-api.ts";
import { CommunityRequestScope } from "../src/community/request-scope.ts";
import { communityRequestKey } from "../src/community/client.ts";

it("binds every community request to its actor and keeps retry keys stable", async () => {
  const original = globalThis.fetch;
  const calls: { url: URL; method: string; headers: Headers; body: string | null }[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: new URL(String(input)), method: init?.method ?? "GET", headers: new Headers(init?.headers), body: init?.body as string ?? null });
    return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 });
  }) as typeof fetch;
  try {
    const api = new RealApiAdapter({ baseUrl: "https://community.test", bearerToken: "test-token" }).community;
    const human = { kind: "OWNER" as const, id: "owner-id" };
    const twin = { kind: "COMPANION" as const, id: "companion-id" };
    const key = communityRequestKey();
    await api.profile(human); await api.profile(twin, "target");
    await api.feed(human); await api.feed(twin, { mode: "FOLLOWING", filter: "AI", cursor: "timestamp|id", authorId: "target" });
    await api.publish(twin, "真实代发", key); await api.publish(twin, "真实代发", key);
    await api.comment(human, "post", "评论", key);
    await api.detail(twin, "post", "timestamp|id");
    await api.follow(human, "target", true, key); await api.follow(twin, "target", false, key);
    await api.remove(twin, "posts", "post", key); await api.remove(human, "comments", "comment", key);
    await api.notifications(twin, "timestamp|id"); await api.readNotification(twin, "note", key);
    assert.equal(calls.length, 14);
    for (const call of calls) {
      assert.equal(call.headers.get("authorization"), "Bearer test-token");
      assert.ok(["owner-id", "companion-id"].includes(call.url.searchParams.get("actorId")!));
      assert.ok(call.url.searchParams.has("actorKind"));
      if (call.method !== "GET") assert.equal(call.headers.get("idempotency-key"), key);
    }
    assert.equal(calls[3]!.url.searchParams.get("mode"), "FOLLOWING");
    assert.equal(calls[4]!.body, JSON.stringify({ body: "真实代发" }));
    assert.equal(calls[4]!.headers.get("idempotency-key"), calls[5]!.headers.get("idempotency-key"));
    assert.equal(calls[9]!.method, "DELETE");
    assert.equal(calls[13]!.method, "PUT");
  } finally { globalThis.fetch = original; }
});

it("drops old feed and inbox results after navigation and identity switches", async () => {
  const scope = new CommunityRequestScope();
  let finish!: () => void;
  const delayed = new Promise<void>(resolve => { finish = resolve; });
  const old = scope.begin();
  const result = delayed.then(() => old() ? "private-old-inbox" : undefined);
  scope.invalidate();
  const fresh = scope.begin();
  finish();
  assert.equal(await result, undefined);
  assert.equal(fresh(), true);
  scope.begin(); assert.equal(fresh(), false);
});

it("surfaces a denied community mutation and never substitutes mock success", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ code: "FORBIDDEN", messageClass: "PERMISSION", retryHint: "DO_NOT_RETRY" }), { status: 403 })) as typeof fetch;
  try {
    const api = new RealApiAdapter({ baseUrl: "https://community.test", bearerToken: "test" }).community;
    await assert.rejects(api.publish({ kind: "OWNER", id: "owner" }, "draft", communityRequestKey()), e => e instanceof ApiProblemError && e.status === 403);
  } finally { globalThis.fetch = original; }
});

it("binds block management and all report kinds to the selected actor and stable retry key", async t => {
  const calls: { url: string; method?: string; headers: Headers; body: unknown }[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    calls.push({ url, method: options.method, headers: new Headers(options.headers), body: options.body });
    return Response.json({});
  });
  const api = new RealApiAdapter({ baseUrl: "https://community.test", bearerToken: "test" }).community;
  const viewer = { kind: "COMPANION", id: "own-companion" } as const;
  const key = communityRequestKey();
  await api.blocks(viewer, "timestamp|target");
  await api.block(viewer, "other-actor", true, key);
  await api.block(viewer, "other-actor", false, key);
  for (const kind of ["ACTOR","POST","COMMENT"] as const) {
    await api.report(viewer, { kind, id: "target" }, "HARASSMENT", "details", key);
  }
  assert.ok(calls.every(call => new URL(call.url).searchParams.get("actorId") === viewer.id));
  assert.ok(calls.slice(1).every(call => call.headers.get("Idempotency-Key") === key));
  assert.deepEqual(calls.map(call => call.method), ["GET","PUT","DELETE","POST","POST","POST"]);
  assert.ok(calls[3]!.url.includes("/reports/actors/target"));
  assert.ok(calls[4]!.url.includes("/reports/posts/target"));
  assert.ok(calls[5]!.url.includes("/reports/comments/target"));
  assert.deepEqual(JSON.parse(calls[5]!.body as string), { reason: "HARASSMENT", details: "details" });
});

it("binds settings GET and whole-object PUT to the selected AI actor", async t => {
  const calls: { url: URL; options: RequestInit }[] = [];
  const writable = {
    paused: false, autoEnabled: false, intervalMinutes: 180, activeFrom: "09:00", activeTo: "23:00",
    timeZone: "Asia/Shanghai", canPost: false, canComment: true, canFollow: true,
    publishMode: "DRAFT" as const, dailyPosts: 3, dailyComments: 10, dailyFollows: 5, commentsPerPost: 3, revision: 7,
  };
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    calls.push({ url: new URL(url), options });
    return Response.json({ ...writable, revision: options.method === "PUT" ? 8 : 7 });
  });
  const client = new RealApiAdapter({ baseUrl: "https://community.test", bearerToken: "test" }).community;
  const viewer = { kind: "SOCIAL_TWIN", id: "twin" } as const;
  assert.equal((await client.agentSettings(viewer)).revision, 7);
  assert.equal((await client.saveAgentSettings(viewer, writable)).revision, 8);
  assert.deepEqual(calls.map(c => c.options.method), ["GET", "PUT"]);
  assert.ok(calls.every(c => c.url.pathname === "/v0/community/agent/settings"
    && c.url.searchParams.get("actorKind") === viewer.kind && c.url.searchParams.get("actorId") === viewer.id));
  assert.deepEqual(JSON.parse(String(calls[1]!.options.body)), writable);
  assert.equal(new Headers(calls[1]!.options.headers).has("Idempotency-Key"), false);
});
