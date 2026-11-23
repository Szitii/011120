import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createMobileDevHttpServer } from "../src/dev/mobile-http-server.ts";
import { createPgPool, PgOwnerExecutor } from "../src/persistence/postgres/index.ts";
import { PostgresChatAdapter } from "../src/chat/postgres.ts";
import { ChatReplies, devChatModel } from "../src/chat/replies.ts";
import { ChatCatalog } from "../src/chat/models.ts";
import { PlatformChatModel } from "../src/chat/platform.ts";
import type { ChatClaim } from "../src/chat/port.ts";
import type { Chat, ChatPage, ChatSendResult, ChatSettings, CompanionActionResult } from "../../contracts/chat.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString || process.env.COMPANION_SOCIAL_DEV_DATABASE !== "1") throw Error("Disposable seeded development database required.");
// Reading and typing delays run at 2% of real time here; set before the test's connections open.
const PACE = 0.02;
const setup = createPgPool(connectionString);
await setup.query(`do $$ begin execute format('alter database %I set companion.chat_pace = %L', current_database(), '${PACE}'); end $$`);
await setup.end();

const pool = createPgPool(connectionString);
const A = { owner: "00000000-0000-0000-0000-0000000001a1", subject: "00000000-0000-0000-0000-0000000000a1", companion: "00000000-0000-0000-0000-0000000002a1" };
const B = { owner: "00000000-0000-0000-0000-0000000001b1", subject: "00000000-0000-0000-0000-0000000000b1", companion: "00000000-0000-0000-0000-0000000002b1" };
const second = "00000000-0000-0000-0000-0000000002a2";
const servers = [A, B].map((v, i) => createMobileDevHttpServer({ pool, ownerId: v.owner, ownerSubject: v.subject, bearerToken: `chat-${i}` }));
const portA = new PostgresChatAdapter(new PgOwnerExecutor(pool, A.subject));
const keyHash = () => createHash("sha256").update(randomUUID()).digest("hex");
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let groups = 0;
const passed = (name: string) => { groups += 1; console.log(`Chat integration ${groups}: ${name}`); };

