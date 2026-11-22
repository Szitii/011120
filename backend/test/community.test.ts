import assert from "node:assert/strict";
import { it } from "node:test";
import { handleCommunityRequest } from "../src/community/http.ts";
import { PostgresCommunityAdapter } from "../src/community/postgres.ts";
import type { CommunityCommand, CommunityRead, CommunityPort } from "../src/community/port.ts";
import type { AuthenticatedOwnerSession, OwnerApiPort, MvpHttpRequest } from "../src/http/types.ts";
import { PostgresPersistenceError, type SqlExecutor } from "../src/persistence/postgres/types.ts";
import { MvpApiBoundary } from "../src/http/mvp-api.ts";

const ownerId = "00000000-0000-0000-0000-0000000001a1";
const target = "00000000-0000-0000-0000-0000000005a1";
const query = `actorKind=OWNER&actorId=${ownerId}`;
const reads: CommunityRead[] = []; const commands: CommunityCommand[] = [];
const community: CommunityPort = {
  read: async input => { reads.push(input); return { items: [], nextCursor: null }; },
  command: async input => { commands.push(input); return { id: target }; },
  humanProfileSettings: async () => ({ displayName: "Sample", bio: "", revision: 1 }),
  saveHumanProfile: async (_actor, settings) => settings,
};
const session: AuthenticatedOwnerSession = { ownerId, owner: {} as OwnerApiPort, community };
const request = (path: string, method = "GET", body?: unknown): MvpHttpRequest => ({
  method, url: `/v0/community/${path}${path.includes("?") ? "&" : "?"}${query}`,
  headers: { "Content-Type": "application/json", "Idempotency-Key": "stable-community-test-key", Authorization: "Bearer test" },
  ...(body === undefined ? {} : { body }),
});

it("routes community reads with explicit actor context and deterministic keyset cursors", async () => {
  for (const path of ["profile", `profile/${target}`, "feed", `feed?mode=FOLLOWING&filter=AI&authorId=${target}&cursor=2026-11-21T12:00:00Z|${target}`, `posts/${target}`, "notifications"]) {
    assert.equal((await handleCommunityRequest(request(path), session, "trace"))?.status, 200);
  }
  assert.equal(reads[3]!.mode, "FOLLOWING"); assert.equal(reads[3]!.beforeId, target);
  assert.equal(reads[3]!.actor.id, ownerId);
  assert.equal((await handleCommunityRequest(request("missing"), session, "t"))?.status, 404);
  assert.equal(await handleCommunityRequest({ method: "GET", url: "/other" }, session, "t"), undefined);
  assert.equal((await handleCommunityRequest(request("feed"), { ownerId, owner: session.owner }, "t"))?.status, 501);
});

it("routes all mutations, hashes retry keys and refuses client-selected provenance", async () => {
  const cases = [
    request("posts", "POST", { body: " hello " }), request(`posts/${target}/comments`, "POST", { body: "comment" }),
    request(`following/${target}`, "PUT"), request(`following/${target}`, "DELETE"),
    request(`posts/${target}`, "DELETE"), request(`comments/${target}`, "DELETE"), request(`notifications/${target}/read`, "PUT"),
  ];
  for (const req of cases) assert.ok([200,201].includes((await handleCommunityRequest(req, session, "t"))!.status));
  assert.equal(commands[0]!.body, "hello"); assert.match(commands[0]!.keyHash, /^[a-f0-9]{64}$/);
  await handleCommunityRequest(cases[0]!, session, "t");
  assert.equal(commands[0]!.requestHash, commands.at(-1)!.requestHash);
  assert.equal(commands[0]!.keyHash, commands.at(-1)!.keyHash);
  assert.equal((await handleCommunityRequest(request("unsupported", "PATCH"), session, "t"))?.status, 404);
});

it("rejects malformed contexts, cursors, bodies and missing retry keys before persistence", async () => {
  const bad = [
    { method: "GET", url: "/v0/community/feed" },
    { method: "GET", url: `/v0/community/feed?actorKind=INVALID&actorId=${ownerId}` },
    request("feed?filter=SECRET"), request("feed?mode=SECRET"), request("feed?cursor=bad"),
    request(`feed?cursor=bad|${target}`), request("profile/bad"), request("feed?authorId=bad"),
    request("posts", "POST", { body: "x", source: "AUTONOMOUS" }), request("posts", "POST", { body: "  " }),
    request("posts", "POST", []), request("posts", "POST", { body: 4 }), request("posts", "POST"),
    request("posts", "POST", { body: "x".repeat(4001) }),
    request(`posts/${target}/comments`, "POST", { body: "x".repeat(2001) }),
    request(`following/${target}`, "PUT", { source: "AUTONOMOUS" }),
    { ...request("posts", "POST", { body: "x" }), headers: { "Idempotency-Key": "stable-community-test-key" } },
    { ...request("posts", "POST", { body: "x" }), headers: { "Content-Type": "application/json" } },
  ];
  for (const req of bad) await assert.rejects(handleCommunityRequest(req, session, "t"), e => e instanceof PostgresPersistenceError && e.code === "INVALID_INPUT");
});

it("runs community routing after authentication and uses the existing safe error envelope", async () => {
  const api = new MvpApiBoundary({ sessions: { resolve: async () => session }, encounters: { run: async () => { throw Error("unused"); } } });
  assert.equal((await api.handle({ method: "GET", url: "/v0/community/feed" })).status, 401);
  assert.equal((await api.handle(request("feed"))).status, 200);
  const denied = new MvpApiBoundary({ sessions: { resolve: async () => ({ ...session, community: {
    ...community,
    read: async () => { throw new PostgresPersistenceError("NOT_FOUND", "secret database text"); }, command: community.command,
  } }) }, encounters: { run: async () => { throw Error("unused"); } } });
  const result = await denied.handle(request("notifications"));
  assert.equal(result.status, 404); assert.ok(!JSON.stringify(result.body).includes("secret database text"));
});

