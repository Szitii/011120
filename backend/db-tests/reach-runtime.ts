import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createMobileDevHttpServer } from "../src/dev/mobile-http-server.ts";
import { createPgPool, PgOwnerExecutor } from "../src/persistence/postgres/index.ts";
import { PostgresChatAdapter } from "../src/chat/postgres.ts";
import { ChatReplies, devChatModel, type ChatModel } from "../src/chat/replies.ts";
import { ChatCatalog } from "../src/chat/models.ts";
import { PlatformChatModel } from "../src/chat/platform.ts";
import { BackgroundScheduler } from "../src/chat/background-scheduler.ts";
import { localStamp } from "../src/chat/prompt.ts";
import type { Chat, ChatPage, ChatSettings, PlatformFeatures, ReminderList } from "../../contracts/chat.ts";

// A Companion that writes first, and reminders (migration 0070).
const connectionString = process.env.DATABASE_URL;
if (!connectionString || process.env.COMPANION_SOCIAL_DEV_DATABASE !== "1") throw Error("Disposable seeded development database required.");
// Reading and typing delays run at 2% of real time here; set before the test's connections open.
const setup = createPgPool(connectionString);
await setup.query("do $$ begin execute format('alter database %I set companion.chat_pace = %L', current_database(), '0.02'); end $$");
await setup.end();

const pool = createPgPool(connectionString);
const A = { owner: "00000000-0000-0000-0000-0000000001a1", subject: "00000000-0000-0000-0000-0000000000a1", companion: "00000000-0000-0000-0000-0000000002a1" };
const B = { owner: "00000000-0000-0000-0000-0000000001b1", subject: "00000000-0000-0000-0000-0000000000b1" };
const servers = [A, B].map((v, i) => createMobileDevHttpServer({ pool, ownerId: v.owner, ownerSubject: v.subject, bearerToken: `reach-${i}` }));
const portA = new PostgresChatAdapter(new PgOwnerExecutor(pool, A.subject));
const server = new PgOwnerExecutor(pool, null);
const keyHash = () => createHash("sha256").update(randomUUID()).digest("hex");
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let groups = 0;
const passed = (name: string) => { groups += 1; console.log(`Reach integration ${groups}: ${name}`); };
const actor = `(select a.id from public.community_actors a join public.social_twins t on t.id = a.social_twin_id where t.companion_id = '${A.companion}')`;
const zoneBefore = (await pool.query(`select time_zone from companion_private.agent_settings where actor_id = ${actor}`)).rows[0]?.time_zone as string | undefined;

