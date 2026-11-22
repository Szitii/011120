import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createMobileDevHttpServer } from "../src/dev/mobile-http-server.ts";
import { createPgPool } from "../src/persistence/postgres/index.ts";
import type {
  ActorContext, AgentDraft, AgentSettings, AgentSettingsView, CommunityDetail, CommunityFollow, CommunityPage, CommunityPost, CommunityProfile,
} from "../../contracts/community.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString || process.env.COMPANION_SOCIAL_DEV_DATABASE !== "1") throw Error("Disposable seeded development database required.");
const pool = createPgPool(connectionString);
const ids = (letter: "a" | "b") => ({ owner: `00000000-0000-0000-0000-0000000001${letter}1`,
  subject: `00000000-0000-0000-0000-0000000000${letter}1`, companion: `00000000-0000-0000-0000-0000000002${letter}1`,
  twin: `00000000-0000-0000-0000-0000000005${letter}1`, persona: `00000000-0000-0000-0000-0000000004${letter}1` });
const A = ids("a"), B = ids("b");
const humanA: ActorContext = { kind: "OWNER", id: A.owner }, humanB: ActorContext = { kind: "OWNER", id: B.owner };
const aiA: ActorContext = { kind: "COMPANION", id: A.companion }, aiB: ActorContext = { kind: "COMPANION", id: B.companion };
const servers = [A, B].map((v, i) => createMobileDevHttpServer({ pool, ownerId: v.owner, ownerSubject: v.subject, bearerToken: `test-${i}` }));
let groups = 0;
const passed = (name: string) => { groups += 1; console.log(`Agent integration ${groups}: ${name}`); };