it("accepts only profile fields and revision, trims display text, and supports Unicode", async () => {
  const get = await handleCommunityRequest(request("profile/settings"), session, "trace");
  assert.equal(get?.status, 200);
  const legal = { displayName: " 新昵称 🐾 ", bio: " 第一行\r\n第二行 ", revision: 1 };
  const saved = await handleCommunityRequest(request("profile/settings", "PUT", legal), session, "trace");
  assert.equal(saved?.status, 200);
  assert.equal(saved?.headers["cache-control"], "no-store");
  assert.deepEqual(saved?.body, { displayName: "新昵称 🐾", bio: "第一行\n第二行", revision: 1 });
  const malformed = [
    { ...legal, actorId: target }, { ...legal, handle: "someone" }, { ...legal, displayName: " " },
    { ...legal, displayName: "first\nsecond" }, { ...legal, displayName: "x".repeat(81) },
    { ...legal, bio: "invalid\0bio" }, { ...legal, bio: "界".repeat(501) },
    { ...legal, revision: 0 }, { ...legal, revision: 1.5 }, { ...legal, revision: "1" },
    { ...legal, revision: 2147483648 }, null, [],
  ];
  for (const body of malformed) {
    await assert.rejects(handleCommunityRequest(request("profile/settings", "PUT", body), session, "trace"),
      error => error instanceof PostgresPersistenceError && error.code === "INVALID_INPUT");
  }
  await assert.rejects(handleCommunityRequest({ ...request("profile/settings", "PUT", legal), headers: {} }, session, "trace"),
    error => error instanceof PostgresPersistenceError && error.code === "INVALID_INPUT");
});

it("parameterizes all PostgreSQL community inputs and validates payload shape", async () => {
  const calls: { text: string; values: readonly unknown[] }[] = [];
  const executor: SqlExecutor = { async query<T extends Record<string, unknown>>(text: string, values: readonly unknown[]) {
    calls.push({ text, values }); return { rows: [{ payload: { ok: true } } as unknown as T], rowCount: 1 };
  } };
  const adapter = new PostgresCommunityAdapter(executor);
  await adapter.read(reads[0]!); await adapter.command(commands[0]!);
  assert.equal(calls[0]!.values[1], ownerId); assert.equal(calls[1]!.values[4], "hello");
  assert.ok(!calls[1]!.text.includes("hello"));
  for (const payload of [null, 2, [], undefined]) {
    const bad = new PostgresCommunityAdapter({ query: async () => ({ rows: [{ payload }], rowCount: 1 }) } as SqlExecutor);
    await assert.rejects(bad.read(reads[0]!), e => e instanceof PostgresPersistenceError && e.code === "DATABASE_ERROR");
  }
  for (const [state, expected] of [["P0001","NOT_FOUND"],["22023","INVALID_INPUT"],["23505","CONFLICT"],["42501","FORBIDDEN"],["55000","INVALID_STATE"],["08006","DATABASE_UNAVAILABLE"],["other","DATABASE_ERROR"],[undefined,"DATABASE_ERROR"]]) {
    const broken = new PostgresCommunityAdapter({ query: async () => { throw { code: state }; } });
    await assert.rejects(broken.read(reads[0]!), e => e instanceof PostgresPersistenceError && e.code === expected);
  }
});

it("validates protection commands and binds reports and the block list to the verified actor", async () => {
  assert.equal((await handleCommunityRequest(request("blocks"), session, "t"))?.status, 200);
  assert.equal(reads.at(-1)?.resource, "blocks");
  for (const method of ["PUT", "DELETE"]) {
    assert.equal((await handleCommunityRequest(request(`blocks/${target}`, method), session, "t"))?.status, 200);
    assert.equal(commands.at(-1)?.action, method === "PUT" ? "BLOCK" : "UNBLOCK");
  }
  for (const [kind, action] of [["actors","REPORT_ACTOR"],["posts","REPORT_POST"],["comments","REPORT_COMMENT"]]) {
    assert.equal((await handleCommunityRequest(request(`reports/${kind}/${target}`, "POST",
      { reason: "PRIVACY", details: "  confidential information  " }), session, "t"))?.status, 200);
    assert.equal(commands.at(-1)?.action, action);
    assert.deepEqual(JSON.parse(commands.at(-1)!.body!), { reason: "PRIVACY", details: "confidential information" });
  }
  for (const body of [null, [], {}, { reason: "INVALID", details: "" }, { reason: "SPAM", details: 3 },
    { reason: "SPAM", details: "x".repeat(1001) }, { reason: "SPAM", details: "\0" },
    { reason: "SPAM", details: "", reporterId: target }]) {
    await assert.rejects(handleCommunityRequest(request(`reports/posts/${target}`, "POST", body), session, "t"),
      (e: unknown) => e instanceof PostgresPersistenceError && e.code === "INVALID_INPUT");
  }
  await assert.rejects(handleCommunityRequest({ ...request(`reports/actors/${target}`, "POST",
    { reason: "OTHER", details: "" }), headers: { "Idempotency-Key": "stable-community-test-key" } }, session, "t"),
    (e: unknown) => e instanceof PostgresPersistenceError && e.code === "INVALID_INPUT");
  assert.equal((await handleCommunityRequest(request(`reports/unknown/${target}`, "POST"), session, "t"))?.status, 404);
});
