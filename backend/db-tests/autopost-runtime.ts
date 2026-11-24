import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createMobileDevHttpServer } from "../src/dev/mobile-http-server.ts";
import { createPgPool, PgOwnerExecutor } from "../src/persistence/postgres/index.ts";
import { PostgresChatAdapter } from "../src/chat/postgres.ts";
import { BackgroundScheduler } from "../src/chat/background-scheduler.ts";
import { ChatCatalog } from "../src/chat/models.ts";
import { PlatformChatModel } from "../src/chat/platform.ts";
import { ChatReplies, devChatModel, type ChatModel } from "../src/chat/replies.ts";
import type { AgentDraft, CommunityPage, CommunityPost, CommunityProfile } from "../../contracts/community.ts";

// A Companion posting on its own, and an Owner's agent handing posts in with its key (migration 0057).
const connectionString = process.env.DATABASE_URL;
if (!connectionString || process.env.COMPANION_SOCIAL_DEV_DATABASE !== "1") throw Error("Disposable seeded development database required.");
const pool = createPgPool(connectionString);
const ids = (letter: "a" | "b") => ({ owner: `00000000-0000-0000-0000-0000000001${letter}1`,
  subject: `00000000-0000-0000-0000-0000000000${letter}1`, companion: `00000000-0000-0000-0000-0000000002${letter}1` });
const A = ids("a"), B = ids("b");
const servers = [A, B].map((v, i) => createMobileDevHttpServer({ pool, ownerId: v.owner, ownerSubject: v.subject, bearerToken: `autopost-${i}` }));
const portA = new PostgresChatAdapter(new PgOwnerExecutor(pool, A.subject));
const server = new PgOwnerExecutor(pool, null);
const asA = `actorKind=COMPANION&actorId=${A.companion}`;
let groups = 0;
const passed = (name: string) => { groups += 1; console.log(`Auto post integration ${groups}: ${name}`); };

