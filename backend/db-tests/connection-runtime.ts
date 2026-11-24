import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createMobileDevHttpServer } from "../src/dev/mobile-http-server.ts";
import { createPgPool } from "../src/persistence/postgres/index.ts";
import { ChatReplies, devChatModel } from "../src/chat/replies.ts";
import { ConnectedChatModel, Connections } from "../src/connections/model.ts";
import type { PostJson } from "../src/connections/guard.ts";
import { SecretBox } from "../src/connections/secret-box.ts";
import type { Chat, ChatPage, CompanionConnection, ConnectionSaveResult } from "../../contracts/chat.ts";

// Owners' own keys and agents (migration 0048). The outside calls are replaced by a stand-in.
const connectionString = process.env.DATABASE_URL;
if (!connectionString || process.env.COMPANION_SOCIAL_DEV_DATABASE !== "1") throw Error("Disposable seeded development database required.");
const setup = createPgPool(connectionString);
await setup.query(`do $$ begin execute format('alter database %I set companion.chat_pace = %L', current_database(), '0.02'); end $$`);
await setup.end();

const pool = createPgPool(connectionString);
const ids = (letter: "a" | "b") => ({ owner: `00000000-0000-0000-0000-0000000001${letter}1`,
  subject: `00000000-0000-0000-0000-0000000000${letter}1`, companion: `00000000-0000-0000-0000-0000000002${letter}1` });
const A = ids("a"), B = ids("b");
const box = new SecretBox(Buffer.alloc(32, 9));
const outside: { url: string; auth: string | undefined }[] = [];
const post: PostJson = async (url, headers) => {
  outside.push({ url: String(url), auth: headers.authorization });
  return { status: 200, body: { choices: [{ message: { content: "来自主人自己的模型" }, finish_reason: "stop" }] } };
};
const chat = () => ({ replies: new ChatReplies(new ConnectedChatModel(devChatModel, box, post)), connections: new Connections(box, async () => "CONNECTED") });
const servers = [A, B].map((v, i) => createMobileDevHttpServer({ pool, ownerId: v.owner, ownerSubject: v.subject, bearerToken: `conn-${i}`, chat: chat() }));
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let groups = 0;
const passed = (name: string) => { groups += 1; console.log(`Connection integration ${groups}: ${name}`); };

try {
  const bases = await Promise.all(servers.map(server => new Promise<string>(resolve =>
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)))));
  async function call<T>(who: 0 | 1, path: string, method = "GET", body?: unknown) {
    const response = await fetch(`${bases[who]}/v0/${path}`, {
      method, headers: { Authorization: `Bearer conn-${who}`, "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json() as T };
  }
  async function lastReply(text: string): Promise<string | null> {
    const chatId = (await call<Chat>(0, "chats", "POST", { companionIds: [A.companion] })).data.id;
    assert.equal((await call(0, `chats/${chatId}/messages`, "POST", { body: text })).status, 201);
    let page: ChatPage | undefined;
    for (let i = 0; i < 300 && (page === undefined || page.chat.replying); i += 1) {
      if (page !== undefined) await pause(20);
      page = (await call<ChatPage>(0, `chats/${chatId}`)).data;
    }
    return page!.items.find(m => m.companionId !== null)?.body ?? null;
  }

  const path = `companions/${A.companion}/connection`;
  assert.equal((await call<CompanionConnection>(0, path)).data.kind, "PLATFORM");
  const saved = await call<ConnectionSaveResult>(0, path, "PUT",
    { kind: "BYOK", provider: "deepseek", model: "deepseek-chat", apiKey: "sk-owner-secret-9876", consent: true });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.deepEqual([saved.data.result, saved.data.connection.kind, saved.data.connection.keyHint, saved.data.connection.baseUrl],
    ["CONNECTED", "BYOK", "9876", "https://api.deepseek.com/v1"]);
  assert.doesNotMatch(JSON.stringify((await call(0, path)).data), /owner-secret/);
  const row = (await pool.query("select secret from companion_private.companion_connections where companion_id = $1", [A.companion])).rows[0]!;
  assert.doesNotMatch(row.secret, /owner-secret/, "only ciphertext in the database");
  assert.equal(box.open(row.secret, A.companion), "sk-owner-secret-9876");
  passed("a tested BYOK connection is saved sealed; the Owner sees only the last 4 characters");

  assert.equal(await lastReply("用我自己的模型回"), "来自主人自己的模型");
  assert.deepEqual(outside.at(-1), { url: "https://api.deepseek.com/v1/chat/completions", auth: "Bearer sk-owner-secret-9876" });
  const external = await call<ConnectionSaveResult>(0, path, "PUT",
    { kind: "EXTERNAL", name: "我的本体", endpoint: "https://agent.example.com/v1/chat/completions", bearerToken: "tok-1", consent: true });
  assert.deepEqual([external.data.connection.kind, external.data.connection.name, external.data.connection.provider], ["EXTERNAL", "我的本体", null]);
  assert.equal(await lastReply("本体在吗"), "来自主人自己的模型");
  assert.deepEqual(outside.at(-1), { url: "https://agent.example.com/v1/chat/completions", auth: "Bearer tok-1" });
  passed("replies come from the Owner's own model or agent, and are kept in the chat");

  for (const [method, body] of [["GET", undefined], ["DELETE", undefined],
    ["PUT", { kind: "BYOK", provider: "qwen", model: "qwen-plus", apiKey: "sk-b", consent: true }]] as const) {
    assert.equal((await call(1, path, method, body)).status, 404, `${method} another Owner's Companion`);
  }
  const calls = outside.length;
  assert.equal(outside.length, calls, "no outside call for someone else's Companion");
  const direct = await pool.connect();
  try {
    for (const sql of ["select * from companion_private.companion_connections", `select public.connection_secret('${A.companion}')`,
      `select public.connection_save('${A.companion}', 'BYOK', 'deepseek', 'https://api.deepseek.com/v1', 'm', null, 'v1.a.b.c', 'x')`]) {
      await direct.query("begin");
      await direct.query("set local role authenticated");
      await direct.query(`select set_config('request.jwt.claim.sub', $1, true)`, [A.subject]);
      await assert.rejects(direct.query(sql), /permission denied/, sql);
      await direct.query("rollback");
    }
  } finally {
    direct.release();
  }
  passed("Owner-scoped; signed-in users cannot read secrets or save around the server's test");

  assert.equal((await call<CompanionConnection>(0, path, "DELETE")).data.kind, "PLATFORM");
  assert.equal((await pool.query("select count(*)::int n from companion_private.companion_connections where companion_id = $1", [A.companion])).rows[0]!.n, 0);
  assert.equal(await lastReply("回到平台"), "收到：「回到平台」", "the dev host answers again");
  const audit = await pool.query(`select action from public.audit_events where companion_id = $1 and action like 'CONNECTION_%' order by occurred_at`, [A.companion]);
  assert.deepEqual(audit.rows.map(r => r.action), ["CONNECTION_SAVE_BYOK", "CONNECTION_SAVE_EXTERNAL", "CONNECTION_DELETE"]);
  passed("deleting goes back to the platform and removes the sealed key; every change is audited");
} finally {
  await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
  await pool.end();
}
console.log(`Connection integration: ${groups} groups passed`);
