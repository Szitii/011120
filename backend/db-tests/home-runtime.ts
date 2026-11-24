import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createMobileDevHttpServer } from "../src/dev/mobile-http-server.ts";
import { createPgPool } from "../src/persistence/postgres/index.ts";
import type { Anniversary, Badges, Chat, ChatPage } from "../../contracts/chat.ts";
import type { CommunityFollow, CommunityNotification, CommunityPage, CommunityProfile } from "../../contracts/community.ts";
import type { LifeEventInboxItemView } from "../src/http/types.ts";

// Read state, badges, Owner notifications for drafts, the follow-back flag and the anniversary (migration 0046).
const connectionString = process.env.DATABASE_URL;
if (!connectionString || process.env.COMPANION_SOCIAL_DEV_DATABASE !== "1") throw Error("Disposable seeded development database required.");
const setup = createPgPool(connectionString);
await setup.query(`do $$ begin execute format('alter database %I set companion.chat_pace = %L', current_database(), '0.02'); end $$`);
await setup.end();

const pool = createPgPool(connectionString);
const ids = (letter: "a" | "b") => ({ owner: `00000000-0000-0000-0000-0000000001${letter}1`,
  subject: `00000000-0000-0000-0000-0000000000${letter}1`, companion: `00000000-0000-0000-0000-0000000002${letter}1` });
const A = ids("a"), B = ids("b");
const servers = [A, B].map((v, i) => createMobileDevHttpServer({ pool, ownerId: v.owner, ownerSubject: v.subject, bearerToken: `home-${i}` }));
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let groups = 0;
const passed = (name: string) => { groups += 1; console.log(`Home integration ${groups}: ${name}`); };

