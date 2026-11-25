/**
 * Admin console, database part: what an operator can and cannot do.
 * Operators here are two real database logins that are members of companion_admin, so the
 * suite connects exactly the way the console will.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import pg from "pg";
import { PgAdminDb } from "../src/admin/db.ts";
import { createAdminServer } from "../src/admin/server.ts";
import { createPgPool, PgOwnerExecutor } from "../src/persistence/postgres/index.ts";
import { PostgresChatAdapter } from "../src/chat/postgres.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString || process.env.COMPANION_SOCIAL_DEV_DATABASE !== "1") throw Error("Disposable seeded development database required.");
const pool = createPgPool(connectionString);
const A = { owner: "00000000-0000-0000-0000-0000000001a1", subject: "00000000-0000-0000-0000-0000000000a1", companion: "00000000-0000-0000-0000-0000000002a1" };
const B = { owner: "00000000-0000-0000-0000-0000000001b1", companion: "00000000-0000-0000-0000-0000000002b1" };
const LOGINS = ["admin_test_one", "admin_test_two"] as const;
const PASSWORD = "admin-test-only";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
const times = (items: Json[]) => items.map(item => Date.parse(item.createdAt));
const ascending = (values: number[]) => values.every((value, i) => i === 0 || values[i - 1]! <= value);
const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected;
let groups = 0;
const passed = (name: string) => { groups += 1; console.log(`Admin integration ${groups}: ${name}`); };

for (const login of LOGINS) {
  await pool.query(`do $$ begin create role ${login} login password '${PASSWORD}' in role companion_admin;
    exception when duplicate_object then null; end $$`);
}
const loginUrl = (login: string) => {
  const url = new URL(connectionString);
  url.username = login; url.password = PASSWORD;
  return url.toString();
};
const operators = await Promise.all(LOGINS.map(async login => {
  const client = new pg.Client({ connectionString: loginUrl(login) });
  await client.connect();
  return client;
}));
let consoleServer: Server | undefined;
const consolePool = new pg.Pool({ connectionString: loginUrl("admin_test_one"), max: 2 });
const [one, two] = operators as [pg.Client, pg.Client];
/** Calls one console function as an operator and returns its JSON. */
const admin = async (who: pg.Client, fn: string, ...args: unknown[]): Promise<Json> =>
  (await who.query(`select companion_admin.${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as r`, args)).rows[0]!.r;

/** A fresh Owner with a human community account. */
async function person(name: string) {
  const subject = randomUUID(), owner = randomUUID(), actor = randomUUID();
  const email = `${name.toLowerCase()}-${subject.slice(0, 8)}@admin-fixture.test`;
  await pool.query("insert into auth.users(id, email) values ($1, $2)", [subject, email]);
  await pool.query("insert into public.owners(id, auth_user_id, display_name) values ($1, $2, $3)", [owner, subject, name]);
  await pool.query("insert into public.community_actors(id, owner_id, kind) values ($1, $2, 'HUMAN')", [actor, owner]);
  return { subject, owner, actor, email };
}
const insertId = async (sql: string, values: unknown[]) => (await pool.query<{ id: string }>(`${sql} returning id`, values)).rows[0]!.id;
const post = (actor: string, body: string) =>
  insertId("insert into public.community_posts(actor_id, body, source) values ($1, $2, 'HUMAN_MANUAL')", [actor, body]);
const report = (by: string, targetActor: string, type: string, target: string, body: string | null) =>
  insertId(`insert into companion_private.community_reports(actor_id, target_actor_id, target_type, target_id, reason, details, evidence)
    values ($1, $2, $3, $4, 'HARASSMENT', 'Admin fixture report', $5)`, [by, targetActor, type, target, JSON.stringify(body === null ? {} : { body })]);
const reportRow = async (id: string) =>
  (await pool.query("select status, resolution, review_note, reviewed_by from companion_private.community_reports where id = $1", [id])).rows[0]!;

// Owner A looks at the community the way the app does.
const viewer = new PgOwnerExecutor(pool, A.subject);
const reads = (resource: string, target: string) =>
  viewer.query("select public.community_read('OWNER', $1, $2, $3) as page", [A.owner, resource, target])
    .then(() => true, error => { if (code("P0001")(error)) return false; throw error; });
const seesPost = (id: string) => reads("detail", id);
const seesProfile = (actor: string) => reads("profile", actor);
const postBody = async (id: string) => (await pool.query("select body from public.community_posts where id = $1", [id])).rows[0]!.body as string;

const chatId = randomUUID(), consoleChat = randomUUID();
const twinB = (await pool.query<{ id: string }>("select id from public.social_twins where companion_id = $1", [B.companion])).rows[0]!.id;
const quotaBefore = (await admin(one, "models")).quota as { dailyCalls: number; dailyCostMinor: number };