try {
  const bases = await Promise.all(servers.map(s => new Promise<string>(resolve =>
    s.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)))));
  async function call<T>(who: 0 | 1, path: string, method = "GET", body?: unknown) {
    const response = await fetch(`${bases[who]}/v0/${path}`, {
      method, headers: { Authorization: `Bearer reach-${who}`, "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json() as T };
  }
  /** Reads the chat until no reply is on the way, like the app polling. */
  async function settle(chatId: string): Promise<ChatPage> {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const page = await call<ChatPage>(0, `chats/${chatId}`);
      assert.equal(page.status, 200, JSON.stringify(page.data));
      if (!page.data.chat.replying) return page.data;
      await pause(20);
    }
    throw new Error("replies never finished");
  }
  const putSettings = async (change: Partial<ChatSettings>) => {
    const now = (await call<ChatSettings>(0, `companions/${A.companion}/chat-settings`)).data;
    return call<ChatSettings>(0, `companions/${A.companion}/chat-settings`, "PUT", { ...now, ...change });
  };
  /** Makes it `hour` o'clock for Owner A right now: a fixed-offset zone (their names have the sign the other way round). */
  async function ownerClock(hour: number) {
    const offset = ((hour - new Date().getUTCHours() + 36) % 24) - 12;
    const zone = offset === 0 ? "Etc/GMT" : `Etc/GMT${offset > 0 ? "-" : "+"}${Math.abs(offset)}`;
    await pool.query(`insert into companion_private.agent_settings(actor_id, time_zone) select ${actor}, $1
      on conflict (actor_id) do update set time_zone = excluded.time_zone`, [zone]);
    const context = await pool.query("select companion_private.chat_owner_context($1, $2)->>'timeZone' as zone", [A.owner, A.companion]);
    assert.equal(context.rows[0].zone, zone, "the Companion's clock follows its community settings");
    return zone;
  }
  /** The Owner says something and the Companion (the dev host's fake model) answers. */
  const ownerSays = async (chatId: string, body: string) => {
    assert.equal((await call(0, `chats/${chatId}/messages`, "POST", { body })).status, 201);
    return settle(chatId);
  };
  /** Everything in the chat happened `hours` earlier. */
  const age = (chatId: string, hours: number) => pool.query(`update companion_private.chat_messages set
    created_at = created_at - make_interval(hours => $2), shown_at = shown_at - make_interval(hours => $2),
    typing_at = typing_at - make_interval(hours => $2) where chat_id = $1`, [chatId, hours]);
  /**
   * A turn of the Companion's own (or one that delivered a reminder), `hoursAgo`: SENT with a body,
   * PASSED (it decided to say nothing), or PENDING (queued and never written).
   */
  const ownTurn = async (chatId: string, hoursAgo: number, status: "SENT" | "PASSED" | "PENDING" = "SENT", kind: "SELF" | "REMINDER" = "SELF") =>
    (await pool.query(`insert into companion_private.chat_messages(chat_id, companion_id, body, status, reply_to, optional, created_at, shown_at)
     values ($1, $2, $3, $4, $6, true, now() - make_interval(mins => $5), case when $4 = 'PENDING' then null else now() - make_interval(mins => $5) end) returning id`,
    [chatId, A.companion, status === "SENT" ? "在吗" : null, status, Math.round(hoursAgo * 60), kind])).rows[0].id as string;
  const forget = (id: string) => pool.query("delete from companion_private.chat_messages where id = $1", [id]);
  const waiting = async () => (await call<ReminderList>(0, `companions/${A.companion}/reminders`)).data.items;
  const reminderRows = async () => (await pool.query(
    "select note, status from companion_private.chat_reminders where companion_id = $1 order by created_at, id", [A.companion])).rows as { note: string; status: string }[];
  /** Who the scheduler would write for now: `reminders` true for due reminders, false for writing first. */
  const dueList = async (platform: boolean, reminders = false) => (await server.query<{ payload: { companionId: string; subject: string }[] }>(
    `select public.${reminders ? "chat_reminder_due" : "chat_reach_due"}(10, $1) as payload`, [platform])).rows[0]!.payload;
  const says = (...lines: string[]): ChatModel => ({ reply: async () => ({ messages: lines }) });

  // ---- the setting and the switch ----
  assert.equal((await call<ChatSettings>(0, `companions/${A.companion}/chat-settings`)).data.proactive, "OFF", "off unless the Owner turns it on");
  assert.equal((await putSettings({ proactive: "LOUD" as never })).status, 400);
  assert.equal((await putSettings({ proactive: "OFTEN" })).data.proactive, "OFTEN");
  const { proactive: _proactive, ...without } = (await call<ChatSettings>(0, `companions/${A.companion}/chat-settings`)).data;
  assert.equal((await call<ChatSettings>(0, `companions/${A.companion}/chat-settings`, "PUT", without)).data.proactive, "OFTEN", "an app that does not send it keeps it");
  assert.equal((await call<PlatformFeatures>(0, "features")).data.companionReach, true);
  assert.equal((await call(1, `companions/${A.companion}/reminders`)).status, 404, "another Owner's Companion");
  assert.deepEqual(await waiting(), []);
  passed("the setting is off by default, kept when left out, and the operators' switch is on");

  // ---- when it may write first ----
  await ownerClock(12);
  const chat = (await call<Chat>(0, "chats", "POST", { companionIds: [A.companion] })).data;
  const due = async (level: "SOMETIMES" | "OFTEN") => (await pool.query(
    "select companion_private.chat_greeting_due(c, $2) as due from companion_private.chats c where c.id = $1", [chat.id, level])).rows[0].due as boolean;
  assert.equal(await due("OFTEN"), false, "the Owner never wrote here");
  await ownerSays(chat.id, "在吗");
  assert.equal(await due("OFTEN"), false, "they are talking now");
  await age(chat.id, 7);
  assert.deepEqual([await due("OFTEN"), await due("SOMETIMES")], [true, false], "3 hours and up to as long again; 8 hours for SOMETIMES");
  await age(chat.id, 10);
  assert.equal(await due("SOMETIMES"), true, "17 hours of silence");
  await age(chat.id, 8 * 24);
  assert.equal(await due("OFTEN"), false, "gone for more than a week: it stops");
  await pool.query("delete from companion_private.chat_messages where chat_id = $1", [chat.id]);
  await ownerSays(chat.id, "又来了");
  await age(chat.id, 7);
  for (const [hour, may] of [[3, false], [6, false], [23, false], [10, true], [21, true], [12, true]] as const) {
    await ownerClock(hour);
    assert.equal(await due("OFTEN"), may, `at ${hour} o'clock for the Owner`);
  }
  // Between 8 and 10 the day starts at a minute of this chat's own, another one every day.
  for (const hour of [8, 9]) {
    const zone = await ownerClock(hour);
    const morning = (await pool.query(`select extract(hour from l) * 60 + extract(minute from l) as now,
        480 + ((hashtext($1::text || l::date::text) & 2147483647) % 120) as starts from (select now() at time zone $2 as l) t`, [chat.id, zone])).rows[0];
    assert.ok(morning.starts >= 480 && morning.starts < 600);
    assert.equal(await due("OFTEN"), Number(morning.now) >= morning.starts, `at ${hour}, with the day starting at minute ${morning.starts}`);
  }
  await ownerClock(12);
  const pending = (await pool.query(`insert into companion_private.chat_messages(chat_id, companion_id, status, reply_to, optional)
    values ($1, $2, 'PENDING', 'OWNER', true) returning id`, [chat.id, A.companion])).rows[0].id as string;
  assert.equal(await due("OFTEN"), false, "something is waiting to be answered");
  await forget(pending);
  const unanswered = await ownTurn(chat.id, 1);
  assert.equal(await due("OFTEN"), false, "it already wrote and the Owner has not answered: no second message");
  await forget(unanswered);
  const reminded = await ownTurn(chat.id, 1, "SENT", "REMINDER");
  assert.equal(await due("OFTEN"), false, "nor after a reminder the Owner has not answered");
  await forget(reminded);
  const answeredReminder = await ownTurn(chat.id, 9, "SENT", "REMINDER");
  assert.equal(await due("OFTEN"), true, "a reminder from before the Owner's last message is no attempt of its own");
  await forget(answeredReminder);
  const tried = await ownTurn(chat.id, 1, "PASSED");
  assert.equal(await due("OFTEN"), false, "it decided to say nothing an hour ago: not asked again so soon");
  await pool.query("update companion_private.chat_messages set created_at = now() - interval '4 hours', shown_at = now() - interval '4 hours' where id = $1", [tried]);
  assert.equal(await due("OFTEN"), true);
  await forget(tried);
  // Twice today already (at 2 and at 3; the Owner answered at 5): that is all for OFTEN.
  const [early, earlier] = [await ownTurn(chat.id, 9), await ownTurn(chat.id, 10)];
  assert.equal(await due("OFTEN"), false, "twice a day at most");
  await forget(earlier);
  assert.equal(await due("OFTEN"), true, "once so far today");
  await forget(early);
  // SOMETIMES, at 21:00: it wrote at 1, the Owner answered at 4 and has been silent since.
  await ownerClock(21);
  await age(chat.id, 10);
  const once = await ownTurn(chat.id, 20);
  assert.equal(await due("SOMETIMES"), false, "once a day at most");
  await forget(once);
  assert.equal(await due("SOMETIMES"), true);
  await ownerClock(12);
  await pool.query("delete from companion_private.chat_messages where chat_id = $1", [chat.id]);
  passed("it may write first only by day, after a long enough silence, once unanswered, and so many times a day");

  // ---- writing first, through the scheduler ----
  await ownerSays(chat.id, "我去忙了");
  assert.deepEqual(await dueList(true), [], "nobody is due yet");
  await age(chat.id, 7);
  assert.deepEqual(await dueList(true), [{ companionId: A.companion, subject: A.subject }]);
  assert.deepEqual(await dueList(false), [], "without a platform model, only Companions on the Owner's own key or agent write first");
  assert.deepEqual(await dueList(true, true), [], "no reminder is due");
  const replies = new ChatReplies(devChatModel);
  const schedule = (due: "chat_reach_due" | "chat_reminder_due") => new BackgroundScheduler({ server,
    portFor: subject => new PostgresChatAdapter(new PgOwnerExecutor(pool, subject)),
    due, what: "message of its own", platform: true, write: (id, port) => replies.reachOut(id, port) });
  const scheduler = schedule("chat_reach_due"), reminderScheduler = schedule("chat_reminder_due");
  // A turn of its own that was queued four hours ago and never written (the server stopped): let go, and a new one is queued.
  const abandoned = await ownTurn(chat.id, 4, "PENDING");
  assert.equal(await due("OFTEN"), true, "it does not stand in the way");
  assert.equal(await scheduler.round(), 1);
  let page = await settle(chat.id);
  assert.deepEqual([page.items[0]!.body, page.items[0]!.companionId, page.items[0]!.reach, page.items[0]!.reminder, page.items[1]!.reach],
    ["（开发环境假回复）SampleCompanion主动来找你了", A.companion, "GREETING", null, null], "an ordinary message of the Companion, marked as its own initiative");
  assert.equal((await pool.query("select status from companion_private.chat_messages where id = $1", [abandoned])).rows[0].status, "PASSED");
  assert.equal(await scheduler.round(), 0, "one message left unanswered is where it stops");
  assert.equal(await replies.reachOut(A.companion, portA), "NOT_DUE");
  await assert.rejects(new PostgresChatAdapter(new PgOwnerExecutor(pool, B.subject)).reachBegin(A.companion), { code: "NOT_FOUND" });
  // The Owner answers and goes quiet again; this time it decides to say nothing, and is not asked again for a while.
  await ownerSays(chat.id, "来了");
  await age(chat.id, 7);
  const before = (await settle(chat.id)).items.length;
  assert.equal(await new ChatReplies({ reply: async () => ({ pass: true }) }).reachOut(A.companion, portA), "QUEUED");
  assert.equal((await settle(chat.id)).items.length, before, "it said nothing, and nothing is shown");
  assert.equal(await replies.reachOut(A.companion, portA), "NOT_DUE");
  // Through a platform model the call is booked like a reply, and settled.
  await age(chat.id, 7);
  const catalog = new ChatCatalog({ defaultModel: "fake", decisionModel: null, providers: { reachp: { kind: "anthropic", apiKeyEnv: "FAKE_KEY" } },
    models: [{ id: "fake", name: "Fake", provider: "reachp", model: "fake-1", tier: "ECONOMY", inputPerMTok: 1, outputPerMTok: 1, enabled: true }] }, { FAKE_KEY: "k" });
  const engine = new PlatformChatModel(catalog, async () => ({ text: "忙完了吗", inputTokens: 300, outputTokens: 5, refused: false, cutOff: false }));
  assert.equal(await new ChatReplies(engine).reachOut(A.companion, portA), "QUEUED");
  page = await settle(chat.id);
  assert.deepEqual([page.items[0]!.body, page.items[0]!.reach], ["忙完了吗", "GREETING"]);
  const spent = await pool.query(`select x.reason_code, e.status from public.compute_transactions x
      join public.compute_ledger_entries e on e.transaction_id = x.id
    where x.companion_id = $1 and x.provider_id = 'reachp' and e.entry_type = 'SETTLEMENT'`, [A.companion]);
  assert.deepEqual(spent.rows, [{ reason_code: "OWNER_DIRECT_RESPONSE", status: "SUCCEEDED" }]);
  // The Owner writes while a turn of its own is still queued: it answers the Owner and drops its own.
  await ownerSays(chat.id, "嗯");
  await age(chat.id, 7);
  assert.deepEqual(await portA.reachBegin(A.companion), { status: "QUEUED", chatId: chat.id, kind: "GREETING" });
  await portA.send(chat.id, "我回来了", [], keyHash());
  assert.equal(await replies.drain(chat.id, portA), 1, "one turn is written");
  page = await settle(chat.id);
  assert.deepEqual(page.items.slice(0, 3).map(m => [m.body, m.reach]),
    [["收到：「我回来了」", null], ["（开发环境假回复）我是SampleCompanion", null], ["我回来了", null]]);
  const dropped = await pool.query("select status from companion_private.chat_messages where chat_id = $1 and reply_to = 'SELF' order by created_at desc limit 1", [chat.id]);
  assert.equal(dropped.rows[0].status, "PASSED");
  // One that waited more than ten minutes is not written late, whenever the chat is next looked at.
  const stale = await ownTurn(chat.id, 0.2, "PENDING");
  assert.equal(await replies.drain(chat.id, portA), 0);
  assert.equal((await pool.query("select status from companion_private.chat_messages where id = $1", [stale])).rows[0].status, "PASSED");
  passed("the scheduler finds who is due and the Companion writes, says nothing, or yields to the Owner; the call is booked");

  // ---- reminders: set in a reply, delivered at their time ----
  await putSettings({ proactive: "OFF" }); // reminders do not depend on it,
  const zoneAtNight = await ownerClock(3); // nor on the hour
  page = await ownerSays(chat.id, "过会儿提醒我喝水");
  const promised = page.items.find(m => m.reminder != null)!;
  assert.deepEqual([promised.companionId, promised.reminder!.note, promised.reminder!.status], [A.companion, "开发环境的假提醒", "WAITING"]);
  const ahead = Date.parse(promised.reminder!.dueAt) - Date.now();
  assert.ok(ahead > 30_000 && ahead < 125_000, `one to two minutes from now, written on the Owner's clock and read back on it (${ahead} ms)`);
  assert.ok(page.items.every(m => !m.body?.includes("[提醒")), "the mark is not shown");
  assert.deepEqual(await waiting(), [promised.reminder]);
  assert.equal((await call(1, `companions/${A.companion}/reminders/${promised.reminder!.id}`, "DELETE")).status, 404, "another Owner's Companion");
  assert.equal(await replies.reachOut(A.companion, portA), "NOT_DUE", "not yet");
  await pool.query("update companion_private.chat_reminders set due_at = now() - interval '1 minute' where id = $1", [promised.reminder!.id]);
  assert.deepEqual([await dueList(false, true), await dueList(true)], [[{ companionId: A.companion, subject: A.subject }], []],
    "a reminder needs no model, and is not the business of the scheduler for writing first");
  assert.equal(await reminderScheduler.round(), 1);
  page = await settle(chat.id);
  assert.deepEqual([page.items[0]!.body, page.items[0]!.reach], ["（开发环境假回复）到时间啦：开发环境的假提醒", "REMINDER"]);
  assert.deepEqual([await waiting(), await reminderRows()], [[], [{ note: "开发环境的假提醒", status: "SENT" }]]);
  assert.equal(await reminderScheduler.round(), 0);
  // A reply through any model sets one the same way; with no model at all it is still delivered, in plain words.
  const inHours = (hours: number) => localStamp(new Date(Date.now() + hours * 3_600_000), zoneAtNight);
  const answer = async (...lines: string[]) => {
    await portA.send(chat.id, "到时候提醒我", [], keyHash());
    assert.equal(await new ChatReplies(says(...lines)).drain(chat.id, portA), 1);
    return settle(chat.id);
  };
  page = await answer("好，到点叫你", `[提醒:${inHours(2)} 交报告]`);
  assert.deepEqual([page.items[0]!.body, page.items[0]!.reminder?.note], ["好，到点叫你", "交报告"]);
  await pool.query("update companion_private.chat_reminders set due_at = now() - interval '2 hours' where status = 'WAITING'");
  assert.equal(await new ChatReplies().reachOut(A.companion, portA), "QUEUED");
  page = await settle(chat.id);
  assert.deepEqual([page.items[0]!.body, page.items[0]!.reach, (await reminderRows()).at(-1)], ["提醒你：交报告", "REMINDER", { note: "交报告", status: "SENT" }]);
  passed("a reminder is set in a reply, shown with it, and delivered at its time whatever the hour, the setting or the model");

  // ---- what sets nothing, and the limits ----
  await pool.query("delete from companion_private.chat_reminders where companion_id = $1", [A.companion]);
  for (const mark of [`[提醒:${inHours(-1)} 已经过去了]`, `[提醒:${inHours(367 * 24)} 太远了]`, "[提醒:2026-13-40 25:61 不是时间]"]) {
    page = await answer("好", mark);
    assert.deepEqual([page.items[0]!.body, page.items[0]!.reminder, await waiting()], ["好", null, []], mark);
  }
  page = await answer("好", `[提醒:${inHours(3)} 第一次]`);
  page = await answer("记着呢", `[提醒:${inHours(3)} 同一分钟再说一次]`);
  assert.deepEqual([(await waiting()).map(r => r.note), page.items[0]!.reminder], [["第一次"], null], "it already has one for that minute");
  // A claim handed in by hand: an id that is not one and a time that is not one are skipped, the reply is kept.
  await portA.send(chat.id, "随便", [], keyHash());
  const claim = (await portA.claim(chat.id))!;
  assert.deepEqual([claim.canRemind, claim.reminders!.map(r => r.note), claim.reach], [true, ["第一次"], null]);
  assert.equal(await portA.finish(claim.replyId, claim.claimId, "SENT", ["好"], undefined, undefined,
    { set: { at: "明天早上", note: "不是时间" }, cancel: ["not-a-uuid", randomUUID()] }), true);
  assert.deepEqual((await waiting()).map(r => r.note), ["第一次"]);
  await pool.query(`insert into companion_private.chat_reminders(chat_id, companion_id, note, due_at)
    select $1, $2, '占位 ' || g, now() + make_interval(days => g) from generate_series(1, 19) g`, [chat.id, A.companion]);
  page = await answer("好", `[提醒:${inHours(5)} 第二十一个]`);
  assert.deepEqual([(await waiting()).length, page.items[0]!.reminder], [20, null], "at most 20 wait");
  await pool.query("delete from companion_private.chat_reminders where note like '占位%'");
  passed("a time that cannot be read or is out of range, a second one for the same minute and a 21st set nothing; the reply is kept");

  // ---- cancelling, missing, and the switch ----
  page = await answer("不叫了", "[取消提醒:1]");
  assert.deepEqual([page.items[0]!.body, await waiting(), (await reminderRows()).at(-1)!.status], ["不叫了", [], "CANCELLED"], "the Companion cancels it when the Owner says so");
  page = await answer("好", `[提醒:${inHours(1)} 主人自己取消]`);
  const mine = page.items[0]!.reminder!;
  assert.deepEqual((await call(0, `companions/${A.companion}/reminders/${mine.id}`, "DELETE")).data, { deleted: true });
  assert.equal((await call(0, `companions/${A.companion}/reminders/${mine.id}`, "DELETE")).status, 404, "only once");
  await pool.query("update companion_private.chat_reminders set due_at = now() - interval '1 minute' where id = $1", [mine.id]);
  assert.deepEqual(await dueList(true, true), [], "a cancelled reminder is not delivered");
  // Cancelled while its turn is already queued: the turn is dropped.
  page = await answer("好", `[提醒:${inHours(1)} 排上了又取消]`);
  const late = page.items[0]!.reminder!;
  await pool.query("update companion_private.chat_reminders set due_at = now() - interval '1 minute' where id = $1", [late.id]);
  assert.deepEqual(await portA.reachBegin(A.companion), { status: "QUEUED", chatId: chat.id, kind: "REMINDER" });
  assert.equal((await call(0, `companions/${A.companion}/reminders/${late.id}`, "DELETE")).status, 200);
  const shown = (await settle(chat.id)).items.length;
  assert.equal(await replies.drain(chat.id, portA), 0);
  assert.equal((await settle(chat.id)).items.length, shown, "nothing is said");
  // Queued, and then the server stopped before writing it: the scheduler finds it again.
  page = await answer("好", `[提醒:${inHours(1)} 服务器停过一下]`);
  await pool.query("update companion_private.chat_reminders set due_at = now() - interval '1 minute' where id = $1", [page.items[0]!.reminder!.id]);
  assert.deepEqual(await portA.reachBegin(A.companion), { status: "QUEUED", chatId: chat.id, kind: "REMINDER" });
  assert.deepEqual(await dueList(false, true), [{ companionId: A.companion, subject: A.subject }], "still due: nobody is writing it");
  const stuck = (await portA.claim(chat.id))!;
  assert.deepEqual([stuck.replyTo, stuck.reach], ["REMINDER", { kind: "REMINDER", note: "服务器停过一下", dueAt: (await waiting())[0]!.dueAt }]);
  assert.deepEqual(await dueList(false, true), [], "someone is writing it now");
  await pool.query("update companion_private.chat_messages set claimed_at = now() - interval '3 minutes' where id = $1", [stuck.replyId]);
  assert.equal(await reminderScheduler.round(), 1);
  assert.equal((await settle(chat.id)).items[0]!.body, "（开发环境假回复）到时间啦：服务器停过一下");
  // Due while the chat waits for another reply: next round. Due for more than a day: given up.
  page = await answer("好", `[提醒:${inHours(1)} 等一等]`);
  const patient = page.items[0]!.reminder!;
  await pool.query("update companion_private.chat_reminders set due_at = now() - interval '1 minute' where id = $1", [patient.id]);
  await portA.send(chat.id, "先回我这句", [], keyHash());
  assert.deepEqual(await portA.reachBegin(A.companion), { status: "BUSY" });
  // Nobody wrote that reply for two minutes (the server stopped): the scheduler writes it, and then the reminder.
  await pool.query("update companion_private.chat_messages set created_at = created_at - interval '3 minutes' where chat_id = $1 and status = 'PENDING'", [chat.id]);
  assert.equal(await reminderScheduler.round(), 1);
  assert.equal((await settle(chat.id)).items[0]!.body, "收到：「先回我这句」", "the Owner's message got its answer");
  assert.equal(await reminderScheduler.round(), 1);
  assert.equal((await settle(chat.id)).items[0]!.body, "（开发环境假回复）到时间啦：等一等");
  page = await answer("好", `[提醒:${inHours(1)} 错过了]`);
  const missed = page.items[0]!;
  await pool.query("update companion_private.chat_reminders set due_at = now() - interval '25 hours' where id = $1", [missed.reminder!.id]);
  assert.deepEqual([await waiting(), (await settle(chat.id)).items.find(m => m.id === missed.id)!.reminder!.status], [[], "MISSED"],
    "more than a day late reads as missed, whether or not the scheduler has been by");
  assert.deepEqual([await replies.reachOut(A.companion, portA), (await reminderRows()).at(-1)], ["NOT_DUE", { note: "错过了", status: "MISSED" }]);
  // The operators' switch stops both: nothing is delivered, set or written first, and the app is told.
  page = await answer("好", `[提醒:${inHours(1)} 开关关了]`);
  await pool.query("update companion_private.chat_reminders set due_at = now() - interval '1 minute' where id = $1", [page.items[0]!.reminder!.id]);
  await pool.query("update companion_private.feature_switches set enabled = false where key = 'COMPANION_REACH'");
  assert.deepEqual([await dueList(true), await dueList(true, true), await portA.reachBegin(A.companion)], [[], [], { status: "OFF" }]);
  assert.equal((await call<PlatformFeatures>(0, "features")).data.companionReach, false);
  page = await ownerSays(chat.id, "再提醒我一次");
  assert.ok(page.items.slice(0, 3).every(m => m.reminder === null), "while it is off no reminder is set");
  await pool.query("update companion_private.feature_switches set enabled = true where key = 'COMPANION_REACH'");
  assert.equal(await replies.reachOut(A.companion, portA), "QUEUED", "what was waiting is delivered once it is on again");
  await settle(chat.id);
  // Reminders go with the chat.
  page = await answer("好", `[提醒:${inHours(1)} 跟着聊天一起删]`);
  assert.equal((await waiting()).length, 1);
  assert.equal((await call(0, `chats/${chat.id}`, "DELETE")).status, 200);
  assert.deepEqual([await waiting(), await reminderRows()], [[], []]);
  passed("reminders are cancelled by either side, wait their turn, are given up after a day, stop with the switch and go with the chat");

  // ---- not reachable around the API server ----
  const direct = await pool.connect();
  try {
    await direct.query("begin");
    await direct.query("set local role authenticated");
    await direct.query("select set_config('request.jwt.claim.sub', $1, true)", [A.subject]);
    for (const sql of ["select * from companion_private.chat_reminders", `select public.chat_reach_begin('${A.companion}')`, "select public.chat_reach_due(10, true)",
      "select public.chat_reminder_due(10, true)"]) {
      await direct.query("savepoint s");
      await assert.rejects(direct.query(sql), /permission denied/, sql);
      await direct.query("rollback to savepoint s");
    }
  } finally {
    await direct.query("rollback");
    direct.release();
  }
  passed("reminders and the scheduler's functions are not reachable by signed-in users directly");
} finally {
  // Leave the shared development database as other suites expect it.
  await pool.query("delete from companion_private.chats where owner_id = $1", [A.owner]);
  await pool.query("delete from companion_private.chat_settings");
  await pool.query("update companion_private.feature_switches set enabled = true where key = 'COMPANION_REACH'");
  if (zoneBefore === undefined) await pool.query(`delete from companion_private.agent_settings where actor_id = ${actor}`);
  else await pool.query(`update companion_private.agent_settings set time_zone = $1 where actor_id = ${actor}`, [zoneBefore]);
  await pool.query("do $$ begin execute format('alter database %I reset companion.chat_pace', current_database()); end $$");
  await Promise.all(servers.map(s => new Promise(resolve => s.close(resolve))));
  await pool.end();
}
console.log(`Reach integration passed (${groups} groups).`);