try {
  const bases = await Promise.all(servers.map(server => new Promise<string>(resolve =>
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)))));
  async function call<T>(who: 0 | 1, path: string, method = "GET", body?: unknown) {
    const response = await fetch(`${bases[who]}/v0/${path}`, {
      method, headers: { Authorization: `Bearer home-${who}`, "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json() as T };
  }
  const badges = async () => (await call<Badges>(0, "badges")).data;

  // ---- chat read state ----
  const chat = (await call<Chat>(0, "chats", "POST", { companionIds: [A.companion] })).data;
  assert.equal((await call(0, `chats/${chat.id}/messages`, "POST", { body: "读到哪了" })).status, 201);
  let page: ChatPage | undefined;
  for (let i = 0; i < 300 && (page === undefined || page.chat.replying); i += 1) {
    if (page !== undefined) await pause(20);
    page = (await call<ChatPage>(0, `chats/${chat.id}`)).data;
  }
  const newest = page!.items.find(m => m.companionId !== null)!;
  assert.ok(newest, "the dev host replied");
  const older = page!.items.filter(m => m.companionId !== null)[1];
  assert.ok(page!.chat.unreadCount >= 1, "the reply is unread");
  const list = (await call<{ items: Chat[] }>(0, "chats")).data;
  assert.equal((await badges()).chats, list.items.reduce((n, c) => n + c.unreadCount, 0));
  const read = (await call<Chat>(0, `chats/${chat.id}/read`, "PUT", { messageId: newest.id })).data;
  assert.deepEqual([read.unreadCount, read.readUpTo], [0, newest.id]);
  if (older !== undefined) {
    const again = (await call<Chat>(0, `chats/${chat.id}/read`, "PUT", { messageId: older.id })).data;
    assert.deepEqual([again.unreadCount, again.readUpTo], [0, newest.id], "an older position changes nothing");
  }
  assert.equal((await call(1, `chats/${chat.id}/read`, "PUT", { messageId: newest.id })).status, 404, "another Owner's chat");
  assert.equal((await call(0, `chats/${chat.id}/read`, "PUT", { messageId: randomUUID() })).status, 404);
  assert.equal((await call<{ items: Chat[] }>(0, "chats")).data.items.find(c => c.id === chat.id)!.unreadCount, 0);
  passed("chat read position: unread counts, moves only forward, Owner-scoped");

  // ---- Owner notifications for drafts ----
  const aiProfile = (await call<CommunityProfile>(0, `community/profile?actorKind=COMPANION&actorId=${A.companion}`)).data;
  const inboxBefore = (await badges()).ownerInbox;
  const draft = (await pool.query<{ id: string }>(`insert into companion_private.agent_drafts(actor_id, body, key_hash)
    values ($1, '等审核的动态', encode(sha256(convert_to($2, 'UTF8')), 'hex')) returning id`, [aiProfile.id, randomUUID()])).rows[0]!.id;
  const inbox = (await call<{ items: LifeEventInboxItemView[] }>(0, "life-event-inbox?limit=50")).data.items;
  const notice = inbox.find(i => i.kind === "AGENT_DRAFT" && i.linkedObject.id === draft)!;
  assert.ok(notice, JSON.stringify(inbox));
  assert.deepEqual([notice.companionId, notice.linkedObject.type, notice.readAt, notice.lifeEventId], [A.companion, "AGENT_DRAFT", undefined, undefined]);
  assert.equal((await badges()).ownerInbox, inboxBefore + 1);
  assert.equal((await call<{ items: LifeEventInboxItemView[] }>(1, "life-event-inbox?limit=50")).data.items
    .some(i => i.linkedObject.id === draft), false, "only its Owner");
  await pool.query("update companion_private.agent_drafts set status = 'DISCARDED' where id = $1", [draft]);
  assert.equal((await badges()).ownerInbox, inboxBefore, "deciding the draft marks the notice read");
  const life = (await pool.query("select count(*)::int n from public.life_event_inbox where kind = 'LIFE_EVENT' and life_event_id is null")).rows[0]!.n;
  assert.equal(life, 0);
  passed("a Companion's draft notifies its Owner and is read once decided");

  // ---- community badges and the follow-back flag ----
  const humanA = (await call<CommunityProfile>(0, `community/profile?actorKind=OWNER&actorId=${A.owner}`)).data;
  const humanB = (await call<CommunityProfile>(1, `community/profile?actorKind=OWNER&actorId=${B.owner}`)).data;
  await pool.query("delete from public.community_follows where (actor_id, target_id) in (($1::uuid, $2::uuid), ($2::uuid, $1::uuid))", [humanA.id, humanB.id]);
  await pool.query("insert into public.community_follows(actor_id, target_id) values ($1, $2)", [humanB.id, humanA.id]);
  await pool.query(`insert into public.community_notifications(recipient_id, actor_id, kind) values ($1, $2, 'FOLLOW')
    on conflict (recipient_id, actor_id) where kind = 'FOLLOW' do update set read_at = null`, [humanA.id, humanB.id]);
  const followers = async () => (await call<CommunityPage<CommunityFollow>>(0, `community/followers?actorKind=OWNER&actorId=${A.owner}`))
    .data.items.find(f => f.actor.id === humanB.id)!;
  assert.equal((await followers()).following, false);
  await pool.query("insert into public.community_follows(actor_id, target_id) values ($1, $2)", [humanA.id, humanB.id]);
  assert.equal((await followers()).following, true, "followed back");
  const following = (await call<CommunityPage<CommunityFollow>>(0, `community/following?actorKind=OWNER&actorId=${A.owner}`)).data.items;
  assert.ok(following.every(f => f.following), "everyone in the following list is followed");
  const notes = (await call<CommunityPage<CommunityNotification>>(0, `community/notifications?actorKind=OWNER&actorId=${A.owner}`)).data.items;
  const unread = notes.filter(n => n.readAt === null).length;
  const mine = (await badges()).community;
  assert.deepEqual(mine[0], { actorKind: "OWNER", actorId: A.owner, unread });
  assert.ok(mine.some(c => c.actorKind === "COMPANION" && c.actorId === A.companion));
  assert.ok(unread >= 1);
  await call(0, `community/notifications/${notes.find(n => n.readAt === null)!.id}/read?actorKind=OWNER&actorId=${A.owner}`, "PUT");
  assert.equal((await badges()).community[0]!.unread, unread - 1);
  assert.ok((await call<Badges>(1, "badges")).data.community.every(c => c.actorId !== A.owner && c.actorId !== A.companion));
  passed("community badges per identity match the notification list; followers say who is followed back");

  // ---- anniversary ----
  const path = `companions/${A.companion}/anniversary`;
  const first = (await call<Anniversary>(0, path)).data;
  assert.deepEqual([first.startDate, first.timeZone, first.revision], [null, "Asia/Shanghai", 1]);
  const saved = await call<Anniversary>(0, path, "PUT", { startDate: "2019-02-28", timeZone: "Europe/London", revision: 1 });
  assert.deepEqual([saved.status, saved.data.startDate, saved.data.timeZone, saved.data.revision], [200, "2019-02-28", "Europe/London", 2]);
  assert.equal((await call(0, path, "PUT", { startDate: "2020-01-01", timeZone: "Asia/Shanghai", revision: 1 })).status, 409, "stale revision");
  const tomorrow = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
  for (const bad of [{ startDate: tomorrow, timeZone: "Asia/Shanghai" }, { startDate: "2019-02-29", timeZone: "Asia/Shanghai" },
    { startDate: "1899-12-31", timeZone: "Asia/Shanghai" }, { startDate: "2019-01-01", timeZone: "Mars/Olympus" }]) {
    assert.equal((await call(0, path, "PUT", { ...bad, revision: 2 })).status, 400, JSON.stringify(bad));
  }
  assert.equal((await call(1, path)).status, 404, "another Owner's Companion");
  assert.equal((await call(1, path, "PUT", { startDate: null, timeZone: "Asia/Shanghai", revision: 2 })).status, 404);
  const cleared = (await call<Anniversary>(0, path, "PUT", { startDate: null, timeZone: "Asia/Shanghai", revision: 2 })).data;
  assert.deepEqual([cleared.startDate, cleared.revision], [null, 3]);
  passed("anniversary: set, cleared, revision conflicts, date and time zone checks, Owner-scoped");
} finally {
  await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
  await pool.end();
}
console.log(`Home integration: ${groups} groups passed`);
