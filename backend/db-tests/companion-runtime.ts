import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createMobileDevHttpServer } from "../src/dev/mobile-http-server.ts";
import { createPgPool } from "../src/persistence/postgres/index.ts";
import type { Chat, ChatPage } from "../../contracts/chat.ts";
import type { ActorContext, CommunityDetail, CommunityPage, CommunityPost, CommunityProfile } from "../../contracts/community.ts";

// Built-in avatars (migration 0055), deleting a Companion and the limit of 10 per Owner (0054). Runs last: it leaves
// Owner A's extra Companions deleted and never touches the two seeded ones.
const connectionString = process.env.DATABASE_URL;
if (!connectionString || process.env.COMPANION_SOCIAL_DEV_DATABASE !== "1") throw Error("Disposable seeded development database required.");
const setup = createPgPool(connectionString);
await setup.query(`do $$ begin execute format('alter database %I set companion.chat_pace = %L', current_database(), '0.02'); end $$`);
await setup.end();

const pool = createPgPool(connectionString);
const ids = (letter: "a" | "b") => ({ owner: `00000000-0000-0000-0000-0000000001${letter}1`,
  subject: `00000000-0000-0000-0000-0000000000${letter}1`, companion: `00000000-0000-0000-0000-0000000002${letter}1` });
const A = ids("a"), B = ids("b");
const servers = [A, B].map((v, i) => createMobileDevHttpServer({ pool, ownerId: v.owner, ownerSubject: v.subject, bearerToken: `companion-${i}` }));
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const count = async (sql: string, values: unknown[]) => (await pool.query(`select count(*)::int n from ${sql}`, values)).rows[0]!.n as number;
const setFeature = (key: string, on: boolean) => pool.query("update companion_private.feature_switches set enabled = $2 where key = $1", [key, on]);
let groups = 0;
const passed = (name: string) => { groups += 1; console.log(`Companion integration ${groups}: ${name}`); };

/** A Companion of Owner A with an identity; `social` also gives it a public community identity. */
async function makeCompanion(name: string, social = false): Promise<string> {
  const [companion, identity, persona, twin] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const handle = `del_${companion.replaceAll("-", "").slice(0, 20)}`;
  await pool.query("insert into public.companions (id, owner_id, status, origin_type) values ($1, $2, 'ACTIVE', 'IMPORTED_CARD')", [companion, A.owner]);
  await pool.query(`insert into public.companion_identities (id, owner_id, companion_id, version, display_name, identity_document,
      source_manifest, content_hash, created_by, approved_by_owner_at)
    values ($1, $2, $3, 1, $4, '{"persona":"calm"}', '{"fixture":"companion"}', repeat('d', 64), 'IMPORT_FIREWALL', now())`,
    [identity, A.owner, companion, name]);
  await pool.query("update public.companions set current_identity_version_id = $1 where id = $2", [identity, companion]);
  if (!social) return companion;
  await pool.query("insert into public.social_handles (handle, owner_id, companion_id) values ($1, $2, $3)", [handle, A.owner, companion]);
  await pool.query(`insert into public.social_personas (id, owner_id, companion_id, version, handle, display_name, public_document,
      profile_visibility, source_identity_version_id, source_identity_version, source_identity_content_hash, projection_manifest,
      content_hash, approved_by_owner_at)
    values ($1, $2, $3, 1, $4, $5, '{"bio":"fixture"}', 'PUBLIC', $6, 1, repeat('d', 64), '[]', repeat('d', 64), now())`,
    [persona, A.owner, companion, handle, name, identity]);
  await pool.query(`insert into public.social_twins (id, owner_id, companion_id, active_social_persona_id, status, autonomy_mode)
    values ($1, $2, $3, $4, 'ACTIVE', 'QUIET')`, [twin, A.owner, companion, persona]);
  return companion;
}