try {
  const bases = await Promise.all(servers.map(server => new Promise<string>(resolve =>
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)))));
  async function call<T>(who: 0 | 1, actor: ActorContext, path: string, method = "GET", body?: unknown, key = randomUUID()) {
    const params = new URLSearchParams({ actorKind: actor.kind, actorId: actor.id });
    const response = await fetch(`${bases[who]}/v0/community/${path}${path.includes("?") ? "&" : "?"}${params}`, {
      method, headers: { Authorization: `Bearer test-${who}`, "Content-Type": "application/json", "Idempotency-Key": key },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json() as T };
  }
  const tool = (actor: ActorContext, name: string, args: object, key?: ReturnType<typeof randomUUID>) =>
    call<{ text: string }>(0, actor, `agent/${name}`, "POST", args, key);
  const current = async () => (await call<AgentSettingsView>(0, aiA, "agent/settings")).data;
  const save = async (change: Partial<AgentSettings>) => {
    const { usage: _u, localTime: _t, ...now } = await current();
    const r = await call<AgentSettingsView>(0, aiA, "agent/settings", "PUT", { ...now, ...change });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data;
  };

  // A human post for the AI to comment on, written directly: earlier suites used up human B's hourly limit.
  const hb = (await call<CommunityProfile>(1, humanB, "profile")).data;
  const target = (await pool.query<{ id: string }>(
    "insert into public.community_posts(actor_id, body, source) values ($1, 'A post for the agent suite', 'HUMAN_MANUAL') returning id", [hb.id])).rows[0]!.id;

  const audited = async () => Number((await pool.query("select count(*) from public.audit_events where action = 'AGENT_UPDATE_SETTINGS'")).rows[0]!.count);
  const auditBefore = await audited();
  const defaults = await current();
  assert.deepEqual({ ...defaults, usage: undefined, localTime: undefined, revision: undefined }, {
    paused: false, autoEnabled: false, intervalMinutes: 180, activeFrom: "09:00", activeTo: "23:00", timeZone: "Asia/Shanghai",
    canPost: false, canComment: true, canFollow: false, publishMode: "DRAFT", dailyPosts: 3, dailyComments: 10, dailyFollows: 5, commentsPerPost: 3,
    usage: undefined, localTime: undefined, revision: undefined,
  });
  assert.match(defaults.localTime, /^\d{1,2}\/\d{1,2} \d{2}:\d{2}$/);
  assert.equal((await call(0, humanA, "agent/settings")).status, 403);
  assert.equal((await call(0, aiB, "agent/settings")).status, 404);
  passed("defaults on first read; human actors and other Owners' Companions are refused");

  // All-day UTC hours keep the rest of the suite independent of when it runs.
  const base = await save({ activeFrom: "00:00", activeTo: "00:00", timeZone: "UTC" });
  assert.equal(base.revision, defaults.revision + 1);
  const stale = await call(0, aiA, "agent/settings", "PUT", { ...base, usage: undefined, localTime: undefined, revision: defaults.revision });
  assert.equal(stale.status, 409);
  const { usage: _pu, localTime: _pt, ...plain } = base;
  for (const bad of [{ timeZone: "Mars/Olympus" }, { dailyPosts: 31 }, { intervalMinutes: 5 }, { commentsPerPost: 0 }]) {
    assert.equal((await call(0, aiA, "agent/settings", "PUT", { ...plain, ...bad })).status, 400, JSON.stringify(bad));
  }
  assert.equal(await audited(), auditBefore + 1);
  passed("settings update with revision conflict, database range checks, time zone check and audit");

  const refused = await tool(aiA, "post", { text: "Not allowed by default" });
  assert.deepEqual(refused, { status: 403, data: { text: '主人没有开启"自己发新帖"，现在不能发帖。' } });
  const draftKey = randomUUID();
  const drafted = await tool(aiA, "comment", { postId: target, text: "  A drafted comment  " }, draftKey);
  assert.equal(drafted.status, 202, drafted.data.text);
  const draftId = /\[草稿 ([0-9a-f-]{36})\]/.exec(drafted.data.text)![1]!;
  assert.deepEqual(await tool(aiA, "comment", { postId: target, text: "A drafted comment" }, draftKey), drafted);
  assert.equal((await tool(aiA, "comment", { postId: target, text: "Different text" }, draftKey)).status, 409);
  const drafts = (await call<{ items: AgentDraft[] }>(0, aiA, "agent/drafts")).data.items;
  assert.deepEqual(drafts.map(d => [d.id, d.kind, d.postId, d.body]), [[draftId, "COMMENT", target, "A drafted comment"]]);
  assert.equal((await call(1, aiB, "agent/drafts")).status, 200);
  assert.equal((await call<{ items: AgentDraft[] }>(1, aiB, "agent/drafts")).data.items.length, 0);
  assert.equal((await call<CommunityDetail>(1, humanB, `posts/${target}`)).data.post.commentsCount, 0);
  assert.equal((await current()).usage.commentsToday, base.usage.commentsToday + 1);
  const textError = "内容为空或太长：帖子最多 4000 字，评论最多 2000 字。帖子和账号要用完整编号。";
  for (const args of [{ postId: target, text: "   " }, { postId: target, text: "\u{1F600}".repeat(2001) }, { postId: "p7", text: "hi" }]) {
    assert.deepEqual(await tool(aiA, "comment", args), { status: 400, data: { text: textError } });
  }
  // A Companion whose public identity is not active gets no draft it could never publish.
  const privatePersona = randomUUID();
  await pool.query(`insert into public.social_personas(id,owner_id,companion_id,version,handle,display_name,public_document,profile_visibility,
    source_identity_version_id,source_identity_version,source_identity_content_hash,projection_manifest,content_hash,approved_by_owner_at)
    select $1,owner_id,companion_id,version+100,handle,display_name,public_document,'PRIVATE',source_identity_version_id,source_identity_version,
    source_identity_content_hash,projection_manifest,content_hash,approved_by_owner_at from public.social_personas where id=$2`, [privatePersona, A.persona]);
  await pool.query("update public.social_twins set active_social_persona_id=$1 where id=$2", [privatePersona, A.twin]);
  try {
    assert.deepEqual(await tool(aiA, "comment", { postId: target, text: "Hidden identity" }),
      { status: 403, data: { text: "这个家机的公开身份还没启用，暂时不能发言或关注。" } });
  } finally {
    await pool.query("update public.social_twins set active_social_persona_id=$1 where id=$2", [A.persona, A.twin]);
  }
  assert.equal((await call<{ items: AgentDraft[] }>(0, aiA, "agent/drafts")).data.items.length, 1);
  passed("defaults refuse posting and draft comments; drafts replay, stay private, count toward today, and bad input or an inactive identity makes none");

  assert.equal((await call(1, aiB, `agent/drafts/${draftId}/publish`, "POST")).status, 404);
  const published = await call<{ published: { id: string; source: string } }>(0, aiA, `agent/drafts/${draftId}/publish`, "POST");
  assert.equal(published.status, 200, JSON.stringify(published.data));
  assert.equal(published.data.published.source, "OWNER_PROXY");
  const detail = (await call<CommunityDetail>(1, humanB, `posts/${target}`)).data;
  assert.deepEqual(detail.comments.items.map(c => c.body), ["A drafted comment"]);
  assert.equal((await call(0, aiA, `agent/drafts/${draftId}/publish`, "POST")).status, 404);
  assert.equal((await current()).usage.commentsToday, base.usage.commentsToday + 1);
  // The AI retrying its original request after the Owner decided gets that decision, not a new draft.
  const replayed = await tool(aiA, "comment", { postId: target, text: "A drafted comment" }, draftKey);
  assert.deepEqual(replayed, { status: 201, data: { text: `已评论 [帖子 ${target}]：[评论 ${published.data.published.id}]` } });
  const secondKey = randomUUID();
  const second = await tool(aiA, "comment", { postId: target, text: "Second draft" }, secondKey);
  const secondId = /\[草稿 ([0-9a-f-]{36})\]/.exec(second.data.text)![1]!;
  assert.deepEqual((await call(0, aiA, `agent/drafts/${secondId}/discard`, "POST")).data, { discarded: true });
  assert.deepEqual(await tool(aiA, "comment", { postId: target, text: "Second draft" }, secondKey),
    { status: 200, data: { text: "这条内容主人看过了，决定不发布。" } });
  assert.equal((await call(0, aiA, `agent/drafts/${secondId}/publish`, "POST")).status, 404);
  assert.equal((await call<CommunityDetail>(1, humanB, `posts/${target}`)).data.comments.items.length, 1);
  assert.equal((await call<{ items: AgentDraft[] }>(0, aiA, "agent/drafts")).data.items.length, 0);
  passed("the Owner publishes or discards a draft; the AI's retry then gets that decision");

  const used = (await current()).usage;
  await save({ canPost: true, publishMode: "DIRECT", dailyPosts: used.postsToday + 1, commentsPerPost: 1 });
  const postKey = randomUUID();
  const direct = await tool(aiA, "post", { text: "Published directly by the agent" }, postKey);
  assert.equal(direct.status, 201, direct.data.text);
  const postId = /\[帖子 ([0-9a-f-]{36})\]/.exec(direct.data.text)![1]!;
  assert.ok((await call<CommunityPage<CommunityPost>>(1, humanB, "feed")).data.items.some(p => p.id === postId));
  assert.deepEqual(await tool(aiA, "post", { text: "One too many" }),
    { status: 429, data: { text: `今天的发帖次数已用完（${used.postsToday + 1}/${used.postsToday + 1}），明天再来。` } });
  assert.deepEqual(await tool(aiA, "post", { text: "Published directly by the agent" }, postKey), direct);
  assert.deepEqual(await tool(aiA, "comment", { postId: target, text: "Second comment on the same post" }),
    { status: 429, data: { text: "你在这个帖子下已经评论了 1 条，达到上限，换个帖子吧。" } });
  passed("direct publishing, daily limit, retry replay past the limit and the per-post comment limit");

  // The AI and its Owner (by hand, as the same Companion) writing at once must not deadlock.
  const busy = (await pool.query<{ id: string }>(
    "insert into public.community_posts(actor_id, body, source) values ($1, 'A busy post', 'HUMAN_MANUAL') returning id", [hb.id])).rows[0]!.id;
  const now = (await current()).usage;
  await save({ dailyComments: Math.min(100, now.commentsToday + 10), commentsPerPost: 10 });
  const racing = await Promise.all(Array.from({ length: 8 }, (_, i) => i % 2 === 0
    ? tool(aiA, "comment", { postId: busy, text: `agent ${i}` })
    : call<unknown>(0, aiA, `posts/${busy}/comments`, "POST", { body: `owner ${i}` })));
  assert.deepEqual(racing.map(r => r.status), [201, 201, 201, 201, 201, 201, 201, 201]);
  passed("concurrent AI and Owner comments on the same post take locks in one order and all succeed");

  const ca = (await call<CommunityProfile>(0, aiA, "profile")).data;
  assert.deepEqual(await tool(aiA, "follow", { actorId: hb.id }),
    { status: 403, data: { text: '主人没有开启"关注别人"，现在不能关注。' } });
  const follows = (await current()).usage.followsToday;
  await save({ canFollow: true, dailyFollows: follows + 1 });
  assert.deepEqual(await tool(aiA, "follow", { actorId: ca.id }),
    { status: 400, data: { text: "参数不对：账号要用完整编号，也不能关注自己。" } });
  assert.deepEqual(await tool(aiA, "follow", { actorId: hb.id }), { status: 200, data: { text: `已关注 [账号 ${hb.id}]` } });
  assert.match((await tool(aiA, "following", {})).data.text, new RegExp(`【你关注的人】\\n- \\[账号 ${hb.id}\\] `));
  const followingList = (await call<CommunityPage<CommunityFollow>>(0, aiA, "following")).data;
  assert.deepEqual(followingList.items.map(f => f.actor.id), [hb.id]);
  assert.ok((await call<CommunityPage<CommunityFollow>>(1, humanB, "followers")).data.items.some(f => f.actor.id === ca.id));
  assert.equal((await call(0, aiA, "following?cursor=bad")).status, 400);
  assert.deepEqual(await tool(aiA, "unfollow", { actorId: hb.id }), { status: 200, data: { text: `已取消关注 [账号 ${hb.id}]` } });
  assert.equal((await call<CommunityPage<CommunityFollow>>(0, aiA, "following")).data.items.length, 0);
  assert.deepEqual(await tool(aiA, "follow", { actorId: hb.id }),
    { status: 429, data: { text: `今天的关注次数已用完（${follows + 1}/${follows + 1}），明天再来。` } });
  passed("following: off by default, then follow, list, followers, unfollow and the daily follow limit");

  await save({ publishMode: "DRAFT", dailyPosts: 30 });
  const pending = (await current()).usage;
  assert.equal(pending.pendingDrafts, 0);
  assert.ok(pending.postsToday + 20 <= 30, `posts today: ${pending.postsToday}`);
  for (let i = 0; i < 20; i++) assert.equal((await tool(aiA, "post", { text: `draft ${i}` })).status, 202);
  assert.deepEqual(await tool(aiA, "post", { text: "one more" }),
    { status: 429, data: { text: "草稿箱已满（20 条等主人处理），等主人处理完再写。" } });
  assert.equal((await call<{ items: AgentDraft[] }>(0, aiA, "agent/drafts")).data.items.length, 20);
  passed("at most 20 drafts wait for the Owner; the list always shows all of them");

  const hour = new Date().getUTCHours();
  const later = (h: number) => `${String((hour + h) % 24).padStart(2, "0")}:00`;
  await save({ activeFrom: later(2), activeTo: later(4) });
  assert.deepEqual(await tool(aiA, "comment", { postId: postId, text: "Too late" }),
    { status: 403, data: { text: `现在不在活动时间（${later(2)}–${later(4)}，UTC），请在活动时间内再来。` } });
  await save({ paused: true, activeFrom: "00:00", activeTo: "00:00" });
  assert.deepEqual(await tool(aiA, "comment", { postId: postId, text: "Paused" }),
    { status: 403, data: { text: "主人暂停了你的活动：现在只能看，不能发言或关注。" } });
  assert.match((await tool(aiA, "home", {})).data.text, /\n主人暂停了你的活动：现在只能看，不能发言或关注。\n/);
  passed("activity hours and the pause switch refuse writes; home tells the AI it is paused");

  const denied = await pool.connect();
  try {
    await denied.query("begin"); await denied.query("set local role authenticated");
    for (const table of ["agent_drafts", "agent_settings"]) {
      await denied.query("savepoint probe");
      await assert.rejects(denied.query(`select * from companion_private.${table}`), e => (e as { code?: string }).code === "42501");
      await denied.query("rollback to savepoint probe");
    }
  } finally { await denied.query("rollback"); denied.release(); }
  passed("drafts and settings are not readable directly by signed-in users");
  console.log(`Agent PostgreSQL/HTTP integration passed: ${groups} scenario groups.`);
} finally {
  await Promise.all(servers.map(server => new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()))));
  await pool.end();
}
