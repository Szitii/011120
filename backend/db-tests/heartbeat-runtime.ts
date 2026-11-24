import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createMobileDevHttpServer } from "../src/dev/mobile-http-server.ts";
import { createPgPool } from "../src/persistence/postgres/index.ts";

// Agent keys and the read-only heartbeat (migration 0053), through the real HTTP server.
const connectionString = process.env.DATABASE_URL;
if (!connectionString || process.env.COMPANION_SOCIAL_DEV_DATABASE !== "1") throw Error("Disposable seeded development database required.");
const pool = createPgPool(connectionString);
const ids = (letter: "a" | "b") => ({ owner: `00000000-0000-0000-0000-0000000001${letter}1`,
  subject: `00000000-0000-0000-0000-0000000000${letter}1`, companion: `00000000-0000-0000-0000-0000000002${letter}1` });
const A = ids("a"), B = ids("b");
const servers = [A, B].map((v, i) => createMobileDevHttpServer({ pool, ownerId: v.owner, ownerSubject: v.subject, bearerToken: `heartbeat-${i}` }));
let groups = 0;
const passed = (name: string) => { groups += 1; console.log(`Heartbeat integration ${groups}: ${name}`); };
type Key = { id: string; companionId: string; name: string; scopes: string[]; expiresAt: string; lastUsedAt: string | null; active: boolean; token?: string };

try {
  const bases = await Promise.all(servers.map(server => new Promise<string>(resolve =>
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)))));
  async function call<T>(auth: string, path: string, method = "GET", body?: unknown, base = bases[0]) {
    const response = await fetch(`${base}/v0/${path}`, {
      method, headers: { Authorization: `Bearer ${auth}`, "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, headers: response.headers, data: await response.json() as T };
  }
  const keys = `companions/${A.companion}/agent-keys`;

  // ---- the Owner issues a key; the agent checks in ----
  const made = await call<Key>("heartbeat-0", keys, "POST", { name: "我的 Agent", days: 7 });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  const token = made.data.token!;
  assert.match(token, /^cak_/);
  assert.deepEqual([made.data.companionId, made.data.scopes, made.data.active], [A.companion, ["COMMUNITY_READ"], true]);
  const stored = await pool.query("select token_hash from companion_private.agent_keys where id = $1", [made.data.id]);
  assert.notEqual(stored.rows[0]!.token_hash, token, "only the hash is stored");
  const beat = await call<{ companionId: string; feed: { items: unknown[] }; notifications: { items: unknown[] }; checkAfterSeconds: number }>(
    token, "agent/heartbeat");
  assert.equal(beat.status, 200, JSON.stringify(beat.data));
  assert.equal(beat.data.companionId, A.companion);
  assert.ok(Array.isArray(beat.data.feed.items) && Array.isArray(beat.data.notifications.items));
  assert.equal(beat.data.checkAfterSeconds, 1800);
  const soon = await call(token, "agent/heartbeat");
  assert.equal(soon.status, 429);
  assert.ok(Number(soon.headers.get("retry-after")) > 0);
  passed("an Owner's key lets the agent read the feed and notifications as its Companion, once a minute");

  // ---- the key reaches nothing else ----
  for (const [path, method] of [["chats", "GET"], [keys, "GET"], [keys, "POST"], [`companions/${A.companion}/memories`, "GET"],
    ["community/feed?actorKind=COMPANION&actorId=" + A.companion, "GET"]] as const) {
    assert.equal((await call(token, path, method, method === "POST" ? { name: "more" } : undefined)).status, 403, `${method} ${path}`);
  }
  assert.equal((await call("heartbeat-0", "agent/heartbeat")).status, 404, "an Owner sign-in is not an agent");
  assert.equal((await call("cak_" + "x".repeat(43), "agent/heartbeat")).status, 401, "an unknown key");
  passed("an agent key reaches only the heartbeat; unknown keys are refused");

  // ---- listing, other Owners, revoking, expiry, the limit ----
  const list = await call<{ items: Key[] }>("heartbeat-0", keys);
  assert.equal(list.data.items.length, 1);
  assert.ok(list.data.items[0]!.lastUsedAt !== null, "the last use is shown");
  assert.ok(!JSON.stringify(list.data).includes("cak_") && !("token" in list.data.items[0]!), "no token in the list");
  assert.equal((await call("heartbeat-1", keys, "GET", undefined, bases[1])).status, 404);
  assert.equal((await call("heartbeat-1", `${keys}/${made.data.id}`, "DELETE", undefined, bases[1])).status, 404);
  assert.equal((await call("heartbeat-1", keys, "POST", { name: "steal" }, bases[1])).status, 404);
  const revoked = await call<Key>("heartbeat-0", `${keys}/${made.data.id}`, "DELETE");
  assert.deepEqual([revoked.status, revoked.data.active], [200, false]);
  assert.equal((await call(token, "agent/heartbeat")).status, 401, "a revoked key stops at once");
  const second = (await call<Key>("heartbeat-0", keys, "POST", { name: "第二个" })).data;
  assert.equal(Date.parse(second.expiresAt) - Date.now() > 29 * 86_400_000, true, "30 days by default");
  await pool.query("update companion_private.agent_keys set created_at = now() - interval '31 days', expires_at = now() - interval '1 day' where id = $1", [second.id]);
  assert.equal((await call(second.token!, "agent/heartbeat")).status, 401, "an expired key");
  for (let i = 0; i < 5; i += 1) assert.equal((await call("heartbeat-0", keys, "POST", { name: `k${i}` })).status, 201);
  assert.equal((await call("heartbeat-0", keys, "POST", { name: "too many" })).status, 409, "five live keys at most");
  const audit = await pool.query("select action, count(*)::int n from public.audit_events where target_type = 'AGENT_KEY' group by 1 order by 1");
  assert.deepEqual(audit.rows, [{ action: "AGENT_KEY_CREATE", n: 7 }, { action: "AGENT_KEY_REVOKE", n: 1 }]);
  const privileges = await pool.query(`select has_function_privilege('authenticated', 'public.agent_key_resolve(text)', 'EXECUTE') as resolve,
    has_function_privilege('authenticated', 'public.agent_key_create(uuid,text,text,integer)', 'EXECUTE') as create_key,
    has_table_privilege('authenticated', 'companion_private.agent_keys', 'SELECT') as read_table`);
  assert.deepEqual(privileges.rows[0], { resolve: false, create_key: false, read_table: false });
  passed("keys are the Owner's alone, revocable, expiring, at most five, audited, and only the server resolves them");
} finally {
  await pool.query("delete from companion_private.agent_keys where companion_id = $1", [A.companion]).catch(() => undefined);
  await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
  await pool.end();
}
console.log(`Heartbeat integration passed (${groups} groups).`);