try {
  const bases = await Promise.all(servers.map(listener => new Promise<string>(resolve =>
    listener.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(listener.address() as AddressInfo).port}`)))));
  async function call<T>(who: 0 | 1, path: string, method = "GET", body?: unknown, auth = `autopost-${who}`, key: string = randomUUID()) {
    const response = await fetch(`${bases[who]}/v0/${path}`, {
      method, headers: { Authorization: `Bearer ${auth}`, "Content-Type": "application/json", "Idempotency-Key": key },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json() as T };
  }
  const me = (await call<CommunityProfile>(0, `community/profile?${asA}`)).data;
  const set = (changes: string) => pool.query(`insert into companion_private.agent_settings(actor_id) values ($1)
    on conflict (actor_id) do nothing`, [me.id]).then(() => pool.query(`update companion_private.agent_settings set ${changes} where actor_id = $1`, [me.id]));
  const due = async (platform = true) => (await server.query<{ payload: { companionId: string; subject: string }[] }>(
    "select public.agent_auto_due(10, $1) as payload", [platform])).rows[0]!.payload;
  const drafts = async () => (await call<{ items: AgentDraft[] }>(0, `community/agent/drafts?${asA}`)).data.items;
  const runs = async () => (await pool.query("select status from companion_private.agent_runs where actor_id = $1 order by created_at, id", [me.id]))
    .rows.map(r => r.status as string);
  // Makes the interval pass, as if the last run was long ago.
  const later = () => pool.query("update companion_private.agent_runs set created_at = created_at - interval '1 day' where actor_id = $1", [me.id]);
  const write = (model: ChatModel = devChatModel) => new ChatReplies(model).writePost(A.companion, portA);
  await pool.query("delete from companion_private.agent_drafts where actor_id = $1", [me.id]);
  await pool.query("delete from companion_private.agent_settings where actor_id = $1", [me.id]); // start from the defaults
  // The suites before this one posted as this Companion today; make that yesterday's, so today's limits start fresh.
  await pool.query("update public.community_posts set created_at = created_at - interval '2 days' where actor_id = $1", [me.id]);
  const refusal = async () => (await pool.query(`select companion_private.agent_refusal(s, companion_private.agent_settings_json(s), 'POST', null) as reason
    from companion_private.agent_settings s where s.actor_id = $1`, [me.id])).rows[0]?.reason as string | null;

  // ---- off by default; on only inside what the Owner's settings allow ----
  await set("active_from = '00:00', active_to = '00:00', interval_minutes = 15");
  assert.deepEqual(await due(), [], "autoEnabled is off by default");
  assert.equal(await write(), "OFF");
  await set("auto_enabled = true");
  assert.deepEqual(await due(), [], "posting is not allowed by default (canPost)");
  assert.equal(await write(), "REFUSED");
  await set("can_post = true");
  assert.deepEqual(await due(), [{ companionId: A.companion, subject: A.subject }], `refused: ${await refusal()}`);
  assert.deepEqual(await due(false), [], "no platform model: only Companions on their Owner's own key or agent");
  await set("paused = true");
  assert.deepEqual(await due(), []);
  assert.equal(await write(), "REFUSED");
  await set("paused = false");
  assert.deepEqual(await runs(), [], "nothing was started while it was off or refused");
  passed("off by default; due only when the Owner turned it on and allows posting");

  // ---- a run ends as a draft for the Owner ----
  assert.equal(await write(), "DRAFT");
  const waiting = await drafts();
  assert.equal(waiting.length, 1);
  assert.match(waiting[0]!.body, /^（开发环境假动态）我是SampleCompanion/);
  assert.deepEqual(await runs(), ["DRAFT"]);
  assert.equal((await pool.query("select count(*)::int n from public.life_event_inbox where kind = 'AGENT_DRAFT' and target_id = $1", [waiting[0]!.id])).rows[0]!.n, 1,
    "the Owner is told a draft is waiting");
  assert.deepEqual(await due(), [], "not again until the interval passes");
  assert.equal(await write(), "NOT_DUE");
  const published = await call<{ published: CommunityPost }>(0, `community/agent/drafts/${waiting[0]!.id}/publish?${asA}`, "POST");
  assert.deepEqual([published.status, published.data.published.body, published.data.published.source], [200, waiting[0]!.body, "OWNER_PROXY"]);
  passed("a post of its own waits as a draft; the Owner publishes it");

  // ---- DIRECT publishes; passing and failing also count for the interval ----
  await later();
  await set("publish_mode = 'DIRECT'");
  assert.equal(await write(), "PUBLISHED");
  const feed = (await call<CommunityPage<CommunityPost>>(0, `community/feed?${asA}&authorId=${me.id}`)).data.items;
  const nth = (body: string) => Number(/这是我发的第 (\d+) 条/.exec(body)![1]);
  assert.equal(nth(feed[0]!.body), Math.min(nth(waiting[0]!.body) + 1, 6), "it saw its own earlier post (the latest 5)");
  await later();
  assert.equal(await write({ reply: async () => ({ pass: true }), post: async () => ({ pass: true }) }), "NOTHING");
  assert.deepEqual(await due(), [], "having nothing to say also waits for the next interval");
  await later();
  assert.equal(await write({ reply: async () => ({ pass: true }), post: async () => { throw new Error("model down"); } }), "FAILED");
  assert.deepEqual(await runs(), ["DRAFT", "PUBLISHED", "NOTHING", "FAILED"]);
  await later();
  const today = (await call<{ usage: { postsToday: number } }>(0, `community/agent/settings?${asA}`)).data.usage.postsToday;
  await set(`daily_posts = ${today}`);
  assert.deepEqual(await due(), [], "the daily limit counts posts of its own too");
  assert.equal(await write(), "REFUSED");
  await set("daily_posts = 30");
  passed("DIRECT publishes at once; nothing to say, failures and the daily limit are respected");

  // ---- one run at a time; an abandoned run is closed ----
  await pool.query(`insert into companion_private.agent_runs(actor_id, companion_id, status, claim_id) values ($1, $2, 'WRITING', gen_random_uuid())`, [me.id, A.companion]);
  assert.equal(await write(), "WRITING");
  await pool.query("update companion_private.agent_runs set created_at = now() - interval '1 day' where actor_id = $1 and status = 'WRITING'", [me.id]);
  await later();
  assert.equal(await write(), "PUBLISHED", "an abandoned run fails and the next one goes ahead");
  assert.equal((await runs()).filter(s => s === "WRITING").length, 0);
  passed("one run at a time per Companion; abandoned runs are closed");

  // ---- platform models: booked as a community post; the scheduler writes as the Owner ----
  const catalog = new ChatCatalog({ defaultModel: "fake", decisionModel: null, providers: { fakep: { kind: "anthropic", apiKeyEnv: "FAKE_KEY" } },
    models: [{ id: "fake", name: "Fake", provider: "fakep", model: "fake-1", tier: "ECONOMY", inputPerMTok: 1, outputPerMTok: 1, enabled: true }] }, { FAKE_KEY: "k" });
  const engine = new PlatformChatModel(catalog, async () => ({ text: "今天的云很好看。", inputTokens: 200, outputTokens: 20, refused: false, cutOff: false }));
  await later();
  const wrote: string[] = [];
  const scheduler = new BackgroundScheduler({ server, portFor: subject => new PostgresChatAdapter(new PgOwnerExecutor(pool, subject)),
    due: "agent_auto_due", what: "community post", platform: true, log: message => { throw new Error(message); },
    write: async (companionId, port) => { wrote.push(companionId); return new ChatReplies(engine).writePost(companionId, port); } });
  assert.equal(await scheduler.round(), 1);
  assert.deepEqual(wrote, [A.companion]);
  assert.equal((await call<CommunityPage<CommunityPost>>(0, `community/feed?${asA}&authorId=${me.id}`)).data.items[0]!.body, "今天的云很好看。");
  const ledger = await pool.query(`select x.reason_code, string_agg(e.status, '>' order by e.sequence) as s
    from public.compute_transactions x join public.compute_ledger_entries e on e.transaction_id = x.id
    where x.trigger_event_type = 'COMMUNITY_POST' and x.companion_id = $1 group by x.id, x.reason_code`, [A.companion]);
  assert.deepEqual(ledger.rows, [{ reason_code: "COMMUNITY_POST", s: "RESERVED>STARTED>SUCCEEDED" }]);
  assert.equal(await scheduler.round(), 0, "nothing is due right after");
  const privilege = await pool.query(`select has_function_privilege('authenticated', 'public.agent_auto_begin(uuid)', 'EXECUTE') as app,
    has_function_privilege('companion_api', 'public.agent_auto_due(integer,boolean)', 'EXECUTE') as server`);
  assert.deepEqual(privilege.rows[0], { app: false, server: true }, "only the API server starts runs");
  passed("platform model calls are booked as COMMUNITY_POST and settled; the scheduler writes as the Owner");

  // ---- an Owner's agent hands in a post with its key ----
  await set("auto_enabled = false, publish_mode = 'DRAFT'");
  const keys = `companions/${A.companion}/agent-keys`;
  await pool.query("delete from companion_private.agent_keys where companion_id = $1", [A.companion]); // the heartbeat suite fills the limit of 5
  const readOnly = (await call<{ token: string; scopes: string[] }>(0, keys, "POST", { name: "只读" })).data;
  const writer = (await call<{ token: string; scopes: string[] }>(0, keys, "POST", { name: "能交稿", scopes: ["COMMUNITY_DRAFT", "COMMUNITY_READ"] })).data;
  assert.deepEqual([readOnly.scopes, writer.scopes], [["COMMUNITY_READ"], ["COMMUNITY_DRAFT", "COMMUNITY_READ"]]);
  assert.equal((await call(0, keys, "POST", { name: "乱来", scopes: ["CHAT"] })).status, 400);
  assert.equal((await call(0, "agent/posts", "POST", { body: "只读钥匙想发帖" }, readOnly.token)).status, 403);
  const handKey = randomUUID();
  const handed = await call<{ status: string; draftId: string }>(0, "agent/posts", "POST", { body: " 外部 Agent 写的动态 " }, writer.token, handKey);
  assert.deepEqual([handed.status, handed.data.status], [200, "DRAFT"], JSON.stringify(handed.data));
  assert.equal((await call<{ draftId: string }>(0, "agent/posts", "POST", { body: "外部 Agent 写的动态" }, writer.token, handKey)).data.draftId,
    handed.data.draftId, "a retry is the same draft");
  assert.deepEqual((await drafts()).map(d => [d.id, d.body]), [[handed.data.draftId, "外部 Agent 写的动态"]]);
  await set("can_post = false");
  const refused = await call<{ status: string; reason: string }>(0, "agent/posts", "POST", { body: "不让发的时候" }, writer.token);
  assert.deepEqual([refused.data.status, refused.data.reason], ["REFUSED", "NOT_ALLOWED"], "the agent settings decide, as for the Companion itself");
  assert.equal((await call(0, "agent/posts", "POST", { body: "" }, writer.token)).status, 400);
  assert.equal((await call(0, "agent/heartbeat", "GET", undefined, writer.token)).status, 200, "the same key still checks in");
  assert.equal((await call(0, "chats", "GET", undefined, writer.token)).status, 403, "and reaches nothing else");
  passed("an agent key with the draft scope hands in posts under the same settings; a read-only key cannot");

  // Leave the shared development database as other suites expect it.
  await pool.query("delete from public.life_event_inbox where kind = 'AGENT_DRAFT' and companion_id = $1", [A.companion]);
  await pool.query("delete from companion_private.agent_drafts where actor_id = $1", [me.id]);
  await pool.query("delete from companion_private.agent_runs where actor_id = $1", [me.id]);
  await pool.query("delete from companion_private.agent_keys where companion_id = $1", [A.companion]);
  await pool.query("update public.community_posts set deleted_at = now() where actor_id = $1 and deleted_at is null", [me.id]);
  await pool.query("delete from companion_private.agent_settings where actor_id = $1", [me.id]);
} finally {
  await Promise.all(servers.map(listener => new Promise(resolve => listener.close(resolve))));
  await pool.end();
}
console.log(`Auto post integration: ${groups} groups passed`);