try {
  // ---- who can reach what ----
  for (const sql of [
    "select * from companion_private.chat_messages", "select * from companion_private.chats",
    "select * from companion_private.admin_log", "select * from companion_private.community_reports",
    "select * from public.owners", "select * from public.community_posts", "select * from auth.users",
    "select public.chat_list()", "select public.claim_owner()",
    "select companion_private.admin_note('FORGED', 'X', 'x', null, 'forged')",
    "insert into companion_private.admin_log(action, target_type, target_id, reason) values ('FORGED', 'X', 'x', 'forged')",
    "set role companion_api", "set role authenticated",
  ]) {
    await assert.rejects(one.query(sql), code("42501"), sql);
  }
  const asApi = new PgOwnerExecutor(pool, A.subject);
  await assert.rejects(asApi.query("select companion_admin.reports()", []), code("42501"));
  await assert.rejects(asApi.query("select companion_admin.chat_read($1, 'curious')", [chatId]), code("42501"));
  const plain = await pool.connect();
  try {
    await plain.query("begin"); await plain.query("set local role authenticated");
    await assert.rejects(plain.query("select companion_admin.owner_suspend($1, true, 'self-service')", [B.owner]), code("42501"));
  } finally { await plain.query("rollback"); plain.release(); }
  passed("operators reach the console functions and nothing else; app users and the API server reach none of them");

  // ---- reports ----
  const reporter = await person("Reporter"), reporterTwo = await person("ReporterTwo"), target = await person("Target");
  const first = await post(target.actor, "Admin fixture post one");
  const second = await post(target.actor, "Admin fixture post two");
  const comment = await insertId(`insert into public.community_comments(post_id, actor_id, body, source)
    values ($1, $2, 'Admin fixture comment', 'HUMAN_MANUAL')`, [second, target.actor]);
  await pool.query("insert into public.community_actors(owner_id, kind, social_twin_id) values ($1, 'AI', $2) on conflict do nothing", [B.owner, twinB]);
  const aiB = (await pool.query<{ id: string }>("select id from public.community_actors where social_twin_id = $1", [twinB])).rows[0]!.id;
  const onPost = await report(reporter.actor, target.actor, "POST", first, "Admin fixture post one");
  const onPostToo = await report(reporterTwo.actor, target.actor, "POST", first, "Admin fixture post one");
  const onComment = await report(reporter.actor, target.actor, "COMMENT", comment, "Admin fixture comment");
  const onCompanion = await report(reporter.actor, aiB, "ACTOR", aiB, null);
  const onPerson = await report(reporter.actor, target.actor, "ACTOR", target.actor, null);

  const queue = await admin(one, "reports");
  assert.ok(queue.pending >= 5);
  const queued = queue.items.find((r: Json) => r.id === onPost);
  assert.deepEqual([queued.status, queued.reason, queued.details, queued.targetType, queued.evidence.body, queued.live, queued.others],
    ["SUBMITTED", "HARASSMENT", "Admin fixture report", "POST", "Admin fixture post one", true, 1]);
  assert.deepEqual([queued.reporter.ownerId, queued.reporter.displayName, queued.target.ownerId, queued.target.ownerStatus, queued.target.kind],
    [reporter.owner, "Reporter", target.owner, "ACTIVE", "HUMAN"]);
  const queuedCompanion = queue.items.find((r: Json) => r.id === onCompanion);
  assert.deepEqual([queuedCompanion.target.twinId, queuedCompanion.target.twinStatus, queuedCompanion.live], [twinB, "ACTIVE", null]);
  assert.ok(ascending(times(queue.items)), "oldest first");

  // No reason: nothing happens at all.
  await assert.rejects(admin(one, "report_resolve", onPost, "REMOVED", "   "), code("22023"));
  await assert.rejects(admin(one, "report_resolve", onPost, "REMOVED", null), code("22023"));
  await assert.rejects(admin(one, "report_resolve", onPost, "REMOVED", "x".repeat(501)), code("22023"));
  await assert.rejects(admin(one, "report_resolve", onPost, "BANISHED", "wrong word"), code("22023"));
  await assert.rejects(admin(one, "report_resolve", randomUUID(), "NONE", "no such report"), code("P0001"));
  assert.equal(await seesPost(first), true);
  assert.equal((await reportRow(onPost)).status, "SUBMITTED");

  assert.equal(await seesPost(first), true);
  assert.deepEqual(await admin(one, "report_resolve", onPost, "REMOVED", " Harassment, see report "), { closed: 2 });
  assert.equal(await seesPost(first), false);
  assert.equal(await postBody(first), "[已被管理员移除]");
  for (const id of [onPost, onPostToo]) {
    assert.deepEqual(await reportRow(id), { status: "REVIEWED", resolution: "REMOVED", review_note: "Harassment, see report", reviewed_by: "admin_test_one" });
  }
  await assert.rejects(admin(two, "report_resolve", onPostToo, "NONE", "late"), (error: unknown) =>
    code("55000")(error) && /admin_test_one/.test((error as Error).message));

  // Two operators act on the same report at once: one wins, the other is told so.
  const race = await Promise.allSettled([one, two].map(who => admin(who, "report_resolve", onComment, "REMOVED", "Racing")));
  assert.deepEqual(race.map(r => r.status).sort(), ["fulfilled", "rejected"]);
  assert.ok(code("55000")((race.find(r => r.status === "rejected") as PromiseRejectedResult).reason));
  assert.equal((await pool.query("select count(*)::int as n from companion_private.admin_log where action = 'REMOVE_COMMENT' and target_id = $1", [comment])).rows[0]!.n, 1);
  passed("the queue shows the evidence; resolving needs a reason, closes every report about the same thing and happens once");

  // ---- suspending a Companion's community identity, and lifting it ----
  assert.equal(await seesProfile(aiB), true);
  await assert.rejects(admin(one, "report_resolve", onCompanion, "REMOVED", "nothing to remove"), code("22023"));
  await assert.rejects(admin(one, "report_resolve", onPerson, "TWIN_SUSPENDED", "not a Companion"), code("22023"));
  assert.deepEqual(await admin(two, "report_resolve", onCompanion, "TWIN_SUSPENDED", "Spam from this Companion"), { closed: 1 });
  assert.equal(await seesProfile(aiB), false);
  await assert.rejects(admin(one, "twin_suspend", twinB, true, "again"), code("55000"));
  await assert.rejects(admin(one, "twin_suspend", randomUUID(), true, "no such twin"), code("P0001"));
  assert.deepEqual(await admin(one, "twin_suspend", twinB, false, "Appeal accepted"), { status: "ACTIVE" });
  assert.equal(await seesProfile(aiB), true);
  await assert.rejects(admin(one, "twin_suspend", twinB, false, "again"), code("55000"));
  // A twin that was LIMITED before the suspension goes back to LIMITED.
  await pool.query("update public.social_twins set status = 'LIMITED' where id = $1", [twinB]);
  await admin(one, "twin_suspend", twinB, true, "Limited twin suspended");
  assert.deepEqual(await admin(one, "twin_suspend", twinB, false, "Lifted"), { status: "LIMITED" });
  await pool.query("update public.social_twins set status = 'ACTIVE' where id = $1", [twinB]);
  passed("a suspended Companion disappears from the community and comes back as it was");

  // ---- suspending an Owner, and lifting it ----
  const asTarget = new PgOwnerExecutor(pool, target.subject);
  const claim = async () => (await asTarget.query<{ id: string | null }>("select public.claim_owner() as id", [])).rows[0]!.id;
  assert.equal(await seesPost(second), true);
  assert.equal(await claim(), target.owner);
  assert.deepEqual(await admin(one, "report_resolve", onPerson, "OWNER_SUSPENDED", "Repeated harassment"), { closed: 1 });
  assert.equal(await seesPost(second), false);
  assert.equal(await seesProfile(target.actor), false);
  assert.equal(await claim(), null, "the API server refuses every request of a suspended Owner");
  await assert.rejects(asTarget.query("select public.community_read('OWNER', $1, 'feed')", [target.owner]), code("42501"));
  await assert.rejects(admin(two, "owner_suspend", target.owner, true, "again"), code("55000"));
  await assert.rejects(admin(two, "owner_suspend", target.owner, null, "neither"), code("22023"));
  assert.deepEqual(await admin(two, "owner_suspend", target.owner, false, "Suspension served"), { status: "ACTIVE" });
  assert.equal(await seesPost(second), true);
  assert.equal(await claim(), target.owner);
  await assert.rejects(admin(two, "owner_suspend", target.owner, false, "again"), code("55000"));
  await assert.rejects(admin(two, "owner_suspend", randomUUID(), true, "no such owner"), code("P0001"));
  const reviewed = await admin(one, "reports", "REVIEWED");
  assert.deepEqual([reviewed.items[0].id, reviewed.items[0].resolution, reviewed.items[0].note, reviewed.items[0].reviewedBy],
    [onPerson, "OWNER_SUSPENDED", "Repeated harassment", "admin_test_one"], "reviewed reports come newest first");
  assert.ok([onPost, onPostToo, onComment, onCompanion].every(id => reviewed.items.some((r: Json) => r.id === id)));
  passed("a suspended Owner is refused and hidden at once, and is back at once when the suspension is lifted");

  // ---- removing and restoring content ----
  assert.deepEqual(await admin(one, "content_restore", "POST", first, "Removed by mistake"), { restored: true });
  assert.equal(await seesPost(first), true);
  assert.equal(await postBody(first), "Admin fixture post one");
  await assert.rejects(admin(one, "content_restore", "POST", first, "again"), code("P0001"));
  assert.deepEqual(await admin(one, "content_restore", "COMMENT", comment, "Comment was fine"), { restored: true });
  assert.equal((await pool.query("select body, deleted_at from public.community_comments where id = $1", [comment])).rows[0]!.body, "Admin fixture comment");
  assert.deepEqual(await admin(two, "content_remove", "COMMENT", comment, "On second thought"), { removed: true });
  // A report that arrives about content already removed is closed as removed, without removing twice.
  const late = await report(reporterTwo.actor, target.actor, "COMMENT", comment, "Admin fixture comment");
  assert.equal((await admin(two, "reports")).items.find((r: Json) => r.id === late).live, false);
  assert.deepEqual(await admin(two, "report_resolve", late, "REMOVED", "Already removed"), { closed: 1 });
  assert.equal((await reportRow(late)).resolution, "REMOVED");
  assert.deepEqual(await admin(two, "content_remove", "POST", second, "Direct removal"), { removed: true });
  await assert.rejects(admin(two, "content_remove", "POST", second, "again"), code("P0001"));
  await assert.rejects(admin(two, "content_remove", "POST", randomUUID(), "no such post"), code("P0001"));
  await assert.rejects(admin(two, "content_remove", "ACTOR", second, "wrong kind"), code("22023"));
  await assert.rejects(admin(two, "content_restore", "ACTOR", second, "wrong kind"), code("22023"));
  await assert.rejects(admin(two, "content_remove", "POST", first, ""), code("22023"));
  assert.equal(await seesPost(first), true, "a removal without a reason does not happen");
  // The author then deletes the removed post themselves: that is final.
  await pool.query("update public.community_posts set body = '[已删除]' where id = $1", [second]);
  await assert.rejects(admin(two, "content_restore", "POST", second, "too late"), code("P0001"));

  const detail = await admin(one, "owner_detail", target.owner);
  assert.deepEqual(detail.owner, { id: target.owner, email: target.email, displayName: "Target", status: "ACTIVE", createdAt: detail.owner.createdAt });
  assert.deepEqual(detail.companions, []);
  assert.deepEqual(detail.posts.map((p: Json) => [p.id, p.body, p.deletedAt === null, p.removedByAdmin]).sort(),
    [[first, "Admin fixture post one", true, false], [second, "[已删除]", false, false]].sort());
  assert.deepEqual(detail.comments.map((c: Json) => [c.id, c.postId, c.body, c.removedByAdmin]), [[comment, second, "[已被管理员移除]", true]]);
  assert.deepEqual((await admin(one, "owner_detail", B.owner)).companions.map((c: Json) => [c.id, c.displayName, c.twinId, c.twinStatus, c.actorId]),
    [[B.companion, "AnotherSample", twinB, "ACTIVE", aiB]]);
  assert.equal(await admin(one, "owner_detail", randomUUID()), null);
  const everyone = await admin(one, "owners");
  assert.ok(everyone.items.length <= 100 && everyone.items.some((o: Json) => o.id === A.owner));
  assert.ok(ascending(times(everyone.items).reverse()), "newest first");
  for (const search of [target.email.toUpperCase(), " target ", target.owner]) {
    const found = await admin(one, "owners", search);
    assert.ok(found.items.some((o: Json) => o.id === target.owner && o.email === target.email && o.posts === 1 && o.companions === 0), search);
    assert.ok(!found.items.some((o: Json) => o.id === reporter.owner), search);
  }
  assert.deepEqual(await admin(one, "owners", "nobody-by-this-name"), { items: [], more: false });
  // More Owners than one list holds: it is cut at 100 and says so.
  await pool.query(`with u as (insert into auth.users(id, email) select gen_random_uuid(), 'crowd-' || g || '@admin-fixture.test'
      from generate_series(1, 101) g returning id)
    insert into public.owners(auth_user_id, display_name) select id, 'Crowd' from u`);
  try {
    const crowd = await admin(one, "owners", "crowd-");
    assert.deepEqual([crowd.items.length, crowd.more, new Set(crowd.items.map((o: Json) => o.id)).size], [100, true, 100]);
  } finally { await pool.query("delete from auth.users where email like 'crowd-%@admin-fixture.test'"); }
  assert.deepEqual(await admin(one, "owners", "crowd-"), { items: [], more: false });
  passed("removed content is hidden and can be put back, unless its author deleted it; Owners can be listed, searched and opened");

  // ---- private chats ----
  await pool.query("update companion_private.feature_switches set enabled = true where key = 'GROUP_CHAT_CREATE'");
  await pool.query("insert into companion_private.chats(id, owner_id, title) values ($1, $2, 'Admin fixture chat')", [chatId, A.owner]);
  await pool.query("insert into companion_private.chat_members(chat_id, companion_id, position) values ($1, $2, 1)", [chatId, A.companion]);
  await pool.query(`insert into companion_private.chat_messages(chat_id, body, status, key_hash, created_at, shown_at)
    select $1::uuid, 'private line ' || g, 'SENT', encode(sha256(convert_to('admin fixture ' || g,'UTF8')), 'hex'),
      now() - make_interval(secs => 100 - g), now() from generate_series(1, 55) g`, [chatId]);
  const chats = await admin(two, "chats", A.owner);
  const listed = chats.items.find((c: Json) => c.id === chatId);
  assert.deepEqual([listed.title, listed.direct, listed.members, listed.messages],
    ["Admin fixture chat", false, [{ companionId: A.companion, displayName: "SampleCompanion", avatar: null }], 55]);
  assert.ok(!JSON.stringify(chats).includes("private line"), "the list carries no message text");
  const chatReads = async () => (await pool.query(`select operator, owner_id, reason from companion_private.admin_log
    where action = 'READ_CHAT' and target_id = $1 order by id`, [chatId])).rows;
  await assert.rejects(admin(two, "chat_read", chatId, null), code("22023"));
  await assert.rejects(admin(two, "chat_read", chatId, " "), code("22023"));
  await assert.rejects(admin(two, "chat_read", chatId, "half a cursor", new Date().toISOString(), null), code("22023"));
  await assert.rejects(admin(two, "chat_read", randomUUID(), "no such chat"), code("P0001"));
  assert.deepEqual(await chatReads(), [], "a refused read shows nothing and logs nothing");
  const page = await admin(two, "chat_read", chatId, "Checking a report");
  assert.deepEqual([page.chat.ownerId, page.chat.title, page.items.length, page.items[0].body, page.items[49].body, page.items[0].companionId],
    [A.owner, "Admin fixture chat", 50, "private line 55", "private line 6", null]);
  const rest = await admin(two, "chat_read", chatId, "Checking a report", page.next.at, page.next.id);
  assert.deepEqual([rest.items.map((m: Json) => m.body), rest.next], [["private line 5", "private line 4", "private line 3", "private line 2", "private line 1"], null]);
  assert.deepEqual(await chatReads(), [1, 2].map(() => ({ operator: "admin_test_two", owner_id: A.owner, reason: "Checking a report" })));
  passed("a private chat can be read page by page, only with a reason, and every read is in the log");

  // ---- models, quota and what was spent ----
  await admin(one, "model_switch_set", "MODEL", "admin-test-provider/m-off", false, "Admin test");
  assert.deepEqual((await admin(one, "models")).switches.filter((s: Json) => s.key === "admin-test-provider/m-off")
    .map((s: Json) => [s.scope, s.enabled, s.note]), [["MODEL", false, "Admin test"]]);
  await admin(two, "model_switch_set", "MODEL", "admin-test-provider/m-off", true, "Admin test over");
  await assert.rejects(admin(one, "model_switch_set", "EVERYTHING", "*", false, "wrong scope"), code("23514"));
  await assert.rejects(admin(one, "model_switch_set", "ALL", "*", false, null), code("22023"));
  await assert.rejects(admin(one, "model_switch_set", "ALL", "*", false, "x".repeat(501)), code("22023"));
  assert.ok(!(await admin(one, "models")).switches.some((s: Json) => s.scope === "ALL" && !s.enabled), "a switch without a reason is not flipped");
  assert.deepEqual((await pool.query(`select operator, detail from companion_private.admin_log
    where action = 'MODEL_SWITCH' and target_id = 'admin-test-provider/m-off' order by id desc limit 2`)).rows,
    [{ operator: "admin_test_two", detail: { enabled: true, before: false } }, { operator: "admin_test_one", detail: { enabled: false, before: null } }]);
  await assert.rejects(admin(one, "chat_quota_set", 150, 80, ""), code("22023"));
  assert.deepEqual((await admin(one, "models")).quota, quotaBefore);
  await admin(one, "chat_quota_set", 150, 80, "Trial quota");
  const quota = (await admin(one, "models")).quota;
  assert.deepEqual([quota.dailyCalls, quota.dailyCostMinor, quota.currency], [150, 80, "USD"]);
  assert.deepEqual((await pool.query("select detail from companion_private.admin_log where action = 'CHAT_QUOTA' order by id desc limit 1")).rows[0]!.detail,
    { dailyCalls: 150, dailyCostMinor: 80, before: { dailyCalls: quotaBefore.dailyCalls, dailyCostMinor: quotaBefore.dailyCostMinor } });
  await admin(one, "chat_quota_set", quotaBefore.dailyCalls, quotaBefore.dailyCostMinor, "Back to the default");

  // One real model call through the ledger, then the spend report must show exactly it.
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  const spentBefore = await admin(one, "spend", day(-1), day(1));
  const chat = new PostgresChatAdapter(viewer);
  await chat.send(chatId, "记一笔", [A.companion], createHash("sha256").update(randomUUID()).digest("hex"));
  const turn = (await chat.claim(chatId))!;
  const booked = await chat.reserve({ replyId: turn.replyId, claimId: turn.claimId, purpose: "REPLY", provider: "admin-test-provider",
    model: "m-spend", pricingVersion: "test/1", inputTokens: 100, outputTokens: 50, costMinor: 5, traceId: "admin-spend" }) as { decision: string; transactionId: string };
  assert.equal(booked.decision, "RESERVED");
  await chat.settle(booked.transactionId, 80, 20, 3, true);
  assert.equal(await chat.finish(turn.replyId, turn.claimId, "SENT", ["记好了"]), true);
  // And one call that failed at the provider after using 40 input tokens for 2 cents.
  await chat.send(chatId, "再记一笔", [A.companion], createHash("sha256").update(randomUUID()).digest("hex"));
  const failedTurn = (await chat.claim(chatId))!;
  const failedCall = await chat.reserve({ replyId: failedTurn.replyId, claimId: failedTurn.claimId, purpose: "REPLY", provider: "admin-test-provider",
    model: "m-spend", pricingVersion: "test/1", inputTokens: 100, outputTokens: 50, costMinor: 5, traceId: "admin-spend-failed" }) as { transactionId: string };
  await chat.settle(failedCall.transactionId, 40, 0, 2, false);
  assert.equal(await chat.finish(failedTurn.replyId, failedTurn.claimId, "ERROR", null), true);
  const spent = await admin(one, "spend", day(-1), day(1));
  const usd = (s: Json) => s.totals.find((t: Json) => t.currency === "USD") ?? { calls: 0, costMinor: 0 };
  assert.deepEqual([usd(spent).calls - usd(spentBefore).calls, usd(spent).costMinor - usd(spentBefore).costMinor], [2, 5]);
  assert.deepEqual(spent.byDay.filter((d: Json) => d.model === "m-spend").map((d: Json) => [d.provider, d.currency, d.calls, d.failed, d.inputTokens, d.outputTokens, d.costMinor]),
    [["admin-test-provider", "USD", 2, 1, 120, 20, 5]]);
  const mine = (s: Json) => s.byCompanion.find((c: Json) => c.companionId === A.companion) ?? { calls: 0, costMinor: 0 };
  assert.deepEqual([mine(spent).displayName, mine(spent).ownerId, mine(spent).calls - mine(spentBefore).calls, mine(spent).costMinor - mine(spentBefore).costMinor],
    ["SampleCompanion", A.owner, 2, 5]);
  // Counted another way: each transaction's last outcome, straight from the ledger.
  const ledger = (await pool.query(`select count(*)::int as calls, coalesce(sum(cost), 0)::int as cost from (
    select distinct on (transaction_id) actual_cost_minor as cost from public.compute_ledger_entries
    where entry_type in ('SETTLEMENT', 'RECONCILIATION') order by transaction_id, sequence desc) last`)).rows[0]!;
  assert.deepEqual([spent.totals.reduce((sum: number, t: Json) => sum + t.calls, 0), spent.totals.reduce((sum: number, t: Json) => sum + t.costMinor, 0)],
    [ledger.calls, ledger.cost], "the report adds up to the ledger");
  assert.deepEqual((await admin(one, "spend", "2020-01-01", "2020-01-02")), { from: "2020-01-01", to: "2020-01-02", totals: [], byDay: [], byCompanion: [] });
  passed("model switches and the quota change only with a reason and leave a before-and-after; the spend report matches the ledger");

  // ---- the Owner deletes the chat: it is gone for the console too ----
  await chat.remove(chatId);
  await assert.rejects(admin(two, "chat_read", chatId, "After the Owner deleted it"), code("P0001"));
  assert.ok(!(await admin(two, "chats", A.owner)).items.some((c: Json) => c.id === chatId));
  passed("a chat its Owner deleted cannot be read");

  // ---- the log ----
  for (const sql of ["update companion_private.admin_log set reason = 'rewritten'", "delete from companion_private.admin_log"]) {
    await assert.rejects(pool.query(sql), code("55000"), "not even the database administrator edits the log");
  }
  const about = await admin(one, "log", null, target.owner);
  assert.deepEqual(about.items.map((l: Json) => [l.action, l.operator, l.reason]).reverse(), [
    ["REMOVE_POST", "admin_test_one", "Harassment, see report"],
    ["RESOLVE_REPORT", "admin_test_one", "Harassment, see report"],
    ["REMOVE_COMMENT", about.items.at(-3).operator, "Racing"],
    ["RESOLVE_REPORT", about.items.at(-3).operator, "Racing"],
    ["SUSPEND_OWNER", "admin_test_one", "Repeated harassment"],
    ["RESOLVE_REPORT", "admin_test_one", "Repeated harassment"],
    ["RESTORE_OWNER", "admin_test_two", "Suspension served"],
    ["RESTORE_POST", "admin_test_one", "Removed by mistake"],
    ["RESTORE_COMMENT", "admin_test_one", "Comment was fine"],
    ["REMOVE_COMMENT", "admin_test_two", "On second thought"],
    ["RESOLVE_REPORT", "admin_test_two", "Already removed"],
    ["REMOVE_POST", "admin_test_two", "Direct removal"],
  ]);
  assert.equal(about.next, null);
  assert.equal(about.items.at(-1).detail.body, "Admin fixture post one", "the removed text is kept so it can be restored");
  const resolved = about.items.find((l: Json) => l.action === "RESOLVE_REPORT" && l.reason === "Harassment, see report").detail;
  assert.deepEqual([resolved.resolution, [...resolved.reports].sort()], ["REMOVED", [onPost, onPostToo].sort()]);
  // Enough rows for two pages (written as the database administrator, so the operator is that login).
  await pool.query(`insert into companion_private.admin_log(action, target_type, target_id, reason)
    select 'PAGING_FIXTURE', 'TEST', g::text, 'Paging fixture' from generate_series(1, 60) g`);
  const pageOne = await admin(one, "log");
  assert.equal(pageOne.items.length, 50);
  assert.equal(pageOne.next, pageOne.items[49].id);
  const pageTwo = await admin(one, "log", pageOne.next);
  assert.ok(pageTwo.items.length >= 10 && pageTwo.items[0].id < pageOne.next);
  const ids = [...pageOne.items, ...pageTwo.items].map((l: Json) => l.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => b - a), "newest first, no row twice");
  assert.equal(new Set(ids).size, ids.length);
  passed("the log cannot be changed, names who did what and why, and pages without gaps");

  // ---- the console itself, connected as an operator, against the real database ----
  const TOKEN = "c".repeat(64);
  consoleServer = createAdminServer({ db: new PgAdminDb(consolePool), token: TOKEN, timeZone: "UTC",
    catalog: [{ name: "Spend fixture", provider: "admin-test-provider", model: "m-spend" }] });
  const base = await new Promise<string>(resolve => consoleServer!.listen(0, "127.0.0.1", () =>
    resolve(`http://127.0.0.1:${(consoleServer!.address() as AddressInfo).port}`)));
  const web = async (path: string, form?: Record<string, string>) => {
    const response = await fetch(`${base}${path}`, { method: form ? "POST" : "GET", redirect: "manual",
      headers: { Cookie: `admin_console=${TOKEN}`, ...(form ? { "Content-Type": "application/x-www-form-urlencoded", Origin: base } : {}) },
      ...(form ? { body: new URLSearchParams(form).toString() } : {}) });
    return { status: response.status, location: response.headers.get("location"), body: await response.text() };
  };
  const why = (reason: string, more: Record<string, string> = {}) => ({ reason, confirm: "yes", ...more });
  assert.equal((await fetch(`${base}/reports`)).status, 403, "no token, no console");
  const entered = await fetch(`${base}/?token=${TOKEN}`, { redirect: "manual" });
  assert.deepEqual([entered.status, entered.headers.get("location")], [303, "/reports"]);

  const third = await person("Third");
  const fresh = await report(third.actor, target.actor, "POST", first, "Admin fixture post one");
  const open = await web("/reports");
  assert.equal(open.status, 200);
  assert.ok(open.body.includes(`action="/reports/${fresh}/resolve"`) && open.body.includes("Admin fixture post one"));
  assert.deepEqual(await web(`/reports/${fresh}/resolve`, why("Console removal", { resolution: "REMOVED", back: "/reports?status=SUBMITTED" })),
    { status: 303, location: "/reports?status=SUBMITTED&ok=1", body: "" });
  assert.equal(await seesPost(first), false);
  const closedList = await web("/reports?status=REVIEWED");
  assert.ok(closedList.body.includes("Console removal") && closedList.body.includes("admin_test_one"));
  assert.equal((await web(`/content/post/${first}/restore`, why("Console restore", { back: `/owners/${target.owner}` }))).location, `/owners/${target.owner}?ok=1`);
  assert.equal(await seesPost(first), true);

  const found = await web(`/owners?q=${encodeURIComponent(target.email)}`);
  assert.ok(found.body.includes(`<a href="/owners/${target.owner}">${target.email}</a>`));
  const opened = await web(`/owners/${target.owner}`);
  assert.ok(opened.status === 200 && opened.body.includes("Admin fixture post one") && opened.body.includes("Console restore"));
  assert.equal((await web(`/owners/${randomUUID()}`)).status, 404);
  assert.equal((await web(`/owners/${target.owner}/suspend`, why("Console suspension"))).status, 303);
  assert.equal(await claim(), null);
  assert.ok((await web(`/owners/${target.owner}`)).body.includes(`action="/owners/${target.owner}/restore"`));
  assert.equal((await web(`/owners/${target.owner}/restore`, why("Console lift"))).status, 303);
  assert.equal(await claim(), target.owner);
  const twice = await web(`/owners/${target.owner}/restore`, why("Console lift again", { back: `/owners/${target.owner}` }));
  assert.equal(twice.status, 409);
  assert.ok(twice.body.includes("现在并没有被停用 / 封禁") && twice.body.includes(`<a href="/owners/${target.owner}">返回</a>`));
  assert.equal((await web(`/owners/${target.owner}/suspend`, { reason: "No tick" })).status, 409);
  assert.equal(await claim(), target.owner);

  assert.ok((await web(`/owners/${B.owner}`)).body.includes(`action="/twins/${twinB}/suspend"`));
  assert.equal((await web(`/twins/${twinB}/suspend`, why("Console twin stop"))).status, 303);
  assert.equal(await seesProfile(aiB), false);
  assert.ok((await web(`/owners/${B.owner}`)).body.includes(`action="/twins/${twinB}/restore"`));
  assert.equal((await web(`/twins/${twinB}/restore`, why("Console twin back"))).status, 303);
  assert.equal(await seesProfile(aiB), true);

  await pool.query("insert into companion_private.chats(id, owner_id, title) values ($1, $2, 'Console fixture chat')", [consoleChat, A.owner]);
  await pool.query("insert into companion_private.chat_members(chat_id, companion_id, position) values ($1, $2, 1)", [consoleChat, A.companion]);
  await pool.query(`insert into companion_private.chat_messages(chat_id, body, status, key_hash, shown_at)
    values ($1, 'console private line', 'SENT', repeat('e', 64), now())`, [consoleChat]);
  assert.ok((await web(`/owners/${A.owner}`)).body.includes(`<a href="/chats/${consoleChat}">Console fixture chat</a>`));
  const gate = await web(`/chats/${consoleChat}`);
  assert.ok(gate.status === 200 && !gate.body.includes("console private line"));
  assert.equal((await web(`/chats/${consoleChat}`, { reason: " " })).status, 409);
  const shown = await web(`/chats/${consoleChat}`, { reason: "Console check" });
  assert.ok(shown.status === 200 && shown.body.includes("console private line") && shown.body.includes("SampleCompanion"));
  assert.deepEqual((await pool.query("select operator, reason from companion_private.admin_log where action = 'READ_CHAT' and target_id = $1", [consoleChat])).rows,
    [{ operator: "admin_test_one", reason: "Console check" }]);
  assert.equal((await web(`/chats/${randomUUID()}`, { reason: "No such chat" })).status, 409);

  assert.equal((await web("/models")).status, 200);
  const costs = await web("/costs");
  // The company's card, with the model under it.
  assert.ok(costs.status === 200 && costs.body.includes("<b>admin-test-provider</b>") && costs.body.includes("<b>m-spend</b>") && costs.body.includes("总花费"),
    "what was spent is on the costs page");
  const today = new Date().toISOString().slice(0, 10);
  const activity = (await consolePool.query("select companion_admin.activity($1::date) as a", [today])).rows[0].a;
  const todayRow = activity.days.find((d: { day: string }) => d.day === today);
  assert.ok(activity.owners > 0 && activity.chatters > 0 && todayRow.ownerMessages > 0 && todayRow.chatters > 0, "today's chat line is counted");
  assert.equal(activity.days.at(-1).day, today, "the running month stops at today");
  const system = (await consolePool.query("select companion_admin.system() as s")).rows[0].s;
  assert.ok(system.databaseBytes > 0 && system.maxConnections > 0 && system.connections > 0 && system.tables.length > 0, "the database's size and connections");
  const stats = await web("/stats");
  assert.ok(stats.status === 200 && stats.body.includes("今天聊天的人"), "the 运营数据 page");
  assert.ok((await web("/system")).body.includes("数据库空间"), "the 系统 page");
  assert.equal((await web("/costs?year=2026")).status, 200);
  assert.equal((await web("/costs/export.xlsx")).status, 200);
  assert.equal((await web("/models/switch", why("Console switch off", { target: "MODEL:admin-test-provider/m-spend", enabled: "off" }))).status, 303);
  assert.ok((await web("/models")).body.includes("关(模型关闭)"));
  assert.equal((await web("/models/switch", why("Console switch on", { target: "MODEL:admin-test-provider/m-spend", enabled: "on" }))).status, 303);
  assert.ok(!(await web("/models")).body.includes("关(模型关闭)"));
  assert.equal((await web("/models/quota", why("Console quota", { calls: String(quotaBefore.dailyCalls), cents: String(quotaBefore.dailyCostMinor) }))).status, 303);
  const logged = await web("/log");
  assert.ok(logged.status === 200 && ["Console quota", "Console switch on", "Console check", "查看私聊", "每日额度"].every(text => logged.body.includes(text)));
  assert.ok((await web(`/log?owner=${target.owner}`)).body.includes("Console suspension"));
  passed("the console pages work end to end as an operator: reports, Owners, Companions, content, chats, models, costs and the log");

  // ---- 家机说明: an operator rewords a block of what the models are told; the API server reads it ----
  const server = new PostgresChatAdapter(viewer);
  assert.deepEqual(await server.promptTexts(), {});
  assert.deepEqual(await admin(one, "prompts"), {});
  assert.ok((await web("/prompts")).body.includes("现在有 0 / 7 段改过"));
  assert.equal((await web("/prompts/set", why("Console wording", { key: "CHAT_VOICE", body: "- 没有标记。" }))).status, 409, "a wording without its mark is not saved");
  assert.equal((await web("/prompts/set", why("Console wording", { key: "CHAT_TIME", body: "- 留意现在几点。\r\n" }))).status, 303);
  assert.deepEqual(await server.promptTexts(), { CHAT_TIME: "- 留意现在几点。" }, "the API server reads it from the next call on");
  assert.ok((await web("/prompts")).body.includes("现在有 1 / 7 段改过"));
  await admin(two, "prompt_set", "CHAT_TIME", "- 第二版。", "Second wording");
  assert.equal((await admin(one, "prompts")).CHAT_TIME.body, "- 第二版。");
  await assert.rejects(admin(two, "prompt_set", "CHAT_TIME", "- x", " "), code("22023"));
  await assert.rejects(admin(two, "prompt_set", "chat_time", "- x", "Not a key"), code("23514"));
  await assert.rejects(admin(two, "prompt_set", "CHAT_TIME", "字".repeat(1001), "Too long"), code("23514"));
  assert.deepEqual(await server.promptTexts(), { CHAT_TIME: "- 第二版。" }, "a refused change leaves the wording as it was");
  assert.equal((await web("/prompts/set", why("Console wording back", { key: "CHAT_TIME", restore: "yes" }))).status, 303);
  assert.deepEqual(await server.promptTexts(), {});
  assert.equal((await web("/prompts/set", why("Console wording back", { key: "CHAT_TIME", restore: "yes" }))).status, 409, "nothing to go back from");
  assert.deepEqual((await pool.query("select operator, reason, detail from companion_private.admin_log where action = 'PROMPT_SET' order by id desc limit 3")).rows.reverse(), [
    { operator: "admin_test_one", reason: "Console wording", detail: { before: null, body: "- 留意现在几点。" } },
    { operator: "admin_test_two", reason: "Second wording", detail: { before: "- 留意现在几点。", body: "- 第二版。" } },
    { operator: "admin_test_one", reason: "Console wording back", detail: { before: "- 第二版。", body: null } },
  ], "every change is logged with the wording before and after");
  assert.ok((await web("/log")).body.includes("修改家机说明"));
  // An app user reaches neither the wording nor the way to change it.
  const user = await pool.connect();
  try {
    await user.query("begin"); await user.query("set local role authenticated");
    for (const sql of ["select public.prompt_texts()", "select * from companion_private.prompt_texts", "select companion_admin.prompt_set('CHAT_TIME', 'x', 'self-service')"]) {
      await user.query("savepoint s");
      await assert.rejects(user.query(sql), code("42501"), sql);
      await user.query("rollback to savepoint s");
    }
  } finally { await user.query("rollback"); user.release(); }
  passed("an operator rewords what the models are told, with a reason and a before-and-after in the log; the API server reads it, app users cannot");

  // Leave the shared database as other suites expect it.
  await pool.query("update public.community_posts set deleted_at = coalesce(deleted_at, now()) where id = any($1)", [[first, second]]);
  console.log(`Admin PostgreSQL integration passed: ${groups} scenario groups.`);
} finally {
  consoleServer?.closeAllConnections();
  await new Promise<void>(resolve => consoleServer ? consoleServer.close(() => resolve()) : resolve());
  await consolePool.end().catch(() => undefined);
  await pool.query("delete from companion_private.chats where id = any($1)", [[chatId, consoleChat]]).catch(() => undefined);
  await pool.query("delete from companion_private.prompt_texts").catch(() => undefined);
  await pool.query("update public.social_twins set status = 'ACTIVE' where id = $1", [twinB]).catch(() => undefined);
  await pool.query("update companion_private.chat_quota set daily_calls = $1, daily_cost_minor = $2", [quotaBefore.dailyCalls, quotaBefore.dailyCostMinor]).catch(() => undefined);
  await Promise.all(operators.map(client => client.end().catch(() => undefined)));
  for (const login of LOGINS) await pool.query(`drop role if exists ${login}`).catch(() => undefined);
  await pool.end();
}