try {
  // A second Companion for Owner A, so group chats can be tested.
  await pool.query("insert into public.companions (id, owner_id, status, origin_type) values ($1, $2, 'ACTIVE', 'IMPORTED_CARD')", [second, A.owner]);
  await pool.query(`insert into public.companion_identities (id, owner_id, companion_id, version, display_name, identity_document,
      source_manifest, content_hash, created_by, approved_by_owner_at)
    values ('00000000-0000-0000-0000-0000000003a2', $1, $2, 1, 'SecondCompanion', '{"persona":"calm"}', '{"fixture":"chat"}',
      repeat('c', 64), 'IMPORT_FIREWALL', now())`, [A.owner, second]);
  await pool.query("update public.companions set current_identity_version_id = '00000000-0000-0000-0000-0000000003a2' where id = $1", [second]);

  const bases = await Promise.all(servers.map(server => new Promise<string>(resolve =>
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)))));
  async function call<T>(who: 0 | 1, path: string, method = "GET", body?: unknown, key: string = randomUUID()) {
    const response = await fetch(`${bases[who]}/v0/${path}`, {
      method, headers: { Authorization: `Bearer chat-${who}`, "Content-Type": "application/json", "Idempotency-Key": key },
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
  /** Who spoke, oldest first, one letter per turn (several messages in a row count once). */
  const turns = (page: ChatPage) => [...page.items].reverse().map(m => m.companionId === null ? "O" : m.companionId === A.companion ? "A" : "S")
    .filter((who, i, all) => i === 0 || who !== all[i - 1]).join("");
  const putSettings = async (companion: string, change: Partial<ChatSettings>) => {
    const now = (await call<ChatSettings>(0, `companions/${companion}/chat-settings`)).data;
    return call<ChatSettings>(0, `companions/${companion}/chat-settings`, "PUT", { ...now, ...change });
  };

  const direct = await call<Chat>(0, "chats", "POST", { companionIds: [A.companion] });
  assert.equal(direct.status, 200, JSON.stringify(direct.data));
  assert.deepEqual([direct.data.direct, direct.data.title, direct.data.members, direct.data.replying],
    [true, null, [{ companionId: A.companion, displayName: "SampleCompanion" }], false]);
  assert.equal((await call<Chat>(0, "chats", "POST", { companionIds: [A.companion] })).data.id, direct.data.id);
  assert.equal((await call(1, "chats", "POST", { companionIds: [A.companion] })).status, 404);
  assert.equal((await call(1, `chats/${direct.data.id}`)).status, 404);
  assert.equal((await call(0, "chats", "POST", { companionIds: [A.companion], title: "no titles one-to-one" })).status, 400);
  passed("one chat per Companion; other Owners cannot open or read it");

  const key = randomUUID();
  const sent = await call<ChatSendResult>(0, `chats/${direct.data.id}/messages`, "POST", { body: " 你好呀 " }, key);
  assert.equal(sent.status, 201, JSON.stringify(sent.data));
  // It reads the message before it starts typing.
  assert.deepEqual([sent.data.message.body, sent.data.message.companionId, sent.data.typing, sent.data.replying], ["你好呀", null, [], true]);
  let page = await settle(direct.data.id);
  assert.deepEqual(page.items.map(m => m.body), ["收到：「你好呀」", "（开发环境假回复）我是SampleCompanion", "你好呀"]);
  const replay = await call<ChatSendResult>(0, `chats/${direct.data.id}/messages`, "POST", { body: "你好呀" }, key);
  assert.equal(replay.data.message.id, sent.data.message.id);
  assert.equal((await settle(direct.data.id)).items.length, 3);
  assert.equal((await call(0, `chats/${direct.data.id}/messages`, "POST", { body: "别的话" }, key)).status, 409);
  assert.equal((await call(1, `chats/${direct.data.id}/messages`, "POST", { body: "intruder" })).status, 404);
  assert.equal((await call(0, `chats/${direct.data.id}/messages`, "POST", { body: "hi", mentions: [B.companion] })).status, 400);
  passed("send, a reply of two short messages, retry with the same key, and refusals");

  const timeline = (await pool.query<{ typing: number; shown: number; len: number }>(`
    select extract(epoch from m.typing_at - o.shown_at)::float8 as typing,
      extract(epoch from m.shown_at - o.shown_at)::float8 as shown, char_length(m.body) as len
    from companion_private.chat_messages m join companion_private.chat_messages o on o.id = $2
    where m.chat_id = $1 and m.companion_id is not null order by m.shown_at`, [direct.data.id, sent.data.message.id])).rows;
  const [first, then] = timeline as [typeof timeline[0], typeof timeline[0]];
  const typed = (len: number) => PACE * Math.min(6, Math.max(1, 0.8 + 0.08 * len));
  assert.ok(first.typing >= PACE * 1 - 0.001 && first.typing <= PACE * 3 + 0.001, `reading delay ${first.typing}`);
  assert.ok(first.shown >= first.typing + typed(first.len) - 0.001, "typed for a time that grows with its length");
  assert.ok(then.typing >= first.shown + PACE * 0.6 - 0.001 && then.shown >= then.typing + typed(then.len) - 0.001,
    "the second message is typed after the first appears");
  // A message is not shown before its time; meanwhile its writer shows as typing.
  await pool.query("update companion_private.chat_messages set typing_at = now() - interval '1 second', shown_at = now() + interval '1 hour' where chat_id = $1 and part = 2", [direct.data.id]);
  page = (await call<ChatPage>(0, `chats/${direct.data.id}`)).data;
  assert.deepEqual([page.items.length, page.chat.typing, page.chat.replying, page.chat.lastMessage?.body],
    [2, [A.companion], true, "（开发环境假回复）我是SampleCompanion"]);
  await pool.query("update companion_private.chat_messages set shown_at = now() where chat_id = $1 and part = 2", [direct.data.id]);
  passed("pacing: a reading delay, typing time by length, one message after another, nothing shown early");

  const group = await call<Chat>(0, "chats", "POST", { companionIds: [A.companion, second], title: "一家人" }, "group-key-0000000001");
  assert.equal(group.status, 200, JSON.stringify(group.data));
  assert.equal((await call<Chat>(0, "chats", "POST", { companionIds: [A.companion, second], title: "一家人" }, "group-key-0000000001")).data.id, group.data.id);
  assert.equal((await call(0, "chats", "POST", { companionIds: [second, A.companion], title: "一家人" }, "group-key-0000000001")).status, 409);
  assert.equal((await call(0, "chats", "POST", { companionIds: [A.companion, B.companion] })).status, 404);
  const racing = await Promise.all([0, 1].map(() => call<Chat>(0, "chats", "POST", { companionIds: [second, A.companion] }, "group-key-race-00001")));
  assert.deepEqual(racing.map(r => r.status), [200, 200], "a retry racing the first request gets the same group");
  assert.equal(racing[0]!.data.id, racing[1]!.data.id);
  await call(0, `chats/${racing[0]!.data.id}`, "DELETE");
  const hello = await call<ChatSendResult>(0, `chats/${group.data.id}/messages`, "POST", { body: "大家好" });
  assert.equal(hello.status, 201, JSON.stringify(hello.data));
  assert.deepEqual([hello.data.typing, hello.data.replying], [[], true], "optional turns show nothing while deciding");
  page = await settle(group.data.id);
  // Both answer the Owner (it concerns everyone), then each answers the other twice (interaction NORMAL).
  assert.equal(turns(page), "OASASAS");
  assert.match(page.items[0]!.body!, /SecondCompanion接着SampleCompanion的话说一句/);
  passed("a group: both answer the Owner, then they talk to each other within their interaction limit");

  assert.deepEqual((await call<ChatSettings>(0, `companions/${second}/chat-settings`)).data, { groupActivity: "NORMAL", companionInteraction: "NORMAL", model: null, revision: 1 });
  assert.equal((await call(1, `companions/${second}/chat-settings`)).status, 404);
  const quiet = await putSettings(second, { groupActivity: "QUIET", companionInteraction: "NONE" });
  assert.deepEqual(quiet.data, { groupActivity: "QUIET", companionInteraction: "NONE", model: null, revision: 2 });
  assert.equal((await call(0, `companions/${second}/chat-settings`, "PUT", { groupActivity: "ACTIVE", companionInteraction: "NONE", model: null, revision: 1 })).status, 409);
  assert.equal((await call(0, `companions/${second}/chat-settings`, "PUT", { groupActivity: "LOUD", companionInteraction: "NONE", model: null, revision: 2 })).status, 400);
  assert.equal((await call(0, `companions/${second}/chat-settings`, "PUT", { groupActivity: "ACTIVE", companionInteraction: "NONE", model: "not-in-catalog", revision: 2 })).status, 400);
  await putSettings(A.companion, { groupActivity: "ACTIVE", companionInteraction: "NONE" });
  const say = async (body: string, mentions?: string[]) => {
    await call(0, `chats/${group.data.id}/messages`, "POST", { body, ...(mentions ? { mentions } : {}) });
    return turns(await settle(group.data.id));
  };
  assert.match(await say("谁在？"), /OA$/, "ACTIVE answers everything, QUIET stays quiet");
  assert.match(await say("@Second 你说", [second]), /OS$/, "an @mention must be answered, even when QUIET");
  await putSettings(A.companion, { groupActivity: "NORMAL" });
  assert.match(await say("今天天气不错"), /SO$/, "NORMAL lets it stay quiet when the message does not concern it");
  assert.match(await say("SampleCompanion 你觉得呢"), /OA$/, "NORMAL answers when it concerns it");
  // Chatter already written but not yet shown is dropped when the Owner speaks.
  const unshown = (await pool.query<{ id: string }>(`insert into companion_private.chat_messages(chat_id, companion_id, body, status,
      reply_to, optional, typing_at, shown_at) values ($1, $2, '还没显示的接话', 'SENT', 'COMPANION', true, now(), now() + interval '1 hour')
    returning id`, [group.data.id, second])).rows[0]!.id;
  assert.match(await say("停一下"), /O$/);
  assert.equal((await pool.query("select 1 from companion_private.chat_messages where id = $1", [unshown])).rowCount, 0);
  passed("settings: group activity QUIET / NORMAL / ACTIVE, @mentions, interaction NONE, revision conflicts");

  // A deciding (optional) turn first in line hides the dots of whoever is behind it.
  await putSettings(second, { groupActivity: "ACTIVE" });
  const queued = await portA.send(group.data.id, "SampleCompanion 和 Second 都在吗", [], keyHash()) as ChatSendResult;
  await pause(PACE * 3 * 1000 + 30); // past every reading delay
  const waiting = (await portA.read(group.data.id, null, null) as ChatPage).chat;
  assert.deepEqual([queued.replying, waiting.typing, waiting.replying], [true, [], true], "A (optional) is first in line: no dots for S yet");
  await new ChatReplies(devChatModel).drain(group.data.id, portA);
  assert.match(turns(await settle(group.data.id)), /OAS$/);
  // A turn skipped because its Companion left still lets the others answer what was said.
  await putSettings(A.companion, { groupActivity: "ACTIVE", companionInteraction: "RARE" });
  await putSettings(second, { groupActivity: "ACTIVE", companionInteraction: "RARE" });
  await portA.send(group.data.id, "你们俩聊聊", [], keyHash());
  const firstTurn = await portA.claim(group.data.id);
  assert.equal(firstTurn!.companion.companionId, A.companion);
  await portA.finish(firstTurn!.replyId, firstTurn!.claimId, "SENT", ["我先说"]);
  await pool.query("update public.companions set status = 'QUARANTINED' where id = $1", [second]);
  assert.equal(await portA.claim(group.data.id), null, "S is skipped and nobody else is left to answer");
  await pool.query("update public.companions set status = 'ACTIVE' where id = $1", [second]);
  const skipped = await pool.query<{ status: string; failure: string }>(`select status, failure from companion_private.chat_messages
    where chat_id = $1 and companion_id = $2 order by created_at desc limit 1`, [group.data.id, second]);
  assert.deepEqual(skipped.rows[0], { status: "FAILED", failure: "UNAVAILABLE" });
  // Back to what the next groups expect: A answers when it concerns it, S only when @mentioned, no chatter.
  await putSettings(A.companion, { groupActivity: "NORMAL", companionInteraction: "NONE" });
  await putSettings(second, { groupActivity: "QUIET", companionInteraction: "NONE" });
  passed("dots only for the turn next in line; a skipped turn ends cleanly");

  // Failures, retries and the safety scan, driven directly with different models.
  const fresh = (await call<Chat>(0, "chats", "POST", { companionIds: [second, A.companion] }, "group-key-0000000002")).data;
  const sendTo = (text: string) => portA.send(fresh.id, text, [second], keyHash());
  const latest = async (): Promise<ChatPage> => {
    for (;;) {
      const read = await portA.read(fresh.id, null, null) as ChatPage;
      if (!read.chat.replying) return read;
      await pause(20);
    }
  };
  await sendTo("会失败的一句");
  assert.equal(await new ChatReplies({ reply: async () => { throw new Error("model down"); } }).drain(fresh.id, portA), 1);
  let read = await latest();
  const failed = read.items[0]!;
  assert.deepEqual([failed.status, failed.failure, failed.retryable, failed.body], ["FAILED", "ERROR", true, null]);
  assert.deepEqual(await portA.retry(fresh.id, failed.id), { typing: [], replying: true });
  await new ChatReplies(devChatModel).drain(fresh.id, portA);
  read = await latest();
  assert.deepEqual(read.items.slice(0, 2).map(m => [m.status, m.body]),
    [["SENT", "收到：「会失败的一句」"], ["SENT", "（开发环境假回复）我是SecondCompanion"]]);
  assert.equal(read.items[1]!.id, failed.id);
  await sendTo("这次没有模型");
  await new ChatReplies().drain(fresh.id, portA);
  read = await latest();
  assert.deepEqual([read.items[0]!.failure, read.items[0]!.retryable], ["UNAVAILABLE", false]);
  await assert.rejects(portA.retry(fresh.id, read.items[0]!.id), { code: "INVALID_STATE" });
  await sendTo("说个秘密");
  await new ChatReplies({ reply: async () => ({ messages: ["好", "password: hunter2"] }) }).drain(fresh.id, portA);
  read = await latest();
  assert.deepEqual([read.items[0]!.status, read.items[0]!.body, read.items[0]!.retryable, read.items[1]!.body],
    ["BLOCKED", null, false, "说个秘密"]);
  passed("a failed reply can be retried; no model means UNAVAILABLE; the safety scan blocks the whole reply");

  await sendTo("抢一下");
  const claim = await portA.claim(fresh.id);
  assert.ok(claim);
  assert.deepEqual([claim.companion.displayName, claim.optional, claim.direct, claim.replyTo], ["SecondCompanion", false, false, "OWNER"]);
  assert.deepEqual(claim.companion.identity, { persona: "calm" });
  assert.deepEqual({ ...claim.companion.settings, revision: 0 }, { groupActivity: "QUIET", companionInteraction: "NONE", model: null, revision: 0 });
  assert.equal(claim.history.at(-1)!.body, "抢一下");
  assert.equal(await portA.claim(fresh.id), null);
  assert.equal(await portA.finish(claim.replyId, randomUUID(), "SENT", ["冒名"]), false);
  await assert.rejects(portA.finish(claim.replyId, claim.claimId, "PASSED", null), { code: "INVALID_INPUT" });
  await assert.rejects(portA.finish(claim.replyId, claim.claimId, "SENT", ["1", "2", "3", "4"]), { code: "INVALID_INPUT" });
  await assert.rejects(portA.finish(claim.replyId, claim.claimId, "SENT", [" "]), { code: "INVALID_INPUT" });
  assert.equal(await portA.finish(claim.replyId, claim.claimId, "SENT", ["我在"]), true);
  assert.equal(await portA.finish(claim.replyId, claim.claimId, "SENT", ["又一次"]), false);
  const portB = new PostgresChatAdapter(new PgOwnerExecutor(pool, B.subject));
  await assert.rejects(portB.claim(fresh.id), { code: "NOT_FOUND" });
  const doomed = (await portA.open([A.companion, second], null, keyHash())) as Chat;
  await portA.send(doomed.id, "马上删掉", [second], keyHash());
  const orphan = await portA.claim(doomed.id);
  await portA.remove(doomed.id);
  assert.equal(await portA.finish(orphan!.replyId, orphan!.claimId, "SENT", ["来晚了"]), false, "the chat was deleted meanwhile");
  // A list that does not start at 1, sent straight to the database, is read as a plain list.
  const odd = await new PgOwnerExecutor(pool, A.subject).query<{ payload: Chat }>(
    "select public.chat_open($1::uuid[], null, $2) as payload", [`[2:2]={${A.companion}}`, keyHash()]);
  assert.deepEqual([odd.rows[0]!.payload.id, odd.rows[0]!.payload.direct], [direct.data.id, true]);
  passed("one reply at a time per chat; stale, foreign, malformed or orphaned finishes cannot write; odd arrays are normalised");

  // ---- platform models through the real ledger: booking, switches, quota, abandoned calls ----
  const ledgerChat = (await call<Chat>(0, "chats", "POST", { companionIds: [second, A.companion] }, "group-key-ledger-001")).data;
  const ask = async (text: string) => { await portA.send(ledgerChat.id, text, [second], keyHash()); return (await portA.claim(ledgerChat.id))!; };
  const book = (t: ChatClaim, model = "m-test") => portA.reserve({ replyId: t.replyId, claimId: t.claimId, purpose: "REPLY",
    provider: "test-provider", model, pricingVersion: "test/1", inputTokens: 100, outputTokens: 50, costMinor: 1, traceId: "chat-ledger" });
  const ledger = async (tx: string) => (await pool.query<{ s: string; outcome: string | null }>(`select string_agg(status, '>' order by sequence) as s,
      max(outcome_code) as outcome from public.compute_ledger_entries where transaction_id = $1`, [tx])).rows[0]!;
  const budget = async () => (await pool.query(`select max_model_calls, reserved_calls, settled_calls, settled_input_tokens, currency,
      extract(epoch from period_end - period_start)::int as seconds from public.compute_budgets where companion_id = $1`, [second])).rows;
  const lastFailure = async () => ((await latestOf(ledgerChat.id)).items[0]!).failure;
  const latestOf = async (chatId: string): Promise<ChatPage> => {
    for (;;) {
      const read = await portA.read(chatId, null, null) as ChatPage;
      if (!read.chat.replying) return read;
      await pause(20);
    }
  };

  let t = await ask("记账测试");
  const booked = await book(t);
  assert.equal(booked.decision, "RESERVED");
  const tx = (booked as { transactionId: string }).transactionId;
  assert.equal((await ledger(tx)).s, "RESERVED>STARTED");
  assert.deepEqual(await budget(), [{ max_model_calls: 200, reserved_calls: 1, settled_calls: 0, settled_input_tokens: "0", currency: "USD", seconds: 86400 }],
    "a free daily budget is created on first use");
  await portA.settle(tx, 80, 20, 1, true);
  assert.equal((await ledger(tx)).s, "RESERVED>STARTED>SUCCEEDED");
  assert.deepEqual((await budget()).map(b => [b.reserved_calls, b.settled_calls, b.settled_input_tokens]), [[0, 1, "80"]]);
  assert.equal(await portA.finish(t.replyId, t.claimId, "SENT", ["记好了"]), true);
  await assert.rejects(new PostgresChatAdapter(new PgOwnerExecutor(pool, B.subject)).settle(tx, 1, 1, 1, true), { code: "NOT_FOUND" });

  const switchModel = (scope: string, key: string, on: boolean) =>
    pool.query("select companion_admin.model_switch_set($1, $2, $3, 'chat test')", [scope, key, on]);
  const pair = [{ provider: "test-provider", model: "m-test" }, { provider: "test-provider", model: "m-other" }, { provider: "elsewhere", model: "m" }];
  await switchModel("MODEL", "test-provider/m-test", false);
  assert.deepEqual(await portA.modelsEnabled(pair), [false, true, true]);
  await switchModel("PROVIDER", "test-provider", false);
  assert.deepEqual(await portA.modelsEnabled(pair), [false, false, true]);
  await switchModel("ALL", "*", false);
  assert.deepEqual(await portA.modelsEnabled(pair), [false, false, false]);
  t = await ask("关掉了吗");
  assert.deepEqual(await book(t, "m-other"), { decision: "DISABLED" });
  await portA.finish(t.replyId, t.claimId, "DISABLED", null);
  assert.equal(await lastFailure(), "DISABLED");
  for (const [scope, key] of [["ALL", "*"], ["PROVIDER", "test-provider"], ["MODEL", "test-provider/m-test"]] as const) await switchModel(scope, key, true);
  assert.deepEqual(await portA.modelsEnabled(pair), [true, true, true]);
  assert.equal((await pool.query("select count(*)::int as n from companion_private.admin_log where action = 'MODEL_SWITCH' and reason = 'chat test'")).rows[0]!.n, 6);

  await pool.query("update public.compute_budgets set max_model_calls = settled_calls where companion_id = $1", [second]);
  t = await ask("额度用完");
  assert.deepEqual(await book(t), { decision: "QUOTA", reason: "BUDGET_EXHAUSTED" });
  await portA.finish(t.replyId, t.claimId, "QUOTA", null);
  assert.equal(await lastFailure(), "QUOTA");
  await pool.query("update public.compute_budgets set max_model_calls = 200 where companion_id = $1", [second]);

  t = await ask("服务器中途停了");
  const lost = (await book(t)) as { transactionId: string };
  await pool.query("update companion_private.chat_messages set claimed_at = now() - interval '3 minutes' where id = $1", [t.replyId]);
  const retaken = (await portA.claim(ledgerChat.id))!;
  assert.equal(retaken.replyId, t.replyId);
  assert.deepEqual(await ledger(lost.transactionId), { s: "RESERVED>STARTED>FAILED", outcome: "CHAT_ABANDONED" }, "charged the whole reservation");
  assert.deepEqual(await book(t), { decision: "STALE" }, "the old claim can no longer book");
  await portA.settle(lost.transactionId, 5, 5, 0, true); // the slow server reports in late: ignored, not an error
  assert.equal((await ledger(lost.transactionId)).s, "RESERVED>STARTED>FAILED");
  await portA.finish(retaken.replyId, retaken.claimId, "SENT", ["接上了"]);

  // Turns deleted while their model call runs close the call: a new Owner message, and deleting the chat.
  await pool.query(`insert into companion_private.chat_messages(chat_id, companion_id, status, reply_to, optional)
    values ($1, $2, 'PENDING', 'COMPANION', true)`, [ledgerChat.id, second]);
  const chatter = (await portA.claim(ledgerChat.id))!;
  const chatterCall = (await book(chatter)) as { transactionId: string };
  await portA.send(ledgerChat.id, "别聊了", [], keyHash());
  assert.deepEqual(await ledger(chatterCall.transactionId), { s: "RESERVED>STARTED>FAILED", outcome: "CHAT_ABANDONED" });
  const doomedChat = (await portA.open([second, A.companion], null, keyHash())) as Chat;
  await portA.send(doomedChat.id, "删掉前", [second], keyHash());
  const doomedTurn = (await portA.claim(doomedChat.id))!;
  const doomedCall = (await book(doomedTurn)) as { transactionId: string };
  await portA.remove(doomedChat.id);
  assert.deepEqual(await ledger(doomedCall.transactionId), { s: "RESERVED>STARTED>FAILED", outcome: "CHAT_ABANDONED" });
  await new ChatReplies().drain(ledgerChat.id, portA); // let anything queued by "别聊了" finish

  const catalog = new ChatCatalog({ defaultModel: "fake", decisionModel: null, providers: { fakep: { kind: "anthropic", apiKeyEnv: "FAKE_KEY" } },
    models: [{ id: "fake", name: "Fake", provider: "fakep", model: "fake-1", tier: "ECONOMY", inputPerMTok: 1, outputPerMTok: 1, enabled: true }] }, { FAKE_KEY: "k" });
  const engine = new PlatformChatModel(catalog, async () => ({ text: "真模型的回复\n第二条", inputTokens: 300, outputTokens: 12, refused: false, cutOff: false }));
  await portA.send(ledgerChat.id, "端到端", [second], keyHash());
  await new ChatReplies(engine).drain(ledgerChat.id, portA);
  assert.deepEqual((await latestOf(ledgerChat.id)).items.slice(0, 2).map(m => m.body), ["第二条", "真模型的回复"]);
  const spent = await pool.query(`select e.status, e.input_tokens, e.output_tokens from public.compute_transactions x
      join public.compute_ledger_entries e on e.transaction_id = x.id
    where x.companion_id = $1 and x.provider_id = 'fakep' and e.entry_type = 'SETTLEMENT'`, [second]);
  assert.deepEqual(spent.rows, [{ status: "SUCCEEDED", input_tokens: "300", output_tokens: "12" }]);
  passed("platform models: a daily budget, booking and settling, kill switches, quota, abandoned and orphaned calls, end to end");

  const actions = `companions/${A.companion}/actions`;
  const pat = await call<CompanionActionResult>(0, actions, "POST", { action: "PAT_HEAD" }, "action-key-000000001");
  assert.equal(pat.status, 201, JSON.stringify(pat.data));
  assert.equal(pat.data.chatId, direct.data.id, "kept in the one-to-one chat");
  assert.deepEqual([pat.data.message.action, pat.data.message.body, pat.data.message.companionId, pat.data.typing, pat.data.replying],
    ["PAT_HEAD", null, null, [], true], "an optional turn shows no typing while it decides");
  page = await settle(direct.data.id);
  assert.deepEqual(page.items.slice(0, 2).map(m => [m.action, m.body]),
    [[null, "（开发环境假回复）SampleCompanion知道你在小家里摸了摸你的头"], ["PAT_HEAD", null]], "the Companion saw the action");
  assert.equal(page.chat.lastMessage?.action, null);
  const replayed = await call<CompanionActionResult>(0, actions, "POST", { action: "PAT_HEAD" }, "action-key-000000001");
  assert.equal(replayed.data.message.id, pat.data.message.id);
  assert.equal((await call(0, actions, "POST", { action: "HUG" }, "action-key-000000001")).status, 409);
  assert.equal((await call(0, `chats/${direct.data.id}/messages`, "POST", { body: "hi" }, "action-key-000000001")).status, 409);
  const hug = await call<CompanionActionResult>(0, actions, "POST", { action: "HUG" });
  assert.deepEqual([hug.status, hug.data.message.action, hug.data.replying], [201, "HUG", false], "a burst gets one reply");
  await pool.query("update companion_private.chat_messages set created_at = created_at - interval '4 minutes' where chat_id = $1", [direct.data.id]);
  const wave = await call<CompanionActionResult>(0, actions, "POST", { action: "WAVE" });
  assert.equal(wave.data.replying, true, "3 minutes later it may answer again");
  assert.equal((await settle(direct.data.id)).items[0]!.body, "（开发环境假回复）SampleCompanion知道你在小家里向你挥了挥手");
  assert.equal((await call(0, actions, "POST", { action: "KISS" })).status, 400);
  assert.equal((await call(1, actions, "POST", { action: "WAVE" })).status, 404, "only the Owner's own Companion");
  const secondChat = (await call<Chat>(0, "chats", "POST", { companionIds: [second] })).data;
  assert.equal((await call<CompanionActionResult>(0, `companions/${second}/actions`, "POST", { action: "WAVE" })).data.chatId, secondChat.id);
  await settle(secondChat.id);
  // Thirty quick taps: the Companion still sees the conversation, and only the last tap of the burst.
  for (let i = 0; i < 30; i += 1) await call(0, `companions/${second}/actions`, "POST", { action: i === 29 ? "CUDDLE" : "HUG" });
  await pool.query(`insert into companion_private.chat_messages(chat_id, companion_id, status, reply_to, optional)
    values ($1, $2, 'PENDING', 'OWNER', true)`, [secondChat.id, second]);
  const tapped = (await portA.claim(secondChat.id))!;
  assert.deepEqual(tapped.history.map(h => h.action ?? h.body), ["WAVE", "（开发环境假回复）SecondCompanion知道你在小家里向你挥了挥手", "CUDDLE"]);
  await portA.finish(tapped.replyId, tapped.claimId, "PASSED", null);
  passed("home-room actions: kept in the one-to-one chat, seen by the Companion, one reply per burst");

  const pageChat = (await call<Chat>(0, "chats", "POST", { companionIds: [A.companion, second] }, "group-key-0000000003")).data;
  await pool.query(`insert into companion_private.chat_messages(chat_id, body, status, key_hash, shown_at)
    select $1, 'message ' || n, 'SENT', encode(public.digest('k' || n, 'sha256'), 'hex'), now() - (40 - n) * interval '1 second'
    from generate_series(1, 35) n`, [pageChat.id]);
  const firstPage = await call<ChatPage>(0, `chats/${pageChat.id}`);
  assert.equal(firstPage.data.items.length, 30);
  assert.equal(firstPage.data.items[0]!.body, "message 35");
  assert.match(firstPage.data.nextCursor!, /^\d{4}-\d\d-\d\dT[\d:.]+Z\|/, "UTC, so it survives an unencoded query string");
  const older = await call<ChatPage>(0, `chats/${pageChat.id}?cursor=${firstPage.data.nextCursor!}`);
  assert.deepEqual(older.data.items.map(m => m.body), ["message 5", "message 4", "message 3", "message 2", "message 1"]);
  assert.equal(older.data.nextCursor, null);
  passed("messages page newest first with a cursor");

  const list = await call<{ items: Chat[] }>(0, "chats");
  assert.equal(list.data.items.length, 6);
  assert.equal(list.data.items[0]!.id, pageChat.id); // most recently active first
  assert.equal((await call<{ items: Chat[] }>(1, "chats")).data.items.length, 0);
  assert.equal((await call(1, `chats/${group.data.id}`, "DELETE")).status, 404);
  assert.deepEqual((await call(0, `chats/${group.data.id}`, "DELETE")).data, { deleted: true });
  assert.equal((await call(0, `chats/${group.data.id}`)).status, 404);
  const leftovers = await pool.query("select count(*)::int as n from companion_private.chat_messages where chat_id = $1", [group.data.id]);
  assert.equal(leftovers.rows[0]!.n, 0);
  passed("chat list per Owner; deleting a chat removes every message");

  // Leave the shared development database as other suites expect it.
  await pool.query("delete from companion_private.chats where owner_id = $1", [A.owner]);
  await pool.query("delete from companion_private.chat_settings");
  await pool.query("update public.companions set status = 'DELETED' where id = $1", [second]);
  await pool.query("do $$ begin execute format('alter database %I reset companion.chat_pace', current_database()); end $$");
  console.log(`Chat integration passed (${groups} groups).`);
} finally {
  await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
  await pool.end();
}
