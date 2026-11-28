import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { PoolClient } from "pg";
import { createMobileDevHttpServer } from "../src/dev/mobile-http-server.ts";
import { createPgPool, PgOwnerExecutor } from "../src/persistence/postgres/index.ts";
import { PostgresChatAdapter } from "../src/chat/postgres.ts";
import { ChatReplies, ConnectionFailed, devChatModel } from "../src/chat/replies.ts";
import { ChatCatalog } from "../src/chat/models.ts";
import { PlatformChatModel } from "../src/chat/platform.ts";
import { BackgroundScheduler } from "../src/chat/background-scheduler.ts";
import type { ChatClaim, DiaryJob, MemoryJob } from "../src/chat/port.ts";
import type { AccountExport, Chat, ChatPage, ChatSendResult, ChatSettings, CompanionActionResult, CompanionSkills, DiaryPage, DiarySettings, DiaryWriteResult, VoiceList }
  from "../../contracts/chat.ts";

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
    [true, null, [{ companionId: A.companion, displayName: "SampleCompanion", avatar: null }], false]);
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

  // ---- group chats are paused at launch (feature switches, migration 0050) ----
  const setFeature = (key: string, on: boolean) => pool.query("update companion_private.feature_switches set enabled = $2 where key = $1", [key, on]);
  assert.deepEqual((await call(0, "features")).data, { groupChatCreate: false, groupChatSend: false, voiceInput: true, companionReach: true, connections: false });
  assert.equal((await call(0, "chats", "POST", { companionIds: [A.companion, second] }, "group-key-paused-001")).status, 409);
  assert.equal((await call(0, "chats", "POST", { companionIds: [A.companion] })).status, 200, "one-to-one chats are not paused");
  await setFeature("GROUP_CHAT_CREATE", true);
  const paused = (await call<Chat>(0, "chats", "POST", { companionIds: [A.companion, second] }, "group-key-paused-002")).data;
  assert.equal((await call(0, `chats/${paused.id}/messages`, "POST", { body: "有人吗" })).status, 409);
  assert.equal((await call(0, `chats/${paused.id}`)).status, 200, "a paused group can still be read");
  assert.equal((await call(0, `chats/${direct.data.id}/messages`, "POST", { body: "单聊照常" })).status, 201);
  await settle(direct.data.id);
  await setFeature("GROUP_CHAT_SEND", true);
  assert.equal((await call(0, `chats/${paused.id}/messages`, "POST", { body: "有人吗" })).status, 201);
  await settle(paused.id);
  assert.equal((await call(0, `chats/${paused.id}`, "DELETE")).status, 200);
  assert.deepEqual((await call(0, "features")).data, { groupChatCreate: true, groupChatSend: true, voiceInput: true, companionReach: true, connections: false });
  passed("group chats paused by switch: no new group, no sending in an old one; one-to-one chats unaffected");

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

  assert.deepEqual((await call<ChatSettings>(0, `companions/${second}/chat-settings`)).data, { groupActivity: "NORMAL", companionInteraction: "NORMAL", model: null, voice: null, preferredUserTitle: null, autoMemory: "SOMETIMES", proactive: "OFF", replyRules: [], revision: 1 });
  assert.equal((await call(1, `companions/${second}/chat-settings`)).status, 404);
  const quiet = await putSettings(second, { groupActivity: "QUIET", companionInteraction: "NONE" });
  assert.deepEqual(quiet.data, { groupActivity: "QUIET", companionInteraction: "NONE", model: null, voice: null, preferredUserTitle: null, autoMemory: "SOMETIMES", proactive: "OFF", replyRules: [], revision: 2 });
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
  assert.deepEqual([failed.status, failed.failure, failed.retryable, failed.body, failed.connectionFailure], ["FAILED", "ERROR", true, null, null]);
  assert.deepEqual(await portA.retry(fresh.id, failed.id), { typing: [], recording: [], replying: true });
  // The Owner's own key or agent gave no usable answer: the failed reply says so, for its Owner alone, until it is tried again.
  assert.equal(await new ChatReplies({ reply: async () => { throw new ConnectionFailed("NO_BALANCE"); } }).drain(fresh.id, portA), 1);
  assert.deepEqual([(await latest()).items[0]!.id, (await latest()).items[0]!.failure, (await latest()).items[0]!.connectionFailure], [failed.id, "ERROR", "NO_BALANCE"]);
  assert.deepEqual([await new PostgresChatAdapter(new PgOwnerExecutor(pool, B.subject)).failNote(failed.id, "AUTH_FAILED"), (await latest()).items[0]!.connectionFailure],
    [{ noted: false }, "NO_BALANCE"], "not another Owner's reply");
  await assert.rejects(portA.failNote(failed.id, "BROKE" as "ERROR"), { code: "INVALID_INPUT" });
  assert.deepEqual(await portA.retry(fresh.id, failed.id), { typing: [], recording: [], replying: true });
  assert.equal((await pool.query("select failure_detail from companion_private.chat_messages where id = $1", [failed.id])).rows[0]!.failure_detail, null,
    "a retry starts clean");
  await new ChatReplies(devChatModel).drain(fresh.id, portA);
  read = await latest();
  assert.deepEqual([await portA.failNote(failed.id, "AUTH_FAILED"), read.items[1]!.connectionFailure], [{ noted: false }, null], "nothing to note on a reply that was sent");
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

  // What the Companion calls the Owner: saved trimmed, kept by an app that does not send it, cleared by an empty one.
  assert.equal((await putSettings(second, { preferredUserTitle: "字".repeat(21) })).status, 400);
  assert.equal((await putSettings(second, { preferredUserTitle: "" })).data.preferredUserTitle, null);
  assert.equal((await putSettings(second, { preferredUserTitle: " 阿澈 " })).data.preferredUserTitle, "阿澈");
  const { preferredUserTitle: _title, ...withoutTitle } = (await call<ChatSettings>(0, `companions/${second}/chat-settings`)).data;
  assert.equal((await call<ChatSettings>(0, `companions/${second}/chat-settings`, "PUT", withoutTitle)).data.preferredUserTitle, "阿澈", "an app that does not send it keeps it");
  assert.equal((await putSettings(second, { preferredUserTitle: null })).data.preferredUserTitle, null);
  assert.equal((await putSettings(second, { preferredUserTitle: "阿澈" })).data.preferredUserTitle, "阿澈");
  await sendTo("抢一下");
  const claim = await portA.claim(fresh.id);
  assert.ok(claim);
  assert.deepEqual([claim.timeZone, claim.ownerName], ["Asia/Shanghai", "阿澈"], "no community settings: the default zone; the chosen title");
  assert.deepEqual([claim.companion.displayName, claim.optional, claim.direct, claim.replyTo], ["SecondCompanion", false, false, "OWNER"]);
  assert.deepEqual(claim.companion.identity, { persona: "calm" });
  assert.deepEqual({ ...claim.companion.settings, revision: 0 }, { groupActivity: "QUIET", companionInteraction: "NONE", model: null, voice: null, preferredUserTitle: "阿澈", autoMemory: "SOMETIMES", proactive: "OFF", replyRules: [], revision: 0 });
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

  // A Companion's own action (TA 抱了抱你): only once switched on, only in a one-to-one chat.
  const queueTurn = async (chat: string) => {
    await pool.query(`insert into companion_private.chat_messages(chat_id, companion_id, status, reply_to, optional)
      values ($1, $2, 'PENDING', 'OWNER', true)`, [chat, second]);
    return (await portA.claim(chat))!;
  };
  const shown = async () => (await settle(secondChat.id)).items.slice(0, 2).map(m => [m.companionId, m.action ?? null, m.body]);
  const before = await queueTurn(secondChat.id);
  assert.equal(before.canAct, false, "switched off: the Companion is not told it may act");
  await portA.finish(before.replyId, before.claimId, "PASSED", null);
  await setFeature("COMPANION_ACTIONS", true);
  const hugging = await queueTurn(secondChat.id);
  assert.equal(hugging.canAct, true);
  assert.equal(await portA.finish(hugging.replyId, hugging.claimId, "SENT", ["抱一下"], undefined, "HUG"), true);
  assert.deepEqual(await shown(), [[second, null, "抱一下"], [second, "HUG", null]], "the action first, then what it says");
  const waving = await queueTurn(secondChat.id);
  assert.equal(await portA.finish(waving.replyId, waving.claimId, "SENT", [], undefined, "WAVE"), true);
  assert.deepEqual((await shown())[0], [second, "WAVE", null], "an action with nothing said");
  await assert.rejects(portA.finish((await queueTurn(secondChat.id)).replyId, randomUUID(), "SENT", [], undefined, "KISS" as never));
  await assert.rejects(portA.finish(waving.replyId, waving.claimId, "PASSED", null, undefined, "HUG"), "an action is something sent");
  const leftover = (await pool.query<{ id: string; claim_id: string }>(
    "select id, claim_id from companion_private.chat_messages where chat_id = $1 and status = 'PENDING'", [secondChat.id])).rows[0]!;
  await portA.finish(leftover.id, leftover.claim_id, "PASSED", null);
  // The Owner hugs back: the Companion's own action a moment ago does not use up the Owner's turn.
  await pool.query("update companion_private.chat_messages set created_at = created_at - interval '4 minutes' where chat_id = $1 and companion_id is null", [secondChat.id]);
  assert.equal((await call<CompanionActionResult>(0, `companions/${second}/actions`, "POST", { action: "HUG" })).data.replying, true);
  await settle(secondChat.id);
  const after = await queueTurn(secondChat.id);
  assert.deepEqual(after.history.slice(-5).map(h => [h.companionId === null ? "O" : "S", h.action ?? h.body]),
    [["S", "HUG"], ["S", "抱一下"], ["S", "WAVE"], ["O", "HUG"], ["S", "（开发环境假回复）SecondCompanion知道你在小家里抱了抱你"]],
    "a Companion's own actions are all kept in what it reads");
  await portA.finish(after.replyId, after.claimId, "PASSED", null);
  const inGroup = await queueTurn(fresh.id);
  assert.equal(inGroup.canAct, false, "not in a group chat");
  await assert.rejects(portA.finish(inGroup.replyId, inGroup.claimId, "SENT", ["嗨"], undefined, "HUG"));
  await portA.finish(inGroup.replyId, inGroup.claimId, "PASSED", null);
  await setFeature("COMPANION_ACTIONS", false);
  passed("a Companion's own home-room action: behind its switch, one-to-one only, shown before its words");

  const pageChat = (await call<Chat>(0, "chats", "POST", { companionIds: [A.companion, second] }, "group-key-0000000003")).data;
  await pool.query(`insert into companion_private.chat_messages(chat_id, body, status, key_hash, shown_at)
    select $1, 'message ' || n, 'SENT', encode(sha256(convert_to('k' || n,'UTF8')), 'hex'), now() - (40 - n) * interval '1 second'
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

  // ---- diary (家机日记) ----
  const diary = `companions/${A.companion}/diary`;
  const diarySettings = `companions/${A.companion}/diary-settings`;
  assert.deepEqual((await call<DiarySettings>(0, diarySettings)).data, { frequency: "DAILY", autoWrite: false, revision: 1 });
  for (const [path, method] of [[diarySettings, "GET"], [diary, "GET"], [diary, "POST"]] as const) {
    assert.equal((await call(1, path, method)).status, 404, `${method} ${path} is the Owner's alone`);
  }
  // Community material: the Companion's own post counts; a deleted post and another Companion's post do not.
  const actorOf = async (twin: string, owner: string) => {
    await pool.query("insert into public.community_actors(owner_id, kind, social_twin_id) values ($1, 'AI', $2) on conflict do nothing", [owner, twin]);
    return (await pool.query<{ id: string }>("select id from public.community_actors where social_twin_id = $1", [twin])).rows[0]!.id;
  };
  const [actorA, actorB] = [await actorOf("00000000-0000-0000-0000-0000000005a1", A.owner), await actorOf("00000000-0000-0000-0000-0000000005b1", B.owner)];
  const diaryPosts = (await pool.query<{ id: string }>(`insert into public.community_posts(actor_id, body, source, deleted_at)
    values ($1, '日记测试：我的帖子', 'OWNER_PROXY', null), ($1, '日记测试：删掉的帖子', 'OWNER_PROXY', now()), ($2, '日记测试：别人的帖子', 'OWNER_PROXY', null)
    returning id`, [actorA, actorB])).rows.map(r => r.id);
  // The Owner's time zone comes from the Companion's community settings, the name from the community profile
  // (no title chosen for this Companion). Other suites share these rows, so they are put back afterwards.
  const zoneBefore = (await pool.query<{ time_zone: string }>("select time_zone from companion_private.agent_settings where actor_id = $1", [actorA])).rows[0];
  await pool.query(`insert into companion_private.agent_settings(actor_id, time_zone) values ($1, 'Europe/Paris')
    on conflict (actor_id) do update set time_zone = excluded.time_zone`, [actorA]);
  const nameBefore = (await pool.query<{ display_name: string | null }>("select display_name from public.owners where id = $1", [A.owner])).rows[0]!.display_name;
  const humanBefore = (await pool.query<{ human_display_name: string | null }>(
    "select human_display_name from public.community_actors where owner_id = $1 and kind = 'HUMAN'", [A.owner])).rows[0];
  await pool.query("update public.owners set display_name = '小田' where id = $1", [A.owner]);
  await pool.query("update public.community_actors set human_display_name = null where owner_id = $1 and kind = 'HUMAN'", [A.owner]);
  let seen: DiaryJob | undefined;
  const capturing = new ChatReplies({ reply: async () => ({ pass: true }), diary: async job => { seen = job; return { text: " 今天主人抱了抱我。 " }; } });
  const firstEntry = await capturing.writeDiary(A.companion, portA);
  assert.deepEqual([seen!.timeZone, seen!.ownerName], ["Europe/Paris", "小田"]);
  if (zoneBefore) await pool.query("update companion_private.agent_settings set time_zone = $2 where actor_id = $1", [actorA, zoneBefore.time_zone]);
  else await pool.query("delete from companion_private.agent_settings where actor_id = $1", [actorA]);
  await pool.query("update public.owners set display_name = $2 where id = $1", [A.owner, nameBefore]);
  if (humanBefore) await pool.query("update public.community_actors set human_display_name = $2 where owner_id = $1 and kind = 'HUMAN'", [A.owner, humanBefore.human_display_name]);
  assert.deepEqual([firstEntry.status, firstEntry.entry?.body, firstEntry.entry?.companionId], ["WRITTEN", "今天主人抱了抱我。", A.companion]);
  assert.equal(seen!.companion.displayName, "SampleCompanion");
  assert.ok(seen!.messages.some(m => m.companionId === null && m.body === "你好呀"), "the one-to-one chat");
  assert.ok(seen!.messages.some(m => m.action === "WAVE"), "home-room actions");
  assert.ok(!seen!.messages.some(m => m.body === "记账测试"), "not group chats");
  const postBodies = seen!.posts.map(p => p.body);
  assert.ok(postBodies.includes("日记测试：我的帖子") && !postBodies.some(b => b.includes("删掉") || b.includes("别人")), postBodies.join("|"));
  const again = await call<DiaryWriteResult>(0, diary, "POST");
  assert.equal(again.data.status, "NOT_DUE");
  assert.equal(Date.parse(again.data.nextAt!) - Date.parse(firstEntry.entry!.writtenAt), 20 * 3600 * 1000, "DAILY: 20 hours later");
  passed("diary: written from the one-to-one chat and own posts, then not again until due");

  assert.deepEqual((await call<DiarySettings>(0, diarySettings, "PUT", { frequency: "OFTEN", revision: 1 })).data, { frequency: "OFTEN", autoWrite: false, revision: 2 });
  assert.equal((await call(0, diarySettings, "PUT", { frequency: "RARE", revision: 1 })).status, 409);
  const ago = (what: string) => pool.query(`update companion_private.diary_entries set created_at = created_at - interval '${what}' where companion_id = $1`, [A.companion]);
  await ago("7 hours");
  assert.equal((await call<DiaryWriteResult>(0, diary, "POST")).data.status, "NOTHING_NEW", "nothing happened since");
  await call(0, `chats/${direct.data.id}/messages`, "POST", { body: "今天去爬山了" });
  await settle(direct.data.id);
  const secondEntry = await call<DiaryWriteResult>(0, diary, "POST");
  assert.equal(secondEntry.data.status, "WRITTEN", JSON.stringify(secondEntry.data));
  assert.match(secondEntry.data.entry!.body, /^（开发环境假日记）主人和我说了 1 句话。主人说：「今天去爬山了」$/, "only what is new");
  const diaryPage = await call<DiaryPage>(0, diary);
  assert.deepEqual([diaryPage.data.items.map(e => e.id), diaryPage.data.nextCursor, diaryPage.data.writing],
    [[secondEntry.data.entry!.id, firstEntry.entry!.id], null, false]);
  assert.equal((await call(1, `${diary}/${firstEntry.entry!.id}`, "DELETE")).status, 404);
  assert.deepEqual((await call(0, `${diary}/${firstEntry.entry!.id}`, "DELETE")).data, { deleted: true });
  assert.equal((await call(0, `${diary}/${firstEntry.entry!.id}`, "DELETE")).status, 404);
  assert.deepEqual((await call<DiaryPage>(0, diary)).data.items.map(e => e.id), [secondEntry.data.entry!.id]);
  const erased = await pool.query("select status, body from companion_private.diary_entries where id = $1", [firstEntry.entry!.id]);
  assert.deepEqual(erased.rows, [{ status: "DELETED", body: null }], "the text is gone, the covered days stay covered");
  passed("diary: frequency, nothing new, only new material, paging and deleting");

  await ago("7 hours");
  await pool.query(`insert into companion_private.diary_entries(companion_id, status, covers_from, covers_until, claim_id)
    values ($1, 'WRITING', now(), now(), gen_random_uuid())`, [A.companion]);
  assert.equal((await call<DiaryWriteResult>(0, diary, "POST")).data.status, "WRITING", "one at a time");
  assert.equal((await call<DiaryPage>(0, diary)).data.writing, true);
  await pool.query("update companion_private.diary_entries set created_at = now() - interval '4 minutes' where status = 'WRITING' and companion_id = $1", [A.companion]);
  assert.equal((await call<DiaryWriteResult>(0, diary, "POST")).data.status, "NOT_DUE", "an abandoned attempt counts as failed");
  assert.equal((await pool.query("select count(*)::int as n from companion_private.diary_entries where companion_id = $1 and status = 'FAILED'", [A.companion])).rows[0]!.n, 1);
  assert.equal((await call(0, diarySettings, "PUT", { frequency: "OFF", revision: 2 })).status, 200);
  assert.equal((await call<DiaryWriteResult>(0, diary, "POST")).data.status, "OFF");
  await pool.query(`insert into companion_private.diary_entries(companion_id, status, covers_from, covers_until, claim_id, created_at)
    values ($1, 'WRITING', now(), now(), gen_random_uuid(), now() - interval '4 minutes')`, [A.companion]);
  assert.equal((await call<DiaryWriteResult>(0, diary, "POST")).data.status, "OFF");
  assert.equal((await pool.query("select count(*)::int as n from companion_private.diary_entries where companion_id = $1 and status = 'WRITING'",
    [A.companion])).rows[0]!.n, 0, "an abandoned attempt is closed even with the diary off");
  passed("diary: one attempt at a time, abandoned attempts fail, and OFF writes nothing");

  const diaryEngine = new PlatformChatModel(catalog, async () => ({ text: "今天被抱了很多次。", inputTokens: 200, outputTokens: 30, refused: false, cutOff: false }));
  const paid = await new ChatReplies(diaryEngine).writeDiary(second, portA);
  assert.equal(paid.status, "WRITTEN", JSON.stringify(paid));
  const diaryLedger = await pool.query(`select x.reason_code, x.trigger_event_type, string_agg(e.status, '>' order by e.sequence) as s
    from public.compute_transactions x join public.compute_ledger_entries e on e.transaction_id = x.id
    where x.trigger_event_id = $1 group by 1, 2`, [paid.entry!.id]);
  assert.deepEqual(diaryLedger.rows, [{ reason_code: "DIARY_ENTRY", trigger_event_type: "DIARY_ENTRY", s: "RESERVED>STARTED>SUCCEEDED" }]);
  assert.deepEqual(await portA.diaryReserve(paid.entry!.id, randomUUID(), { provider: "fakep", model: "fake-1", pricingVersion: "t", inputTokens: 1,
    outputTokens: 1, costMinor: 1 }), { decision: "STALE" }, "a finished entry cannot book again");
  passed("diary model calls are booked as DIARY_ENTRY and settled");

  // ---- memories a Companion notes down by itself (自动记忆) ----
  const memories = async () => (await call<{ items: { id: string; body: string; source: string }[] }>(0, `companions/${second}/memories`)).data.items;
  const newNotes = (...bodies: string[]) => bodies.map(body => ({ body, replaces: null }));
  const ownerSays = (n: number) => pool.query(`insert into companion_private.chat_messages(chat_id, body, status, key_hash, shown_at)
    select $1, '记忆测试 ' || g, 'SENT', encode(sha256(convert_to(gen_random_uuid()::text,'UTF8')), 'hex'), clock_timestamp() from generate_series(1, $2::int) g`,
    [secondChat.id, n]);
  const fake = new ChatReplies(devChatModel);
  // On unless the Owner turns it off, at the slow pace: every 50 messages of the Owner; everything said so far counts the first time.
  assert.equal((await call<ChatSettings>(0, `companions/${second}/chat-settings`)).data.autoMemory, "SOMETIMES");
  const soFar = (await pool.query(`select count(*)::int as n from companion_private.chat_messages
    where chat_id = $1 and companion_id is null and body is not null and status = 'SENT' and shown_at is not null`, [secondChat.id])).rows[0].n as number;
  assert.ok(soFar < 49, `the fixture chat is short (${soFar})`);
  await ownerSays(49 - soFar);
  assert.equal((await portA.memoryBegin(second)).status, "NOT_DUE", "49 are not 50");
  await ownerSays(1);
  const fiftieth = await portA.memoryBegin(second);
  assert.equal(fiftieth.status, "WRITE");
  assert.deepEqual(await portA.memoryFinish(second, (fiftieth as MemoryJob).claimId, []), { accepted: true, added: 0, replaced: 0 });
  await putSettings(second, { autoMemory: "OFF" });
  assert.equal(await fake.remember(second, portA), "OFF");
  assert.equal((await putSettings(second, { autoMemory: "LOUD" as never })).status, 400);
  assert.equal((await putSettings(second, { autoMemory: "OFTEN" })).data.autoMemory, "OFTEN");
  const { autoMemory: _auto, ...withoutAuto } = (await call<ChatSettings>(0, `companions/${second}/chat-settings`)).data;
  assert.equal((await call<ChatSettings>(0, `companions/${second}/chat-settings`, "PUT", withoutAuto)).data.autoMemory, "OFTEN", "an app that does not send it keeps it");
  // Everything said so far counts the first time; from then on, every 10 messages of the Owner.
  await ownerSays(10);
  assert.equal(await fake.remember(second, portA), "DONE");
  assert.deepEqual((await memories()).map(m => [m.body, m.source]), [["（开发环境假记忆）主人说过：「记忆测试 10」", "AUTO"]]);
  assert.equal(await fake.remember(second, portA), "NOT_DUE", "nothing new since");
  await ownerSays(9);
  assert.equal(await fake.remember(second, portA), "NOT_DUE", "nine are not ten");
  await ownerSays(1);
  let noted: MemoryJob | undefined;
  const watching = new ChatReplies({ reply: async () => ({ pass: true }), memory: async job => { noted = job; return { memories: newNotes("主人周三生日", "主人怕黑", "第三条") }; } });
  assert.equal(await watching.remember(second, portA), "DONE");
  assert.deepEqual([noted!.messages.length, noted!.messages.at(-1)!.body, noted!.known[0]!.body, noted!.companion.displayName, noted!.timeZone],
    [10, "记忆测试 1", "（开发环境假记忆）主人说过：「记忆测试 10」", "SecondCompanion", "Asia/Shanghai"], "only what was said since, and what it already remembers");
  assert.deepEqual((await memories()).map(m => `${m.source} ${m.body}`).sort(),
    ["AUTO 主人周三生日", "AUTO 主人怕黑", "AUTO （开发环境假记忆）主人说过：「记忆测试 10」"], "two at most");
  assert.deepEqual(noted!.known!.map(m => [m.body, m.source, typeof m.id, Number.isNaN(Date.parse(m.createdAt!))]),
    [["（开发环境假记忆）主人说过：「记忆测试 10」", "AUTO", "string", false]], "and every memory with its id, for the ones that may be replaced");
  // A note takes the place of a memory the Companion noted down itself, never of one the Owner wrote or of another Companion's.
  const ownerWrote = (await call<{ id: string }>(0, `companions/${second}/memories`, "POST", { body: "主人在甲公司上班" })).data.id;
  const elsewhere = (await call<{ id: string }>(0, `companions/${A.companion}/memories`, "POST", { body: "主人的另一位家机记得的事" })).data.id;
  const idOf = async (body: string) => (await memories()).find(m => m.body === body)!.id;
  await ownerSays(10);
  const birthday = await idOf("主人周三生日");
  const replacing = new ChatReplies({ reply: async () => ({ pass: true }), memory: async () => ({ memories: [
    { body: "主人周三过了生日，收到一束花", replaces: birthday }, { body: "主人去了乙公司上班", replaces: ownerWrote }] }) });
  assert.equal(await replacing.remember(second, portA), "DONE");
  assert.deepEqual((await memories()).map(m => `${m.source} ${m.body}`).sort(), ["AUTO 主人去了乙公司上班", "AUTO 主人周三过了生日，收到一束花", "AUTO 主人怕黑",
    "AUTO （开发环境假记忆）主人说过：「记忆测试 10」", "OWNER 主人在甲公司上班"], "its own memory is replaced; the Owner's stays and the sentence is kept as a new one");
  await ownerSays(10);
  const flowers = await idOf("主人周三过了生日，收到一束花");
  const second2 = await portA.memoryBegin(second) as MemoryJob;
  assert.deepEqual(await portA.memoryFinish(second, second2.claimId, [{ body: "主人怕黑", replaces: flowers }, { body: "主人有两位家机", replaces: elsewhere }]),
    { accepted: true, added: 1, replaced: 1 }, "what it already says elsewhere is not stored twice: the outdated memory just goes");
  assert.deepEqual((await memories()).map(m => m.body).sort(), ["主人去了乙公司上班", "主人在甲公司上班", "主人怕黑", "主人有两位家机", "（开发环境假记忆）主人说过：「记忆测试 10」"]);
  assert.equal((await call<{ items: { id: string }[] }>(0, `companions/${A.companion}/memories`)).data.items.some(m => m.id === elsewhere), true, "another Companion's memory is not touched");
  await call(0, `companions/${A.companion}/memories/${elsewhere}`, "DELETE");
  await pool.query("delete from companion_private.companion_memories where companion_id = $1 and body = any($2)", [second, ["主人去了乙公司上班", "主人在甲公司上班", "主人有两位家机"]]);
  await ownerSays(10);
  const uneven = await portA.memoryBegin(second) as MemoryJob;
  await assert.rejects(pool.query("select public.memory_auto_finish($1,$2,$3::text[],$4::uuid[])", [second, uneven.claimId, ["一句"], [null, null]]), "one id per sentence");
  assert.deepEqual(await portA.memoryFinish(second, uneven.claimId, newNotes("主人周三生日")), { accepted: true, added: 1, replaced: 0 });
  await ownerSays(10);
  const same = await portA.memoryBegin(second) as MemoryJob;
  const unchanged = (await memories()).find(m => m.body === "主人周三生日")!.id;
  assert.deepEqual(await portA.memoryFinish(second, same.claimId, [{ body: "主人周三生日", replaces: unchanged }]), { accepted: true, added: 0, replaced: 0 });
  assert.equal(await idOf("主人周三生日"), unchanged, "replacing a memory with its own words changes nothing, not even its date");
  // The same sentence again is not kept twice; a failed attempt waits ten minutes and keeps the messages for the next one.
  await ownerSays(10);
  const before3 = (await memories()).length;
  assert.equal(await new ChatReplies({ reply: async () => ({ pass: true }), memory: async () => ({ memories: newNotes("主人怕黑") }) }).remember(second, portA), "DONE");
  assert.equal((await memories()).length, before3);
  await ownerSays(10);
  assert.equal(await new ChatReplies({ reply: async () => ({ pass: true }) }).remember(second, portA), "FAILED", "no model that takes notes");
  assert.equal(await fake.remember(second, portA), "NOT_DUE", "ten minutes after a failed attempt");
  await pool.query("update companion_private.memory_notes set failed_at = now() - interval '11 minutes' where companion_id = $1", [second]);
  // Booked as MEMORY_CONSOLIDATION on the cheap model, and settled.
  const noteEngine = new PlatformChatModel(catalog, async () => ({ text: "主人养了一只猫", inputTokens: 300, outputTokens: 10, refused: false, cutOff: false }));
  assert.equal(await new ChatReplies(noteEngine).remember(second, portA), "DONE");
  const noteLedger = await pool.query(`select x.reason_code, x.trigger_event_type, string_agg(e.status, '>' order by e.sequence) as s
    from public.compute_transactions x join public.compute_ledger_entries e on e.transaction_id = x.id
    where x.companion_id = $1 and x.trigger_event_type = 'CHAT_MEMORY' group by 1, 2`, [second]);
  assert.deepEqual(noteLedger.rows, [{ reason_code: "MEMORY_CONSOLIDATION", trigger_event_type: "CHAT_MEMORY", s: "RESERVED>STARTED>SUCCEEDED" }]);
  // An attempt left hanging is closed after 3 minutes, and then counts as a failed one.
  await ownerSays(10);
  const hangingJob = await portA.memoryBegin(second);
  assert.equal(hangingJob.status, "WRITE");
  assert.equal((await portA.memoryBegin(second)).status, "WRITING");
  await pool.query("update companion_private.memory_notes set claimed_at = now() - interval '4 minutes' where companion_id = $1", [second]);
  assert.equal((await portA.memoryBegin(second)).status, "NOT_DUE");
  assert.equal((await portA.memoryFinish(second, (hangingJob as MemoryJob).claimId, newNotes("太晚了"))).accepted, false, "the abandoned attempt cannot hand anything in");
  // Turned off while an attempt hangs: the next reply still closes it.
  await pool.query("update companion_private.memory_notes set failed_at = null where companion_id = $1", [second]);
  assert.equal((await portA.memoryBegin(second)).status, "WRITE");
  await putSettings(second, { autoMemory: "OFF" });
  await pool.query("update companion_private.memory_notes set claimed_at = now() - interval '4 minutes' where companion_id = $1", [second]);
  assert.equal((await portA.memoryBegin(second)).status, "OFF");
  assert.equal((await pool.query("select claim_id from companion_private.memory_notes where companion_id = $1", [second])).rows[0].claim_id, null);
  await putSettings(second, { autoMemory: "OFTEN" });
  await assert.rejects(portA.memoryFinish(second, randomUUID(), newNotes("一", "二", "三")));
  // At 200 memories the oldest one it noted itself makes room; the Owner's own are never removed.
  await pool.query("update companion_private.memory_notes set failed_at = null where companion_id = $1", [second]);
  const notedBefore = (await memories()).filter(m => m.source === "AUTO").length;
  await pool.query(`insert into companion_private.companion_memories(companion_id, body, source, key_hash)
    select $1, '主人写的 ' || g, 'OWNER', encode(sha256(convert_to('fill' || g,'UTF8')), 'hex') from generate_series(1, $2::int) g`,
    [second, 200 - (await memories()).length]);
  assert.equal(await new ChatReplies({ reply: async () => ({ pass: true }), memory: async () => ({ memories: newNotes("新的一条") }) }).remember(second, portA), "DONE");
  const full = await memories();
  assert.deepEqual([full.length, full.filter(m => m.source === "AUTO").length, full.some(m => m.body === "新的一条"),
    full.some(m => m.body.startsWith("（开发环境假记忆）"))], [200, notedBefore, true, false], "the oldest AUTO memory made room");
  await pool.query("update companion_private.companion_memories set source = 'OWNER', key_hash = encode(sha256(convert_to(id::text,'UTF8')), 'hex') where companion_id = $1 and source = 'AUTO'", [second]);
  await ownerSays(10);
  assert.equal(await new ChatReplies({ reply: async () => ({ pass: true }), memory: async () => ({ memories: newNotes("放不下的一条") }) }).remember(second, portA), "DONE");
  assert.equal((await memories()).some(m => m.body === "放不下的一条"), false, "full of the Owner's own: nothing is removed, nothing added");
  assert.equal((await call(1, `companions/${second}/memories`)).status, 404);
  await assert.rejects(new PostgresChatAdapter(new PgOwnerExecutor(pool, B.subject)).memoryBegin(second), { code: "NOT_FOUND" });
  await pool.query("delete from companion_private.companion_memories where companion_id = $1", [second]);
  await putSettings(second, { autoMemory: "OFF" });
  passed("memories it notes down by itself: on by default every 50 messages, every 10 when asked, two at most, its own replaced when outdated, booked, 200 kept with the Owner's own never removed");

  // ---- background diaries (autoWrite, migration 0052) ----
  const background = (platform: boolean, written: string[]) => new BackgroundScheduler({
    server: new PgOwnerExecutor(pool, null), portFor: subject => new PostgresChatAdapter(new PgOwnerExecutor(pool, subject)),
    due: "diary_due", what: "diary",
    write: (companionId, port) => { written.push(companionId); return capturing.writeDiary(companionId, port); },
    platform, log: message => { throw new Error(message); } });
  const dueNow = async () => (await new PgOwnerExecutor(pool, null).query<{ payload: { companionId: string; subject: string }[] }>(
    "select public.diary_due(10, true) as payload", [])).rows[0]!.payload;
  const settingsNow = (await call<DiarySettings>(0, diarySettings)).data;
  await pool.query("update companion_private.diary_entries set created_at = created_at - interval '3 days' where companion_id = $1", [A.companion]);
  await call(0, `chats/${direct.data.id}/messages`, "POST", { body: "晚安" });
  await settle(direct.data.id);
  assert.deepEqual(await dueNow(), [], "not opted in: never in the background");
  const auto = await call<DiarySettings>(0, diarySettings, "PUT", { frequency: "DAILY", autoWrite: true, revision: settingsNow.revision });
  assert.deepEqual([auto.data.frequency, auto.data.autoWrite], ["DAILY", true]);
  assert.equal((await call<DiarySettings>(0, diarySettings, "PUT", { frequency: "DAILY", revision: auto.data.revision })).data.autoWrite, true,
    "an app that does not send autoWrite keeps it");
  assert.deepEqual(await dueNow(), [{ companionId: A.companion, subject: A.subject }]);
  const onlyOwnKeys: string[] = [];
  assert.equal(await background(false, onlyOwnKeys).round(), 0, "no platform model: only Companions on their own key or agent");
  const wrote: string[] = [];
  assert.equal(await background(true, wrote).round(), 1);
  assert.deepEqual(wrote, [A.companion]);
  const newest = (await call<DiaryPage>(0, diary)).data.items[0]!;
  assert.equal(newest.body, "今天主人抱了抱我。");
  assert.deepEqual(await dueNow(), [], "written: not due again until the interval passes");
  await pool.query("update companion_private.diary_entries set created_at = created_at - interval '3 days' where companion_id = $1", [A.companion]);
  assert.deepEqual(await dueNow(), [], "due by time, but nothing new happened");
  await call(0, `chats/${direct.data.id}/messages`, "POST", { body: "明天见" });
  await settle(direct.data.id);
  assert.equal((await dueNow()).length, 1);
  await pool.query(`insert into companion_private.diary_entries(companion_id, status, covers_from, covers_until, created_at)
    values ($1, 'FAILED', now(), now(), now() - interval '30 minutes')`, [A.companion]);
  assert.deepEqual(await dueNow(), [], "a background retry waits an hour after a failure");
  const privilege = await pool.query(`select has_function_privilege('authenticated', 'public.diary_due(integer,boolean)', 'EXECUTE') as app,
    has_function_privilege('companion_api', 'public.diary_due(integer,boolean)', 'EXECUTE') as server`);
  assert.deepEqual(privilege.rows[0], { app: false, server: true }, "only the API server asks what is due");
  passed("background diaries: only when opted in and due, through the same lock, waiting longer after failures");
  await pool.query("delete from public.community_posts where id = any($1::uuid[])", [diaryPosts]);

  // Voice messages. Without a speech key the dev host speaks silence (a WAV), so the whole path runs here.
  // The Owner's own voice messages wait behind the operators' switch (the dev seed turns it on).
  await setFeature("VOICE_INPUT", false);
  assert.deepEqual([(await call<VoiceList>(0, "voices")).data.input, (await call<{ voiceInput: boolean }>(0, "features")).data.voiceInput], [false, false]);
  await setFeature("VOICE_INPUT", true);
  assert.deepEqual([(await call<VoiceList>(0, "voices")).data.input, (await call<{ voiceInput: boolean }>(0, "features")).data.voiceInput], [true, true]);
  const voiceList = (await call<VoiceList>(0, "voices")).data;
  assert.equal(voiceList.available, true);
  const voiceId = voiceList.items[0]!.id;
  const auth = { Authorization: "Bearer chat-0" };
  const sample = await fetch(`${bases[0]}/v0/voices/${voiceId}/sample`, { headers: auth });
  assert.deepEqual([sample.status, sample.headers.get("content-type")], [200, "audio/wav"]);
  assert.equal(Buffer.from(await sample.arrayBuffer()).toString("latin1", 0, 4), "RIFF");
  assert.equal((await putSettings(A.companion, { voice: "no-such-voice" })).status, 400);
  assert.equal((await putSettings(A.companion, { voice: voiceId })).data.voice, voiceId);
  const { voice: _dropped, ...withoutVoice } = (await call<ChatSettings>(0, `companions/${A.companion}/chat-settings`)).data;
  assert.equal((await call<ChatSettings>(0, `companions/${A.companion}/chat-settings`, "PUT", withoutVoice)).data.voice, voiceId,
    "an app that does not send voice keeps it");
  const talk = (await call<Chat>(0, "chats", "POST", { companionIds: [A.companion] })).data.id;
  const voiceReply = async (body: string) => {
    assert.equal((await call(0, `chats/${talk}/messages`, "POST", { body })).status, 201);
    const items = (await settle(talk)).items;
    const owner = items.findIndex(m => m.body === body);
    return items.slice(0, owner).reverse(); // this reply's messages, oldest first
  };
  const [spoken, written] = await voiceReply("我回来了");
  assert.deepEqual([spoken!.body, written!.body, written!.audio], ["（开发环境假回复）我是SampleCompanion", "收到：「我回来了」", null]);
  assert.ok(spoken!.audio && spoken!.audio.durationMs > 0, JSON.stringify(spoken));
  const audioUrl = `${bases[0]}/v0/chats/${talk}/messages/${spoken!.id}/audio`;
  const whole = await fetch(audioUrl, { headers: auth });
  const wav = Buffer.from(await whole.arrayBuffer());
  assert.deepEqual([whole.status, whole.headers.get("content-type"), whole.headers.get("accept-ranges"), wav.toString("latin1", 0, 4)],
    [200, "audio/wav", "bytes", "RIFF"]);
  assert.equal(Number(whole.headers.get("content-length")), wav.length);
  const part = await fetch(audioUrl, { headers: { ...auth, Range: "bytes=0-3" } });
  assert.deepEqual([part.status, part.headers.get("content-range"), Buffer.from(await part.arrayBuffer()).toString("latin1")],
    [206, `bytes 0-3/${wav.length}`, "RIFF"]);
  assert.equal((await fetch(`${bases[1]}/v0/chats/${talk}/messages/${spoken!.id}/audio`, { headers: { Authorization: "Bearer chat-1" } })).status, 404,
    "another Owner cannot hear it");
  assert.equal((await fetch(`${bases[0]}/v0/chats/${talk}/messages/${written!.id}/audio`, { headers: auth })).status, 404);
  const listed = (await call<{ items: Chat[] }>(0, "chats")).data.items.find(c => c.id === talk)!;
  assert.deepEqual(listed.recording, []);
  assert.deepEqual(await portA.voiceLeft(), { companion: 59, owner: 100 });
  passed("voice messages: pick a voice, a reply with a voice message, its audio with ranges, only for its Owner");

  await pool.query("update companion_private.chat_quota set daily_voice = 1");
  assert.equal((await portA.voiceLeft()).companion, 0);
  const [capped] = await voiceReply("再说一句");
  assert.deepEqual([capped!.body, capped!.audio], ["（开发环境假回复）我是SampleCompanion", null], "today's voice messages are used up: text");
  await pool.query("update companion_private.chat_quota set daily_voice = 60");
  await pool.query("update companion_private.chat_audio set created_at = now() - interval '31 days'");
  const [renewed] = await voiceReply("还在吗");
  assert.ok(renewed!.audio, "a new voice message");
  const kept = (await call<ChatPage>(0, `chats/${talk}`)).data.items.find(m => m.id === spoken!.id)!;
  assert.deepEqual([kept.body, kept.audio], ["（开发环境假回复）我是SampleCompanion", null], "an expired clip is gone; the text stays");
  await assert.rejects(pool.query("select public.chat_finish(gen_random_uuid(), gen_random_uuid(), 'SENT', array['a'], '[null, null]')"),
    { code: "22023" });
  await assert.rejects(pool.query("select public.chat_finish(gen_random_uuid(), gen_random_uuid(), 'ERROR', null, '[null]')"), { code: "22023" });
  // The Owner's voice message: the dev host "hears" a fixed sentence.
  assert.equal(voiceList.input, true);
  const recording = { audio: Buffer.from("fake m4a").toString("base64"), mime: "audio/mp4", durationMs: 1500 };
  const voiceKey = randomUUID();
  const mine = await call<ChatSendResult>(0, `chats/${talk}/voice`, "POST", recording, voiceKey);
  assert.equal(mine.status, 201, JSON.stringify(mine.data));
  assert.deepEqual([mine.data.message.companionId, mine.data.message.body, mine.data.message.audio, mine.data.replying],
    [null, "（开发环境假转写）这是一条语音", { durationMs: 1500 }, true]);
  assert.equal((await call<ChatSendResult>(0, `chats/${talk}/voice`, "POST", recording, voiceKey)).data.message.id, mine.data.message.id,
    "a retry gets the same message");
  const heardBack = await fetch(`${bases[0]}/v0/chats/${talk}/messages/${mine.data.message.id}/audio`, { headers: auth });
  assert.deepEqual([heardBack.headers.get("content-type"), Buffer.from(await heardBack.arrayBuffer()).toString()], ["audio/mp4", "fake m4a"]);
  assert.equal((await call(1, `chats/${talk}/voice`, "POST", recording)).status, 404, "not into another Owner's chat");
  assert.equal((await call(0, `chats/${talk}/voice`, "POST", { ...recording, mime: "audio/webm" })).status, 400);
  await settle(talk);
  assert.deepEqual(await portA.voiceLeft(), { companion: 58, owner: 99 }, "the Owner's own do not count against the Companions'");
  await portA.send(talk, "听到了吗", [], keyHash());
  const heardTurn = (await portA.claim(talk))!;
  assert.deepEqual([heardTurn.history.find(h => h.companionId === null && h.body === "（开发环境假转写）这是一条语音")?.voice,
    heardTurn.history.at(-1)?.body, heardTurn.history.at(-1)?.voice], [true, "听到了吗", false], "Companions see which messages were spoken");
  assert.ok(heardTurn.history.some(h => h.companionId === A.companion && h.voice), "its own voice messages are marked too");
  assert.equal(await portA.finish(heardTurn.replyId, heardTurn.claimId, "SENT", ["听到了"]), true);
  await pool.query("update companion_private.chat_quota set daily_owner_voice = 1");
  assert.deepEqual((await call(0, `chats/${talk}/voice`, "POST", recording)).data, { code: "VOICE_LIMIT" });
  await assert.rejects(portA.sendVoice(talk, "绕过", { mime: "audio/mp4", durationMs: 1, bytes: Buffer.from("x") }, keyHash()),
    { code: "INVALID_STATE" }, "the database checks the limit too");
  await pool.query("update companion_private.chat_quota set daily_owner_voice = 100");
  passed("voice messages: the Owner sends one, it is recognised, kept with its audio, and Companions see it was spoken");

  await putSettings(A.companion, { voice: null });
  const [plain] = await voiceReply("好的");
  assert.equal(plain!.audio, null, "no voice: text only");
  passed("voice messages: the daily limit, clips expire to text, malformed audio is refused, and no voice means text");

  // ---- 正则替换: the Owner's rules run over what the Companion says ----
  const rules = [{ pattern: "（开发环境假回复）", flags: "g", replacement: "", enabled: true }, { pattern: "收到", flags: "g", replacement: "听到了", enabled: false }];
  assert.deepEqual((await putSettings(A.companion, { replyRules: rules })).data.replyRules, rules);
  const { replyRules: _rules, ...withoutRules } = (await call<ChatSettings>(0, `companions/${A.companion}/chat-settings`)).data;
  assert.deepEqual((await call<ChatSettings>(0, `companions/${A.companion}/chat-settings`, "PUT", withoutRules)).data.replyRules, rules, "an app that does not send them keeps them");
  assert.deepEqual((await voiceReply("规则生效了吗")).map(m => m.body), ["我是SampleCompanion", "收到：「规则生效了吗」"], "the rule that is on, not the one that is off");
  assert.equal((await putSettings(A.companion, { replyRules: [{ pattern: "(" }] })).status, 400, "a pattern that does not compile");
  assert.equal((await putSettings(A.companion, { replyRules: Array.from({ length: 11 }, () => ({ pattern: "a" })) })).status, 400, "ten at most");
  await assert.rejects(pool.query("update companion_private.chat_settings set reply_rules = $1 where companion_id = $2",
    [JSON.stringify(Array.from({ length: 11 }, () => ({ pattern: "a", flags: "g", replacement: "", enabled: true }))), A.companion]), /check constraint/, "the database holds the limit too");
  // A list that does not come through the API server (the function is the app user's to call) is kept
  // within the same limits of size, and whatever is in it never breaks a reply: what is not a rule is passed over.
  const storeDirectly = async (list: unknown) => {
    const now = (await call<ChatSettings>(0, `companions/${A.companion}/chat-settings`)).data;
    const appUser = await pool.connect();
    try {
      await appUser.query("begin");
      await appUser.query("set local role authenticated");
      await appUser.query("select set_config('request.jwt.claim.sub', $1, true)", [A.subject]);
      await appUser.query("select public.chat_update_settings($1, $2, $3, $4, $5, $6, null, null, null, $7)",
        [A.companion, now.groupActivity, now.companionInteraction, now.model, now.voice, now.revision, JSON.stringify(list)]);
      await appUser.query("commit");
    } catch (error) {
      await appUser.query("rollback");
      throw error;
    } finally {
      appUser.release();
    }
  };
  for (const tooMuch of [Array(11).fill(null), [{ pattern: "a".repeat(30_000) }], { pattern: "a" }, "x"]) {
    await assert.rejects(storeDirectly(tooMuch), /check constraint/, JSON.stringify(tooMuch).slice(0, 40));
  }
  await storeDirectly([null, 5, { pattern: "(" }, { pattern: "收到", flags: "g", replacement: "听到了", enabled: true }, { pattern: "听到了", replacement: "$`" }]);
  assert.equal((await voiceReply("乱七八糟的规则")).at(-1)!.body, "听到了：「乱七八糟的规则」", "the one that is a rule runs; the reply is written all the same");
  assert.deepEqual((await putSettings(A.companion, { replyRules: [] })).data.replyRules, []);
  assert.equal((await voiceReply("规则去掉了")).at(0)!.body, "（开发环境假回复）我是SampleCompanion");
  passed("reply rules: kept with the settings, run in order over each message, refused when they cannot be used");

  {
  // ---- 聊天里发图片 (migration 0086). The Storage service is not here: a row in storage.objects stands for an
  // uploaded file, and the rules on that table are the real ones. ----
  const asUser = async <T>(subject: string, run: (c: PoolClient) => Promise<T>): Promise<T> => {
    const c = await pool.connect();
    try {
      await c.query("begin"); await c.query("set local role authenticated");
      await c.query("select set_config('request.jwt.claim.sub',$1,true)", [subject]);
      const result = await run(c);
      await c.query("commit");
      return result;
    } catch (error) { await c.query("rollback"); throw error; } finally { c.release(); }
  };
  const file = (type = "jpg") => `chat/${randomUUID()}.${type}`;
  const upload = (subject: string, name: string) => asUser(subject, c =>
    c.query("insert into storage.objects(bucket_id, name, owner_id) values ('media', $1, $2)", [name, subject]));
  const canRead = (subject: string, name: string) => asUser(subject, async c =>
    (await c.query("select 1 from storage.objects where bucket_id = 'media' and name = $1", [name])).rowCount === 1);
  const remove = (subject: string, name: string) => asUser(subject, async c =>
    (await c.query("delete from storage.objects where bucket_id = 'media' and name = $1", [name])).rowCount);
  const refusedUpload = (e: unknown) => (e as { code?: string }).code === "42501";
  const [noodles, cat, note, theirs, unsent] = [file(), file("png"), file("webp"), file(), file()];
  for (const [subject, name] of [[A.subject, noodles], [A.subject, cat], [A.subject, note], [B.subject, theirs], [A.subject, unsent]] as const) await upload(subject, name);
  for (const bad of ["chat/holiday.jpg", `chat/${randomUUID()}`, `chat/${randomUUID()}.gif`, `chat/${randomUUID()}.JPG`, `chat/mine/${randomUUID()}.jpg`]) {
    await assert.rejects(upload(A.subject, bad), refusedUpload, bad);
  }
  assert.deepEqual([await canRead(A.subject, noodles), await canRead(B.subject, noodles), await canRead(B.subject, theirs)], [true, false, true],
    "a chat picture is read by the Owner who uploaded it and nobody else");

  const pictured = (await call<Chat>(0, "chats", "POST", { companionIds: [A.companion] })).data.id;
  const sent = await call<ChatSendResult>(0, `chats/${pictured}/messages`, "POST", { body: "看我做的面", images: [{ path: noodles, width: 800, height: 600 }, { path: cat }] }, "picture-key-00000001");
  assert.equal(sent.status, 201, JSON.stringify(sent.data));
  assert.deepEqual([sent.data.message.body, sent.data.message.images], ["看我做的面",
    [{ path: noodles, width: 800, height: 600, seen: null }, { path: cat, width: null, height: null, seen: null }]]);
  assert.equal((await call<ChatSendResult>(0, `chats/${pictured}/messages`, "POST", { body: "看我做的面", images: [{ path: noodles, width: 800, height: 600 }, { path: cat }] },
    "picture-key-00000001")).data.message.id, sent.data.message.id, "sent again with the same key: the same message");
  assert.equal((await call(0, `chats/${pictured}/messages`, "POST", { body: "看我做的面", images: [{ path: cat }, { path: noodles }] }, "picture-key-00000001")).status, 409,
    "the same key with other pictures is a conflict");
  await settle(pictured);
  // What may not be sent: a file that is not there, someone else's, one that is on a message already, the same one twice.
  for (const [why, images] of [["not uploaded", [{ path: file() }]], ["another Owner's file", [{ path: theirs }]], ["on a message already", [{ path: noodles }]],
    ["twice", [{ path: note }, { path: note }]]] as const) {
    assert.equal((await call(0, `chats/${pictured}/messages`, "POST", { body: "x", images })).status, 400, why);
  }
  assert.deepEqual([await remove(A.subject, noodles), await remove(A.subject, unsent), await remove(B.subject, unsent)], [0, 1, 0],
    "a picture on a message stays; one that was not sent after all can be deleted, by its Owner");

  // Pictures alone: the body says so. The Companion's turn gets each picture with what is known of it.
  // (Sent through the port from here on: the dev host would answer a message sent over HTTP before this test can.)
  const alone = await portA.send(pictured, "", [], keyHash(), [{ path: note }]) as ChatSendResult;
  assert.deepEqual([alone.message.body, alone.message.images!.length], ["[图片]", 1]);
  const claimed = await portA.claim(pictured) as ChatClaim;
  assert.deepEqual(claimed.history.filter(line => line.images).map(line => [line.body, line.images]), [
    ["看我做的面", [{ path: noodles, description: null, tries: 0 }, { path: cat, description: null, tries: 0 }]],
    ["[图片]", [{ path: note, description: null, tries: 0 }]]]);
  assert.equal(claimed.history.find(line => line.companionId !== null)!.images, null, "a message without pictures has none");
  await portA.finish(claimed.replyId, claimed.claimId, "SENT", ["看到啦"]);
  // What the picture-reading model made of them is kept: for the Owner alone, once, and two failed tries mean it cannot be seen.
  const portB = new PostgresChatAdapter(new PgOwnerExecutor(pool, B.subject));
  assert.deepEqual([await portB.imageSeen(noodles, "别人写的"), await portA.imageSeen(noodles, " 一碗牛肉面 "), await portA.imageSeen(noodles, "再写一遍")],
    [{ noted: false }, { noted: true }, { noted: false }]);
  assert.deepEqual([await portA.imageSeen(cat, null), await portA.imageSeen(cat, null), await portA.imageSeen(file(), "没有这张")], [{ noted: true }, { noted: true }, { noted: false }]);
  await assert.rejects(portA.imageSeen(note, "长".repeat(1001)), { code: "INVALID_INPUT" });
  await assert.rejects(portA.imageSeen(note, "  "), { code: "INVALID_INPUT" });
  const shown = (await settle(pictured)).items.filter(item => item.images!.length > 0).reverse();
  assert.deepEqual(shown.map(item => item.images!.map(i => i.seen)), [[true, false], [null]], "seen, cannot be seen, not looked at yet");
  await settle(pictured);
  await portA.send(pictured, "好看吗", [], keyHash());
  const next = await portA.claim(pictured) as ChatClaim;
  assert.deepEqual(next.history.flatMap(line => line.images ?? []), [{ path: noodles, description: "一碗牛肉面", tries: 1 }, { path: cat, description: null, tries: 2 },
    { path: note, description: null, tries: 0 }]);
  await portA.finish(next.replyId, next.claimId, "SENT", ["好看"]);

  // A whole turn: the picture is fetched as the Owner, described (booked with the turn), kept, and the reply model reads it.
  const read: unknown[] = [];
  const looking = new ChatReplies({
    reply: async (turn, context) => { read.push([turn.history.flatMap(line => line.images ?? []).at(-1), (context.pictures ?? []).map(p => p.path)]); return { messages: ["是便签"] }; },
    see: async job => ({ description: `一张便签（${job.said}）` }),
  });
  await settle(pictured);
  await portA.send(pictured, "这张呢", [], keyHash());
  const fetched: string[] = [];
  assert.equal(await looking.drain(pictured, portA, async path => { fetched.push(path); return { mime: "image/webp", base64: "UklGRg==" }; }), 1);
  assert.deepEqual([fetched, read], [[note], [[{ path: note, description: "一张便签（[图片]）", tries: 1 }, [note]]]],
    "only what is new or recent is fetched: not the one nobody could read, not the ones from further back");
  assert.deepEqual((await settle(pictured)).items.filter(item => item.images!.length > 0).map(item => item.images!.map(i => i.seen)), [[true], [true, false]]);

  // The day's pictures: 30 by default, counted per Owner; past it nothing is sent.
  await pool.query("update companion_private.chat_quota set daily_images = 4");
  const spare = file();
  await upload(A.subject, spare);
  const over = await call<{ code: string }>(0, `chats/${pictured}/messages`, "POST", { images: [{ path: spare }, { path: unsent.replace(/\.jpg$/, ".png") }] });
  assert.equal(over.status, 400, "a file that is not there is refused before anything is counted");
  const extra = file("png");
  await upload(A.subject, extra);
  const full = await call<{ code: string }>(0, `chats/${pictured}/messages`, "POST", { images: [{ path: spare }, { path: extra }] });
  assert.deepEqual([full.status, full.data.code], [429, "IMAGE_LIMIT"]);
  assert.equal((await call(0, `chats/${pictured}/messages`, "POST", { images: [{ path: spare }] })).status, 201, "the fourth of four");
  await settle(pictured);
  await pool.query("update companion_private.chat_quota set daily_images = 30");
  // Uploading has its own brakes: 40 files that are on no message.
  await pool.query(`insert into storage.objects(bucket_id, name, owner_id) select 'media', 'chat/' || gen_random_uuid() || '.jpg', $1 from generate_series(1, 39)`, [A.subject]);
  await assert.rejects(upload(A.subject, file()), refusedUpload, "40 unsent pictures are kept at most");
  assert.equal((await pool.query("delete from storage.objects where bucket_id = 'media' and name like 'chat/%' and owner_id = $1 and not exists(select 1 from companion_private.chat_images i where i.object_name = name)", [A.subject])).rowCount, 40);
  await upload(A.subject, file());
  // When a message goes (its chat or its Companion was deleted), its pictures go off it; the files are then the Owner's to delete.
  assert.equal(await remove(A.subject, note), 0);
  await pool.query("delete from companion_private.chat_messages where id in (select message_id from companion_private.chat_images)");
  assert.deepEqual([(await pool.query("select count(*)::int as n from companion_private.chat_images")).rows[0]!.n, await remove(A.subject, note), await remove(A.subject, noodles)], [0, 1, 1]);
  await pool.query("delete from storage.objects where bucket_id = 'media' and name like 'chat/%'");
  passed("pictures in chat: own uploads only, 1 to 4 with a message, described once for the Companion's turn, a daily limit, read by their Owner alone");
  }

  {
  // ---- 数据导出: everything of the Owner's in one document, and nothing that is not theirs to have ----
  // Planted where it could leak from: another Owner's chat and post, and this Owner's own key and token.
  const theirChat = randomUUID();
  await pool.query("insert into companion_private.chats(id, owner_id, direct_companion_id) values ($1, $2, $3)", [theirChat, B.owner, B.companion]);
  await pool.query(`insert into companion_private.chat_messages(chat_id, body, status, key_hash, shown_at)
    values ($1, '只有另一位主人能看见的话', 'SENT', repeat('b', 64), now())`, [theirChat]);
  await pool.query("insert into public.community_posts(actor_id, body, source) values ($1, '另一位主人的家机发的动态', 'OWNER_PROXY')", [actorB]);
  await pool.query("insert into public.community_posts(actor_id, body, source) values ($1, '导出里要有这条动态', 'OWNER_PROXY')", [actorA]);
  await pool.query("insert into public.community_posts(actor_id, body, source, deleted_at) values ($1, '删掉的动态不在导出里', 'OWNER_PROXY', now())", [actorA]);
  await pool.query(`insert into public.community_comments(post_id, actor_id, body, source)
    select id, $1, '导出里要有这条评论', 'OWNER_PROXY' from public.community_posts where body = '导出里要有这条动态'`, [actorA]);
  await pool.query(`insert into companion_private.companion_connections(companion_id, kind, provider, base_url, model, secret, secret_hint, consented_at)
    values ($1, 'BYOK', 'deepseek', 'https://api.deepseek.com', 'deepseek-flash', 'v1.exportkey.mustnotleak.x', 'leak', now())`, [second]);
  const tokenHash = "e".repeat(64);
  await pool.query(`insert into companion_private.agent_keys(owner_id, companion_id, name, token_hash, scopes, expires_at)
    values ($1, $2, '导出测试', $3, array['COMMUNITY_READ'], now() + interval '30 days')`, [A.owner, A.companion, tokenHash]);
  assert.equal((await call(0, `companions/${A.companion}/memories`, "POST", { body: "导出里要有这条记忆" })).status, 201);
  assert.equal((await call(0, `companions/${A.companion}/world-entries`, "POST", { keys: ["导出"], body: "导出里要有这条设定" })).status, 201);
  assert.equal((await call(0, `companions/${A.companion}/own-skills`, "POST", { title: "导出", body: "导出里要有这个技能" })).status, 201);
  // It follows the other Owner's Companion, whose identity has since been taken out of the community.
  const [twinA, twinB] = ["00000000-0000-0000-0000-0000000005a1", "00000000-0000-0000-0000-0000000005b1"];
  const twinStatus = (await pool.query<{ id: string; status: string }>("select id, status from public.social_twins where id in ($1, $2)", [twinA, twinB])).rows;
  const setTwin = (id: string, status: string) => pool.query("update public.social_twins set status = $2 where id = $1", [id, status]);
  await pool.query("insert into public.community_follows(actor_id, target_id) values ($1, $2)", [actorA, actorB]);
  await setTwin(twinB, "SUSPENDED");
  const official = (await call<CompanionSkills>(0, `companions/${A.companion}/skills`)).data.official[0]!;
  assert.equal((await call(0, `companions/${A.companion}/skills/${official.id}`, "PUT", { enabled: true })).status, 200);

  const exported = await call<AccountExport>(0, "export");
  assert.equal(exported.status, 200, JSON.stringify(exported.data).slice(0, 300));
  const copy = exported.data, text = JSON.stringify(copy);
  assert.deepEqual([copy.format, copy.owner.id, Math.abs(Date.parse(copy.exportedAt) - Date.now()) < 60_000], ["011120-export/1", A.owner, true]);
  const mine = copy.companions.find(c => c.id === A.companion)!, other = copy.companions.find(c => c.id === second)!;
  assert.deepEqual([mine.displayName, mine.status, typeof mine.persona, mine.chatSettings!.replyRules, mine.connection.kind],
    ["SampleCompanion", "ACTIVE", "object", [], "PLATFORM"]);
  assert.ok(mine.memories.some(m => m.body === "导出里要有这条记忆") && mine.worldEntries.some(e => e.body === "导出里要有这条设定")
    && mine.ownSkills.some(s => s.body === "导出里要有这个技能"), "what the Owner wrote for it");
  assert.deepEqual([mine.officialSkills, Object.keys(mine.agentKeys.at(-1)!).sort()],
    [[{ id: official.id, title: official.title, summary: official.summary }], ["active", "companionId", "createdAt", "expiresAt", "id", "lastUsedAt", "name", "scopes"]],
    "an official skill by name, an agent key without what stands for its token");
  assert.deepEqual([copy.sharedSkills, mine.sharedSkills], [[], []], "nothing handed in for the shelf, nothing from it switched on");
  const shown = (await pool.query<{ n: number; voiced: number }>(`select count(*)::int as n, count(a.message_id)::int as voiced
    from companion_private.chat_messages m left join companion_private.chat_audio a on a.message_id = m.id
    where m.chat_id = $1 and m.status = 'SENT'`, [mine.chat!.id])).rows[0]!;
  assert.deepEqual([mine.chat!.messages.length, mine.chat!.messages.filter(m => m.voice).length], [shown.n, shown.voiced], "every message that was shown, voice ones marked");
  assert.ok(shown.n > 5 && shown.voiced > 0 && mine.chat!.messages.some(m => m.companionId === A.companion && m.body === "收到：「规则去掉了」")
    && mine.chat!.messages.some(m => m.companionId === null && m.body === "规则去掉了"));
  assert.ok(mine.chat!.messages.every((m, i, all) => i === 0 || all[i - 1]!.at <= m.at), "oldest first");
  assert.equal(mine.chat!.omitted, 0);
  // Past the budget a chat brings its messages from a moment on and says how many older ones it leaves out.
  const from = mine.chat!.messages.at(-3)!.at, late = mine.chat!.messages.filter(m => m.at >= from).map(m => m.id);
  const newest = (await pool.query<{ payload: { messages: { id: string }[]; omitted: number } }>(
    "select companion_private.export_messages($1, $2::timestamptz) as payload", [mine.chat!.id, from])).rows[0]!.payload;
  assert.deepEqual([newest.messages.map(m => m.id), newest.omitted, late.length < shown.n], [late, shown.n - late.length, true]);
  assert.deepEqual([other.connection.kind, other.connection.keyHint], ["BYOK", "leak"], "how it is connected, with the hint the app shows");
  assert.ok(copy.groupChats.length > 0 && copy.groupChats.every(g => g.members.length >= 2 && Array.isArray(g.messages) && g.omitted === 0));
  const twin = copy.community.find(c => c.profile.id === actorA)!;
  assert.deepEqual(twin.posts.map(p => p.body).filter(body => body.includes("导出") || body.includes("删掉")), ["导出里要有这条动态"]);
  const post = twin.posts.find(p => p.body === "导出里要有这条动态")!, comment = twin.comments.find(c => c.body === "导出里要有这条评论")!;
  assert.deepEqual([Object.keys(post).sort(), Object.keys(comment).sort(), comment.postId, post.media],
    [["body", "createdAt", "id", "media", "source", "visibility"], ["body", "createdAt", "id", "postId", "source"], post.id, []],
    "a post and a comment as the app reads them, less what is about other people or about the reader");
  assert.deepEqual([typeof copy.wallet.enabled, copy.wallet.entriesOmitted, copy.wallet.entries.some(e => "note" in e)], ["boolean", 0, false],
    "the wallet's entries, without the note an operator may have written on one");
  assert.ok(Array.isArray(copy.wallet.entries) && Array.isArray(copy.feedback));
  assert.deepEqual(twin.following, [], "a followed identity the app no longer shows is not in the copy either");
  for (const never of ["只有另一位主人能看见的话", "另一位主人的家机发的动态", "删掉的动态不在导出里", "v1.exportkey.mustnotleak.x", tokenHash, B.owner, B.companion, actorB, "secret\"", "key_hash"]) {
    assert.ok(!text.includes(never), `not in the copy: ${never.slice(0, 24)}`);
  }
  // The other Owner's copy is theirs alone; nobody gets one without signing in.
  const others = JSON.stringify((await call<AccountExport>(1, "export")).data);
  assert.ok(others.includes("只有另一位主人能看见的话") && !others.includes("导出里要有这条记忆") && !others.includes(A.companion));
  assert.equal((await fetch(`${bases[0]}/v0/export`)).status, 401);
  // Back in the community, the followed identity is in the copy as the app shows it; an identity of the Owner's own that is taken out is not.
  await setTwin(twinB, twinStatus.find(t => t.id === twinB)!.status);
  const visible = (await pool.query<{ ok: boolean }>("select companion_private.community_visible($1, $2) as ok", [actorB, actorA])).rows[0]!.ok;
  const laterCopy = (await call<AccountExport>(0, "export")).data;
  assert.equal(laterCopy.community.find(c => c.profile.id === actorA)!.following.some(f => f.id === actorB), visible);
  await setTwin(twinA, "SUSPENDED");
  const third = (await call<AccountExport>(0, "export")).data;
  assert.equal(third.community.some(c => c.profile.id === actorA), false, "the list of identities is the app's own");
  await setTwin(twinA, twinStatus.find(t => t.id === twinA)!.status);
  // One at a time: while one is being built, another is refused at once, and does not count.
  const busy = await pool.connect();
  try {
    await busy.query("select pg_advisory_lock(hashtextextended('account_export:' || $1::text, 0))", [A.owner]);
    assert.deepEqual((await call<{ code: string }>(0, "export")).data, { code: "EXPORT_LIMIT" });
  } finally {
    await busy.query("select pg_advisory_unlock_all()");
    busy.release();
  }
  // Five an hour, each one in the audit log; an old one no longer counts.
  for (let i = 4; i <= 5; i += 1) assert.equal((await call(0, "export")).status, 200, `export ${i}`);
  const limited = await call<{ code: string }>(0, "export");
  assert.deepEqual([limited.status, limited.data], [429, { code: "EXPORT_LIMIT" }]);
  assert.equal((await pool.query("select count(*)::int as n from public.audit_events where owner_id = $1 and action = 'ACCOUNT_EXPORT'", [A.owner])).rows[0].n, 5);
  // The audit log cannot be changed, so the test steps around its guard to let an hour pass and to leave no exports behind.
  const aroundTheGuard = async (sql: string, values: unknown[] = []) => {
    const client = await pool.connect();
    try {
      await client.query("set session_replication_role = replica");
      await client.query(sql, values);
    } finally {
      await client.query("reset session_replication_role");
      client.release();
    }
  };
  await aroundTheGuard(`update public.audit_events set occurred_at = now() - interval '61 minutes'
    where id = (select id from public.audit_events where owner_id = $1 and action = 'ACCOUNT_EXPORT' order by occurred_at limit 1)`, [A.owner]);
  assert.equal((await call(0, "export")).status, 200);
  await pool.query("delete from public.community_follows where actor_id = $1 and target_id = $2", [actorA, actorB]);
  await pool.query("delete from companion_private.chats where id = $1", [theirChat]);
  await pool.query("delete from companion_private.companion_connections where companion_id = $1", [second]);
  await pool.query("delete from public.community_comments where body = '导出里要有这条评论'");
  await pool.query("delete from public.community_posts where body in ('另一位主人的家机发的动态', '导出里要有这条动态', '删掉的动态不在导出里')");
  await aroundTheGuard("delete from public.audit_events where action = 'ACCOUNT_EXPORT'");
  await pool.query("delete from companion_private.own_skills where companion_id = $1", [A.companion]);
  await pool.query("delete from companion_private.companion_skills where companion_id = $1", [A.companion]);
  await pool.query("delete from companion_private.world_entries where companion_id = $1 and body = '导出里要有这条设定'", [A.companion]);
  await pool.query("delete from companion_private.companion_memories where companion_id = $1 and body = '导出里要有这条记忆'", [A.companion]);
  await pool.query("delete from companion_private.agent_keys where companion_id = $1 and name = '导出测试'", [A.companion]);
  passed("the export: everything of the Owner's in one document, nothing of anyone else's, no key or token, five an hour and each one audited");
  }

  // Leave the shared development database as other suites expect it.
  await pool.query("delete from companion_private.diary_entries where companion_id in ($1, $2)", [A.companion, second]);
  await pool.query("delete from companion_private.diary_settings");
  await pool.query("delete from companion_private.chats where owner_id = $1", [A.owner]);
  await pool.query("delete from companion_private.chat_settings");
  await pool.query("update public.companions set status = 'DELETED' where id = $1", [second]);
  await pool.query("do $$ begin execute format('alter database %I reset companion.chat_pace', current_database()); end $$");
  console.log(`Chat integration passed (${groups} groups).`);
} finally {
  await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
  await pool.end();
}