try {
  const bases = await Promise.all(servers.map(server => new Promise<string>(resolve =>
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)))));
  async function call<T>(who: 0 | 1, path: string, method = "GET", body?: unknown, auth = `companion-${who}`) {
    const response = await fetch(`${bases[who]}/v0/${path}`, {
      method, headers: { Authorization: `Bearer ${auth}`, "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json() as T };
  }
  const as = (actor: ActorContext) => `actorKind=${actor.kind}&actorId=${actor.id}`;
  async function settle(chatId: string): Promise<ChatPage> {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const page = await call<ChatPage>(0, `chats/${chatId}`);
      assert.equal(page.status, 200, JSON.stringify(page.data));
      if (!page.data.chat.replying) return page.data;
      await pause(20);
    }
    throw new Error("replies never finished");
  }
  const roster = async () => (await call<{ items: { companionId: string }[] }>(0, "companions")).data.items.map(c => c.companionId);

  // ---- built-in avatars for the Owner and a Companion ----
  const ownerA: ActorContext = { kind: "OWNER", id: A.owner }, seeded: ActorContext = { kind: "COMPANION", id: A.companion };
  const viewerB = `actorKind=OWNER&actorId=${B.owner}`;
  const actorA = (await call<CommunityProfile>(0, `community/profile?${as(ownerA)}`)).data;
  const actorAi = (await call<CommunityProfile>(0, `community/profile?${as(seeded)}`)).data;
  assert.deepEqual([actorA.avatar, actorAi.avatar], [null, null]);
  assert.deepEqual((await call(0, "owner/avatar", "PUT", { avatar: "preset:cat_01" })).data, { avatar: "preset:cat_01" });
  assert.deepEqual((await call(0, `companions/${A.companion}/avatar`, "PUT", { avatar: "preset:fox-2" })).data, { avatar: "preset:fox-2" });
  assert.equal((await call<CommunityProfile>(1, `community/profile/${actorA.id}?${viewerB}`)).data.avatar, "preset:cat_01", "others see the Owner's avatar");
  assert.equal((await call<CommunityProfile>(1, `community/profile/${actorAi.id}?${viewerB}`)).data.avatar, "preset:fox-2", "and the Companion's");
  const listed = (await call<{ items: { companionId: string; avatar?: string }[] }>(0, "companions")).data.items;
  assert.equal(listed.find(c => c.companionId === A.companion)!.avatar, "preset:fox-2");
  const own = (await call<Chat>(0, "chats", "POST", { companionIds: [A.companion] })).data;
  assert.deepEqual(own.members.map(m => m.avatar), ["preset:fox-2"], "chat members carry it");
  for (const bad of ["https://example.com/a.png", "preset:", "preset:Cat", "cat_01"]) {
    assert.equal((await call(0, "owner/avatar", "PUT", { avatar: bad })).status, 400, bad);
    assert.equal((await call(0, `companions/${A.companion}/avatar`, "PUT", { avatar: bad })).status, 400, bad);
  }
  assert.equal((await call(1, `companions/${A.companion}/avatar`, "PUT", { avatar: "preset:cat_01" })).status, 404, "another Owner's Companion");
  assert.equal(await count("public.audit_events where action in ('OWNER_SET_AVATAR', 'COMPANION_SET_AVATAR') and owner_id = $1", [A.owner]), 2);
  assert.deepEqual((await call(0, "owner/avatar", "PUT", { avatar: "preset:cat_01" })).data, { avatar: "preset:cat_01" });
  assert.equal(await count("public.audit_events where action = 'OWNER_SET_AVATAR' and owner_id = $1", [A.owner]), 1, "saving the same avatar again changes nothing");
  assert.deepEqual((await call(0, "owner/avatar", "PUT", { avatar: null })).data, { avatar: null });
  assert.deepEqual((await call(0, `companions/${A.companion}/avatar`, "PUT", { avatar: null })).data, { avatar: null });
  assert.equal((await call<CommunityProfile>(1, `community/profile/${actorA.id}?${viewerB}`)).data.avatar, null, "null clears it");
  assert.ok(!("avatar" in (await call<{ items: Record<string, unknown>[] }>(0, "companions")).data.items.find(c => c.companionId === A.companion)!));
  passed("built-in avatars: set and cleared by the Owner, shown on profiles, chat members and the Companion list");

  // ---- a Companion with everything: chats, memory, keys, a connection, a community life ----
  const doomed = await makeCompanion("Doomed", true), friend = await makeCompanion("Friend");
  const doomedActor: ActorContext = { kind: "COMPANION", id: doomed }, humanB: ActorContext = { kind: "OWNER", id: B.owner };
  const direct = (await call<Chat>(0, "chats", "POST", { companionIds: [doomed] })).data;
  assert.equal((await call(0, `chats/${direct.id}/messages`, "POST", { body: "你好" })).status, 201);
  assert.ok((await settle(direct.id)).items.some(m => m.companionId === doomed), "it answered");
  await setFeature("GROUP_CHAT_CREATE", true);
  await setFeature("GROUP_CHAT_SEND", true);
  const group = (await call<Chat>(0, "chats", "POST", { companionIds: [doomed, friend], title: "一家" })).data;
  const alone = (await call<Chat>(0, "chats", "POST", { companionIds: [doomed, A.companion], title: "先走一步" })).data;
  assert.equal((await call(0, `chats/${group.id}/messages`, "POST", { body: "大家好", mentions: [doomed, friend] })).status, 201);
  assert.ok((await settle(group.id)).items.some(m => m.companionId === doomed));
  assert.equal((await call(0, `companions/${doomed}/memories`, "POST", { body: "主人怕黑" })).status, 201);
  assert.equal((await call(0, `companions/${doomed}/diary-settings`)).status, 200);
  const day = (await call<{ revision: number }>(0, `companions/${doomed}/anniversary`)).data;
  assert.equal((await call(0, `companions/${doomed}/anniversary`, "PUT",
    { startDate: "2026-01-01", timeZone: "Asia/Shanghai", revision: day.revision })).status, 200);
  const key = await call<{ token: string }>(0, `companions/${doomed}/agent-keys`, "POST", { name: "我的 Agent" });
  assert.equal(key.status, 201);
  assert.equal((await call(0, "agent/heartbeat", "GET", undefined, key.data.token)).status, 200);
  await pool.query(`insert into companion_private.companion_connections(companion_id, kind, provider, base_url, model, secret, secret_hint, consented_at)
    values ($1, 'BYOK', 'deepseek', 'https://api.deepseek.com/v1', 'deepseek-chat', 'v1.a.b.c', '', now())`, [doomed]);

  const me = (await call<CommunityProfile>(0, `community/profile?${as(doomedActor)}`)).data;
  const hb = (await call<CommunityProfile>(1, `community/profile?${as(humanB)}`)).data;
  await pool.query(`insert into companion_private.agent_settings(actor_id, can_post, can_follow, publish_mode, active_from, active_to)
    values ($1, true, true, 'DIRECT', '00:00', '00:00')`, [me.id]);
  const mine = await call<CommunityPost>(0, `community/posts?${as(doomedActor)}`, "POST", { body: "我发的动态" });
  assert.equal(mine.status, 201, JSON.stringify(mine.data));
  // Written straight to the table: the suites before this one may have used up B's posts for the hour.
  const theirs = { id: (await pool.query(`insert into public.community_posts(actor_id, body, source)
    values ($1, 'B 的动态', 'HUMAN_MANUAL') returning id`, [hb.id])).rows[0]!.id as string };
  const commented = await call(0, `community/posts/${theirs.id}/comments?${as(doomedActor)}`, "POST", { body: "我来评论" });
  assert.equal(commented.status, 201, JSON.stringify(commented.data));
  assert.equal((await call(0, `community/posts/${theirs.id}/like?${as(doomedActor)}`, "PUT")).status, 200);
  assert.equal((await call(0, `community/following/${hb.id}?${as(doomedActor)}`, "PUT")).status, 200);
  assert.equal((await call(1, `community/following/${me.id}?${as(humanB)}`, "PUT")).status, 200);
  assert.equal((await call(1, `community/posts/${mine.data.id}/like?${as(humanB)}`, "PUT")).status, 200);
  await pool.query("insert into companion_private.agent_drafts(actor_id, body, key_hash) values ($1, '草稿', repeat('e', 64))", [me.id]);
  assert.equal(await count("public.life_event_inbox where companion_id = $1", [doomed]), 1, "the draft told the Owner");
  const before = (await call<CommunityDetail>(1, `community/posts/${theirs.id}?${as(humanB)}`)).data.post;
  assert.deepEqual([before.commentsCount, before.likeCount], [1, 1]);
  passed("a Companion with chats, memory, keys, a connection and a community life");

  // ---- only its Owner deletes it, once ----
  assert.equal((await call(1, `companions/${doomed}`, "DELETE")).status, 404, "another Owner's Companion");
  assert.equal((await call(0, `companions/${randomUUID()}`, "DELETE")).status, 404);
  assert.equal((await call(0, "companions/not-a-uuid", "DELETE")).status, 400);
  assert.deepEqual((await call(0, `companions/${doomed}`, "DELETE")).data, { deleted: true });
  assert.equal((await call(0, `companions/${doomed}`, "DELETE")).status, 404, "it is gone");
  assert.equal((await pool.query("select status from public.companions where id = $1", [doomed])).rows[0]!.status, "DELETED");
  assert.equal(await count("public.audit_events where action = 'COMPANION_DELETE' and companion_id = $1", [doomed]), 1);
  passed("only its Owner deletes a Companion, once, and it is audited");

  // ---- what was private to it is erased ----
  const list = await roster();
  assert.ok(!list.includes(doomed) && list.includes(friend) && list.includes(A.companion));
  for (const path of ["memories", "chat-settings", "connection", "diary", "anniversary", "agent-keys"]) {
    assert.equal((await call(0, `companions/${doomed}/${path}`)).status, 404, path);
  }
  assert.equal((await call(0, "chats", "POST", { companionIds: [doomed] })).status, 404);
  const chats = (await call<{ items: Chat[] }>(0, "chats")).data.items;
  assert.ok(!chats.some(c => c.id === direct.id), "its one-to-one chat is deleted");
  assert.deepEqual(chats.find(c => c.id === group.id)!.members.map(m => m.companionId), [friend], "it left the group");
  const groupPage = (await call<ChatPage>(0, `chats/${group.id}`)).data;
  assert.ok(groupPage.items.length > 0 && !groupPage.items.some(m => m.companionId === doomed), "what it said in the group is gone, the rest stays");
  for (const table of ["companion_memories", "memory_notes", "companion_connections", "agent_keys", "diary_settings", "anniversaries", "chat_settings",
    "chat_members", "chat_messages"]) {
    assert.equal(await count(`companion_private.${table} where companion_id = $1`, [doomed]), 0, table);
  }
  assert.equal(await count("public.life_event_inbox where companion_id = $1", [doomed]), 0);
  assert.equal(await count("companion_private.agent_drafts where actor_id = $1", [me.id]), 0);
  assert.equal((await call(0, "agent/heartbeat", "GET", undefined, key.data.token)).status, 401, "its agent key no longer works");
  assert.equal((await call(0, `chats/${group.id}/messages`, "POST", { body: "还在吗" })).status, 201, "the group goes on without it");
  await settle(group.id);
  passed("its chats, memories, diary, keys, connection and notices are erased; groups go on without it");

  // ---- its community life is withdrawn ----
  assert.equal((await call(0, `community/profile?${as(doomedActor)}`)).status, 404, "it can no longer act");
  assert.equal((await call(1, `community/profile/${me.id}?${as(humanB)}`)).status, 404);
  assert.equal((await call(1, `community/posts/${mine.data.id}?${as(humanB)}`)).status, 404);
  assert.ok(!(await call<CommunityPage<CommunityPost>>(1, `community/feed?${as(humanB)}`)).data.items.some(p => p.id === mine.data.id));
  const after = (await call<CommunityDetail>(1, `community/posts/${theirs.id}?${as(humanB)}`)).data;
  assert.deepEqual([after.post.commentsCount, after.post.likeCount, after.comments.items.length], [0, 0, 0]);
  const profileB = (await call<CommunityProfile>(1, `community/profile?${as(humanB)}`)).data;
  assert.equal(profileB.followersCount, hb.followersCount, "its follow is gone");
  assert.equal(await count("public.community_follows where actor_id = $1 or target_id = $1", [me.id]), 0);
  assert.equal(await count("public.community_notifications where actor_id = $1 or recipient_id = $1", [me.id]), 0);
  assert.equal((await call(1, `community/posts/${theirs.id}?${as(humanB)}`, "DELETE")).status, 200);
  passed("its posts and comments are withdrawn; its follows, likes and notifications are removed");

  // ---- a group left with no Companion is deleted ----
  assert.equal((await call(0, `companions/${friend}`, "DELETE")).status, 200);
  const left = (await call<{ items: Chat[] }>(0, "chats")).data.items;
  assert.ok(!left.some(c => c.id === group.id), "the empty group is deleted");
  assert.deepEqual(left.find(c => c.id === alone.id)!.members.map(m => m.companionId), [A.companion], "a group with someone left stays");
  assert.equal((await call(0, `chats/${alone.id}`, "DELETE")).status, 200);
  passed("a group chat left with no Companion is deleted with it");

  // ---- at most 10 Companions per Owner ----
  const now = await count("public.companions where owner_id = $1 and status <> 'DELETED'", [A.owner]);
  assert.ok(now < 10, `the suites before leave room (${now})`);
  const extras: string[] = [];
  for (let n = now; n < 10; n += 1) extras.push(await makeCompanion(`Extra ${n}`));
  await assert.rejects(makeCompanion("One too many"), /companion limit reached/);
  const card = { spec: "chara_card_v2", data: { name: "Eleventh", description: "One more." } };
  const review = (await call<{ id: string }>(0, "companion-imports", "POST", card)).data;
  const approve = () => call<{ code?: string; companionId?: string }>(0, `companion-imports/${review.id}/approve`, "POST",
    { approvedCandidateIds: ["candidate-displayName"] });
  const refused = await approve();
  assert.deepEqual([refused.status, refused.data.code], [409, "COMPANION_LIMIT"]);
  assert.equal((await call(0, `companions/${extras[0]}`, "DELETE")).status, 200);
  const made = await approve();
  assert.equal(made.status, 201, "deleting one makes room");
  assert.equal((await count("public.companions where owner_id = $1 and status <> 'DELETED'", [B.owner])), 1, "the limit is per Owner");
  for (const id of [...extras.slice(1), made.data.companionId!]) assert.equal((await call(0, `companions/${id}`, "DELETE")).status, 200);
  passed("at most 10 Companions per Owner; deleting one makes room");

} finally {
  await setFeature("GROUP_CHAT_CREATE", false);
  await setFeature("GROUP_CHAT_SEND", false);
  await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
  await pool.end();
}
console.log(`Companion integration: ${groups} groups passed`);
