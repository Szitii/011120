import assert from "node:assert/strict";
import { it } from "node:test";
import type pg from "pg";
import { AgentKeyResolver, CHECK_AFTER_SECONDS, Heartbeats, handleAgentRequest, newAgentToken } from "../src/agent/heartbeat.ts";
import { sha256 } from "../src/companion-import/canonical.ts";
import { MvpApiBoundary } from "../src/http/mvp-api.ts";
import type { AuthenticatedOwnerSession, MvpHttpRequest, OwnerApiPort, OwnerSessionResolver } from "../src/http/types.ts";
import type { CommunityPort, CommunityRead } from "../src/community/port.ts";

const companionId = "00000000-0000-0000-0000-0000000002a1";
const key = { keyId: "00000000-0000-0000-0000-00000000c0de", ownerId: "00000000-0000-0000-0000-0000000001a1",
  subject: "00000000-0000-0000-0000-0000000000a1", companionId, scopes: ["COMMUNITY_READ"] };

/** A pool whose queries answer `payload` (or fail), recording each statement. */
function pool(payload: unknown) {
  const seen: { text: string; values?: unknown[] }[] = [];
  const query = async (text: string, values?: unknown[]) => {
    seen.push(values === undefined ? { text } : { text, values });
    if (payload instanceof Error && text.includes("agent_key_resolve")) throw payload;
    return { rows: [{ payload }] };
  };
  return { pool: { query, connect: async () => ({ query, release: () => undefined }) } as unknown as pg.Pool, seen };
}
const owner: OwnerSessionResolver = { resolve: async token => ({ ownerId: `owner:${token}`, owner: {} as OwnerApiPort }) };
const request = (url: string, method = "GET", token = "x"): MvpHttpRequest => ({ method, url, headers: { authorization: `Bearer ${token}` } });

it("makes agent keys that are shown once and stored as a hash", () => {
  const a = newAgentToken(), b = newAgentToken();
  assert.match(a.token, /^cak_[A-Za-z0-9_-]{43}$/);
  assert.equal(a.hash, sha256(a.token));
  assert.notEqual(a.token, b.token);
});

it("resolves agent keys to a Companion; other tokens go to the Owner sign-in", async () => {
  const { token, hash } = newAgentToken();
  const live = pool(key);
  const session = await new AgentKeyResolver(live.pool, owner).resolve(token);
  assert.deepEqual([session.ownerId, session.agent, session.chat], [key.ownerId, { keyId: key.keyId, companionId, scopes: ["COMMUNITY_READ"] }, undefined]);
  assert.ok(live.seen.some(s => s.text === "select public.agent_key_resolve($1) as payload" && s.values?.[0] === hash));
  assert.ok(!live.seen.some(s => s.text.includes("set_config")), "resolved as the server, not as an Owner");
  assert.equal((await new AgentKeyResolver(live.pool, owner).resolve("supabase-jwt")).ownerId, "owner:supabase-jwt");
  await assert.rejects(new AgentKeyResolver(live.pool, owner).resolve("cak_short"), { code: "INVALID_TOKEN" });
  await assert.rejects(new AgentKeyResolver(pool(null).pool, owner).resolve(token), { code: "INVALID_TOKEN" }, "revoked, expired or unknown");
  await assert.rejects(new AgentKeyResolver(pool(new Error("down")).pool, owner).resolve(token), { code: "SERVICE_UNAVAILABLE" });
});

it("lets a key check in once a minute", () => {
  let now = 1_000_000;
  const beats = new Heartbeats(60_000, () => now);
  assert.equal(beats.wait("k"), 0);
  now += 59_001;
  assert.equal(beats.wait("k"), 1);
  assert.equal(beats.wait("other"), 0, "per key");
  now += 1_000;
  assert.equal(beats.wait("k"), 0);
});

it("answers a heartbeat with the feed and the notifications read as the Companion, and nothing else", async () => {
  const reads: CommunityRead[] = [];
  const community = { read: async (input: CommunityRead) => { reads.push(input); return { items: [input.resource] }; } } as unknown as CommunityPort;
  const agent: AuthenticatedOwnerSession = { ownerId: key.ownerId, owner: {} as OwnerApiPort, community, agent: { keyId: "k", companionId, scopes: ["COMMUNITY_READ"] } };
  const ok = await handleAgentRequest(request("/v0/agent/heartbeat/"), agent, "t", new Heartbeats());
  assert.deepEqual([ok.status, ok.body], [200, { companionId, feed: { items: ["feed"] }, notifications: { items: ["notifications"] }, checkAfterSeconds: CHECK_AFTER_SECONDS }]);
  assert.deepEqual(reads.map(r => [r.actor, r.resource, r.mode, r.beforeAt]),
    [[{ kind: "COMPANION", id: companionId }, "feed", "LATEST", null], [{ kind: "COMPANION", id: companionId }, "notifications", "LATEST", null]]);
  const beats = new Heartbeats();
  await handleAgentRequest(request("/v0/agent/heartbeat"), agent, "t", beats);
  const again = await handleAgentRequest(request("/v0/agent/heartbeat"), agent, "t", beats);
  assert.equal(again.status, 429);
  assert.equal(again.headers?.["retry-after"], "60");
  for (const [url, method] of [["/v0/chats", "GET"], ["/v0/agent/heartbeat", "POST"], ["/v0/community/feed", "GET"]] as const) {
    assert.equal((await handleAgentRequest(request(url, method), agent, "t", new Heartbeats())).status, 403, `${method} ${url}`);
  }
  const noScope = { ...agent, agent: { ...agent.agent!, scopes: [] } };
  assert.equal((await handleAgentRequest(request("/v0/agent/heartbeat"), noScope, "t", new Heartbeats())).status, 403);
});

it("sends agent-key sessions to the heartbeat alone at the API boundary", async () => {
  const community = { read: async () => ({ items: [] }) } as unknown as CommunityPort;
  const sessions: OwnerSessionResolver = { resolve: async () => ({ ownerId: key.ownerId, owner: {} as OwnerApiPort, community,
    agent: { keyId: "k", companionId, scopes: ["COMMUNITY_READ"] } }) };
  const api = new MvpApiBoundary({ sessions });
  assert.equal((await api.handle(request("/v0/agent/heartbeat"))).status, 200);
  assert.equal((await api.handle(request("/v0/companions"))).status, 403);
  assert.equal((await api.handle(request(`/v0/companions/${companionId}/agent-keys`))).status, 403, "an agent cannot make more keys");
});
