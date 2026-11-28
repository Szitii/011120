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
  assert.ok(page!.chat.unreadCount! >= 1, "the reply is unread");
  const list = (await call<{ items: Chat[] }>(0, "chats")).data;
  assert.equal((await badges()).chats, list.items.reduce((n, c) => n + c.unreadCount!, 0));
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

  // ---- "全部已读" (migration 0080): every notice up to a moment, for one identity and for the Owner's own inbox ----
  const aiA = (await call<CommunityProfile>(0, `community/profile?actorKind=COMPANION&actorId=${A.companion}`)).data;
  const aiB = (await call<CommunityProfile>(1, `community/profile?actorKind=COMPANION&actorId=${B.companion}`)).data;
  const readNotes = (who: 0 | 1, body?: unknown) =>
    call<{ read: number }>(who, `community/notifications/read?actorKind=OWNER&actorId=${A.owner}`, "PUT", body);
  const unreadNotes = async () => (await badges()).community[0]!.unread;
  const wasUnread = (await pool.query<{ id: string }>("select id from public.community_notifications where recipient_id = $1 and read_at is null", [humanA.id])).rows.map(r => r.id);
  const baseNotes = await unreadNotes();
  await pool.query("delete from public.community_follows where target_id = $1 and actor_id in ($2, $3)", [humanA.id, aiA.id, aiB.id]);
  await pool.query("delete from public.community_notifications where recipient_id = $1 and actor_id in ($2, $3)", [humanA.id, aiA.id, aiB.id]);
  // One old notice the list shows (B's Companion follows A), and an older one it does not (a follow that was taken back).
  await pool.query("insert into public.community_follows(actor_id, target_id) values ($1, $2)", [aiB.id, humanA.id]);
  await pool.query(`insert into public.community_notifications(recipient_id, actor_id, kind, created_at) values
    ($1, $2, 'FOLLOW', '2026-01-02T00:00:00.123456Z'), ($1, $3, 'FOLLOW', '2026-01-01T00:00:00Z')`, [humanA.id, aiB.id, aiA.id]);
  assert.equal(await unreadNotes(), baseNotes + 1, "the hidden one is not counted");
  assert.equal((await readNotes(1)).status, 404, "another Owner cannot speak for this identity");
  for (const before of ["yesterday", "2026-01-02", 1767312000]) assert.equal((await readNotes(0, { before })).status, 400, String(before));
  assert.deepEqual((await readNotes(0, { before: "2026-01-01T23:59:59Z" })).data, { read: 0 }, "nothing the list shows is that old");
  // The app names the newest notice it shows, cut to milliseconds: that notice is still covered, later ones are not.
  assert.deepEqual((await readNotes(0, { before: "2026-01-02T00:00:00.123Z" })).data, { read: 1 });
  assert.equal(await unreadNotes(), baseNotes, "everything newer stays unread");
  await pool.query("insert into public.community_follows(actor_id, target_id) values ($1, $2)", [aiA.id, humanA.id]);
  assert.equal(await unreadNotes(), baseNotes + 1, "the hidden notice was not read behind the Owner's back: shown again, it is unread");
  assert.deepEqual((await readNotes(0)).data, { read: baseNotes + 1 }, "without a moment: everything up to now");
  assert.equal(await unreadNotes(), 0);
  assert.deepEqual((await readNotes(0, {})).data, { read: 0 }, "again changes nothing");
  await pool.query("delete from public.community_follows where target_id = $1 and actor_id in ($2, $3)", [humanA.id, aiA.id, aiB.id]);
  await pool.query("delete from public.community_notifications where recipient_id = $1 and actor_id in ($2, $3)", [humanA.id, aiA.id, aiB.id]);
  await pool.query("update public.community_notifications set read_at = null where id = any($1::uuid[])", [wasUnread]);

  const inboxUnread = (await pool.query<{ id: string }>("select id from public.life_event_inbox where owner_id in ($1, $2) and read_at is null", [A.owner, B.owner])).rows.map(r => r.id);
  const baseInbox = (await badges()).ownerInbox;
  const otherInbox = (await call<Badges>(1, "badges")).data.ownerInbox;
  const [oldDraft, newDraft] = (await pool.query<{ id: string }>(`insert into companion_private.agent_drafts(actor_id, body, key_hash)
    select $1, '等审核', encode(sha256(convert_to(gen_random_uuid()::text, 'UTF8')), 'hex') from generate_series(1, 2) returning id`, [aiProfile.id])).rows.map(r => r.id);
  await pool.query("update public.life_event_inbox set created_at = '2026-01-02T00:00:00.123456Z' where kind = 'AGENT_DRAFT' and target_id = $1", [oldDraft]);
  assert.equal((await badges()).ownerInbox, baseInbox + 2);
  assert.deepEqual((await call<{ read: number }>(0, "life-event-inbox/read", "PUT", { before: "2026-01-02T00:00:00.123Z" })).data, { read: 1 });
  assert.equal((await badges()).ownerInbox, baseInbox + 1, "the notice that came later stays unread");
  assert.equal((await call(0, "life-event-inbox/read", "PUT", { before: "soon" })).status, 400);
  assert.equal((await call<{ read: number }>(1, "life-event-inbox/read", "PUT")).data.read, otherInbox, "each Owner reads their own");
  assert.equal((await badges()).ownerInbox, baseInbox + 1, "and nobody else's");
  assert.deepEqual((await call<{ read: number }>(0, "life-event-inbox/read", "PUT")).data, { read: baseInbox + 1 });
  assert.equal((await badges()).ownerInbox, 0);
  assert.equal((await call<{ items: LifeEventInboxItemView[] }>(0, "life-event-inbox?limit=50")).data.items.every(i => i.readAt !== undefined), true);
  await pool.query("update companion_private.agent_drafts set status = 'DISCARDED' where id = any($1::uuid[])", [[oldDraft, newDraft]]);
  await pool.query("update public.life_event_inbox set read_at = null where id = any($1::uuid[])", [inboxUnread]);
  passed("read all: up to the moment the app names, only what the lists show, each identity and each Owner their own");

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
