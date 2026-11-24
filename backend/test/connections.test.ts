import assert from "node:assert/strict";
import type { LookupAddress } from "node:dns";
import { it } from "node:test";
import { handleChatRequest } from "../src/chat/http.ts";
import type { ChatClaim, ChatPort, DiaryJob } from "../src/chat/port.ts";
import { ChatReplies, devChatModel } from "../src/chat/replies.ts";
import { checkUrl, createPostJson, isPublicAddress, publicLookup, type PostJson } from "../src/connections/guard.ts";
import { checkConnection, ConnectedChatModel, Connections, testConnection, type StoredConnection } from "../src/connections/model.ts";
import { SecretBox } from "../src/connections/secret-box.ts";
import { chatFromEnvironment } from "../src/chat/setup.ts";
import type { AuthenticatedOwnerSession, MvpHttpRequest, OwnerApiPort } from "../src/http/types.ts";
import type { PostgresPersistenceError } from "../src/persistence/postgres/types.ts";

const companion = "00000000-0000-0000-0000-0000000002a1";
const ownerId = "00000000-0000-0000-0000-0000000001a1";
const box = new SecretBox(Buffer.alloc(32, 7));

it("seals secrets so only this key opens them, and only for the same Companion", () => {
  const sealed = box.seal("sk-owner-key", companion);
  assert.match(sealed, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/);
  assert.doesNotMatch(sealed, /owner-key/);
  assert.notEqual(box.seal("sk-owner-key", companion), sealed, "a fresh nonce each time");
  assert.equal(box.open(sealed, companion), "sk-owner-key");
  assert.throws(() => box.open(sealed, "00000000-0000-0000-0000-0000000002b1"), "bound to its Companion");
  assert.throws(() => new SecretBox(Buffer.alloc(32, 8)).open(sealed, companion), "another key");
  assert.throws(() => box.open("v2.a.b.c", companion), /Unknown/);
  assert.throws(() => new SecretBox(Buffer.alloc(16)), /32 bytes/);
  assert.equal(SecretBox.fromEnv({}), undefined);
  assert.equal(SecretBox.fromEnv({ CONNECTION_SECRET_KEY: Buffer.alloc(32, 7).toString("base64") })!.open(sealed, companion), "sk-owner-key");
});

it("only lets the server call public https addresses on port 443", () => {
  for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) assert.ok(isPublicAddress(address), address);
  for (const address of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0",
    "224.0.0.1", "::1", "::", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "64:ff9b::a00:1", "2002:a00:1::", "::7f00:1", "::ffff:0:7f00:1", "4000::1", "not-an-ip"]) {
    assert.ok(!isPublicAddress(address), address);
  }
  assert.ok(isPublicAddress("::ffff:8.8.8.8"), "a mapped public IPv4");
  assert.equal(checkUrl("https://[::127.0.0.1]/v1"), "BLOCKED_ADDRESS");
  assert.ok(checkUrl("https://api.deepseek.com/v1") instanceof URL);
  assert.ok(checkUrl("https://agent.example.com:443/v1/chat/completions") instanceof URL);
  for (const bad of ["http://api.example.com", "https://user:pw@api.example.com", "https://api.example.com/?key=1", "https://api.example.com/#x",
    "https://api.example.com:8443/v1", "not a url", "https://api.example.com/ space", `https://api.example.com/${"a".repeat(500)}`]) {
    assert.equal(checkUrl(bad), "INVALID_URL", bad);
  }
  for (const bad of ["https://127.0.0.1/v1", "https://[::1]/v1", "https://169.254.169.254/latest", "https://localhost/v1",
    "https://db.internal/v1", "https://printer.local/v1", "https://a.localhost/v1"]) {
    assert.equal(checkUrl(bad), "BLOCKED_ADDRESS", bad);
  }
});

it("refuses a name that resolves to any private address, at connection time", async () => {
  const fake = (addresses: LookupAddress[] | Error) => ((_host: string, _options: unknown, done: (e: Error | null, a: LookupAddress[]) => void) =>
    addresses instanceof Error ? done(addresses, []) : done(null, addresses)) as never;
  const ask = (lookup: ReturnType<typeof publicLookup>, all: boolean) => new Promise<unknown>((resolve, reject) =>
    lookup("agent.example.com", { all }, (error: Error | null, address: unknown, family?: number) =>
      (error ? reject(error) : resolve(all ? address : [address, family]))));
  const ok = publicLookup(fake([{ address: "8.8.8.8", family: 4 }, { address: "2606:4700:4700::1111", family: 6 }]));
  assert.deepEqual(await ask(ok, false), ["8.8.8.8", 4]);
  assert.equal((await ask(ok, true) as LookupAddress[]).length, 2);
  await assert.rejects(ask(publicLookup(fake([{ address: "8.8.8.8", family: 4 }, { address: "10.0.0.5", family: 4 }])), false), /not public/);
  await assert.rejects(ask(publicLookup(fake([])), false), /not public/);
  await assert.rejects(ask(publicLookup(fake(new Error("ENOTFOUND"))), true), /ENOTFOUND/);
  const callback = await new Promise<unknown>((resolve, reject) =>
    ok("agent.example.com", ((error: Error | null, address: string) => (error ? reject(error) : resolve(address))) as never));
  assert.equal(callback, "8.8.8.8", "the options argument is optional");
  // The real HTTPS call never connects to a private address.
  const post = createPostJson(fake([{ address: "127.0.0.1", family: 4 }]));
  await assert.rejects(post(new URL("https://agent.example.com/v1"), {}, {}, { signal: AbortSignal.timeout(2000), timeoutMs: 2000 }), /not public/);
});

it("checks what the app sends before anything is called", () => {
  const byok = { kind: "BYOK", provider: "deepseek", model: "deepseek-chat", apiKey: "sk-abcdef", consent: true } as const;
  assert.deepEqual(checkConnection(byok),
    { kind: "BYOK", provider: "deepseek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", name: null, secret: "sk-abcdef" });
  assert.equal((checkConnection({ ...byok, baseUrl: "https://evil.example.com" }) as { baseUrl: string }).baseUrl,
    "https://api.deepseek.com/v1", "a preset's base cannot be changed");
  assert.equal((checkConnection({ ...byok, provider: "custom", baseUrl: "https://llm.example.com/v1/" }) as { baseUrl: string }).baseUrl,
    "https://llm.example.com/v1");
  for (const bad of [{ consent: false }, { provider: "nope" }, { model: "bad model" }, { apiKey: "has space" }, { apiKey: "" }, { apiKey: "short" }, { provider: "custom" }]) {
    assert.equal(checkConnection({ ...byok, ...bad } as never), "INVALID_INPUT", JSON.stringify(bad));
  }
  assert.equal(checkConnection({ ...byok, provider: "custom", baseUrl: "http://x.example.com" }), "INVALID_URL");
  assert.equal(checkConnection({ ...byok, provider: "custom", baseUrl: "https://10.0.0.1/v1" }), "BLOCKED_ADDRESS");
  const external = { kind: "EXTERNAL", name: " 我的本体 ", endpoint: "https://agent.example.com/v1/chat/completions", bearerToken: "", consent: true } as const;
  assert.deepEqual(checkConnection(external), { kind: "EXTERNAL", provider: null, baseUrl: "https://agent.example.com/v1/chat/completions",
    model: null, name: "我的本体", secret: "" });
  for (const bad of [{ name: " " }, { name: "名".repeat(41) }, { bearerToken: "a b" }, { model: "a b" }, { consent: false }]) {
    assert.equal(checkConnection({ ...external, ...bad } as never), "INVALID_INPUT", JSON.stringify(bad));
  }
  assert.equal(checkConnection({ ...external, endpoint: "https://192.168.0.2/chat" }), "BLOCKED_ADDRESS");
  assert.equal(checkConnection({ ...external, endpoint: "ftp://x" }), "INVALID_URL");
});

const completion = (text: string, finish = "stop") => ({ choices: [{ message: { content: text }, finish_reason: finish }] });

it("tests a connection with one tiny call and says why it failed", async () => {
  const connection = checkConnection({ kind: "BYOK", provider: "kimi", model: "moonshot-v1-8k", apiKey: "sk-kimi-123", consent: true }) as never;
  const seen: unknown[][] = [];
  const answer = (status: number, body: unknown): PostJson => async (...args) => { seen.push(args); return { status, body }; };
  assert.equal(await testConnection(connection, answer(200, completion("你好呀"))), "CONNECTED");
  const [url, headers, body] = seen[0]!;
  assert.equal(String(url), "https://api.moonshot.cn/v1/chat/completions");
  assert.deepEqual(headers, { authorization: "Bearer sk-kimi-123" });
  assert.equal((body as { model: string }).model, "moonshot-v1-8k");
  assert.equal(await testConnection(connection, answer(200, completion("", "length"))), "CONNECTED");
  assert.equal(await testConnection(connection, answer(401, {})), "AUTH_FAILED");
  assert.equal(await testConnection(connection, answer(403, {})), "AUTH_FAILED");
  assert.equal(await testConnection(connection, answer(404, {})), "NOT_FOUND");
  assert.equal(await testConnection(connection, answer(500, {})), "ERROR");
  assert.equal(await testConnection(connection, answer(200, { hello: 1 })), "BAD_ANSWER");
  assert.equal(await testConnection(connection, async () => { throw new Error("ETIMEDOUT"); }), "UNREACHABLE");
  const blocked = createPostJson(((_h: string, _o: unknown, done: (e: Error | null, a: LookupAddress[]) => void) =>
    done(null, [{ address: "10.0.0.1", family: 4 }])) as never);
  assert.equal(await testConnection(connection, blocked), "BLOCKED_ADDRESS");
  const external = checkConnection({ kind: "EXTERNAL", name: "本体", endpoint: "https://agent.example.com/run", bearerToken: "", consent: true }) as never;
  seen.length = 0;
  assert.equal(await testConnection(external, answer(200, completion("在"))), "CONNECTED");
  assert.deepEqual([String(seen[0]![0]), seen[0]![1], "model" in (seen[0]![2] as object)], ["https://agent.example.com/run", {}, false]);
});

const settings = { groupActivity: "NORMAL", companionInteraction: "NORMAL", model: null, revision: 1 } as const;
const turn = (overrides: Partial<ChatClaim> = {}): ChatClaim => ({
  chatId: "c", replyId: "r", claimId: "k", replyTo: "OWNER", optional: false, direct: true,
  companion: { companionId: companion, displayName: "小光", identity: { identitySummary: "温柔" }, settings },
  members: [{ companionId: companion, displayName: "小光" }],
  history: [
    { companionId: null, body: "在吗 password: hunter2hunter2", action: null, mentions: [], sentAt: "t1" },
    { companionId: companion, body: "在的", action: null, mentions: [], sentAt: "t2" },
    { companionId: null, body: null, action: "PAT_HEAD", mentions: [], sentAt: "t3" },
  ],
  ...overrides,
});
const job: DiaryJob = { status: "WRITE", entryId: "e", claimId: "k", companion: turn().companion, messages: [], posts: [] };

function storePort(stored: StoredConnection | null) {
  return { connection: async () => stored, memories: async () => ({ items: [{ body: "主人怕黑" }] }) } as unknown as ChatPort;
}

it("answers through the Owner's key or agent, and through the platform without a connection", async () => {
  const sent: { url: string; headers: Record<string, string>; body: { messages: { role: string; content: string }[]; model?: string } }[] = [];
  const post = (text: string, finish = "stop"): PostJson => async (url, headers, body) => {
    sent.push({ url: String(url), headers, body: body as never });
    return { status: 200, body: completion(text, finish) };
  };
  const signal = new AbortController().signal;
  const byok: StoredConnection = { kind: "BYOK", provider: "deepseek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat",
    name: null, secret: box.seal("sk-ds-1234", companion) };
  const model = new ConnectedChatModel(devChatModel, box, post("好呀\n走吧"));
  assert.deepEqual(await model.reply(turn(), { port: storePort(byok), signal }), { messages: ["好呀", "走吧"] });
  assert.equal(sent[0]!.url, "https://api.deepseek.com/v1/chat/completions");
  assert.deepEqual(sent[0]!.headers, { authorization: "Bearer sk-ds-1234" });
  assert.equal(sent[0]!.body.model, "deepseek-chat");
  assert.match(sent[0]!.body.messages[0]!.content, /主人怕黑/, "BYOK uses the platform prompt with memories");

  const external: StoredConnection = { kind: "EXTERNAL", provider: null, baseUrl: "https://agent.example.com/run", model: null,
    name: "本体", secret: box.seal("", companion) };
  sent.length = 0;
  const agent = new ConnectedChatModel(undefined, box, post("嗯嗯"));
  assert.deepEqual(await agent.reply(turn(), { port: storePort(external), signal }), { messages: ["嗯嗯"] });
  const messages = sent[0]!.body.messages;
  assert.deepEqual(sent[0]!.headers, {}, "no token, no header");
  assert.deepEqual(messages.slice(1).map(m => [m.role, m.content]), [
    ["user", "在吗 [REDACTED_CREDENTIAL]"], ["assistant", "在的"], ["user", "（在小家里摸了摸你的头）"]]);
  assert.doesNotMatch(messages[0]!.content, /主人怕黑/, "an agent keeps its own memory");
  const group = turn({ direct: false, optional: true, members: [{ companionId: companion, displayName: "小光" }, { companionId: "o", displayName: "阿默" }],
    history: [{ companionId: "o", body: "大家好", action: null, mentions: [], sentAt: "t" }, { companionId: companion, body: "好", action: null, mentions: [], sentAt: "t" }] });
  sent.length = 0;
  await agent.reply(group, { port: storePort(external), signal });
  assert.deepEqual(sent[0]!.body.messages.slice(1).map(m => m.content), ["【阿默】大家好", "好", "（现在轮到你，小光。）"]);
  assert.match(sent[0]!.body.messages[0]!.content, /\[不说话\]/);

  assert.deepEqual(await new ConnectedChatModel(undefined, box, post("x")).reply(turn(), { port: storePort(null), signal }), { failed: "UNAVAILABLE" });
  assert.match((await new ConnectedChatModel(devChatModel, box, post("x")).reply(turn(), { port: storePort(null), signal }) as { messages: string[] })
    .messages[0]!, /开发环境/);
  assert.deepEqual(await new ConnectedChatModel(undefined, box, async () => ({ status: 200, body: { choices: [{ message: { content: "" },
    finish_reason: "content_filter" }] } })).reply(turn(), { port: storePort(byok), signal }), { refused: true });
  await assert.rejects(new ConnectedChatModel(undefined, box, post("半句", "length")).reply(turn(), { port: storePort(byok), signal }), /cut off/);
  await assert.rejects(new ConnectedChatModel(undefined, box, async () => ({ status: 502, body: {} })).reply(turn(), { port: storePort(byok), signal }), /502/);
  await assert.rejects(new ConnectedChatModel(undefined, box, async () => ({ status: 200, body: undefined })).reply(turn(), { port: storePort(byok), signal }), /JSON/);

  // Diary
  sent.length = 0;
  assert.deepEqual(await new ConnectedChatModel(undefined, box, post("今天很好")).diary(job, { port: storePort(byok), signal }), { text: "今天很好" });
  assert.match(sent[0]!.body.messages[0]!.content, /主人怕黑/);
  sent.length = 0;
  await new ConnectedChatModel(undefined, box, post("今天很好")).diary(job, { port: storePort(external), signal });
  assert.doesNotMatch(sent[0]!.body.messages[0]!.content, /主人怕黑/);
  assert.deepEqual(await new ConnectedChatModel(undefined, box, post("x")).diary(job, { port: storePort(null), signal }), { failed: "UNAVAILABLE" });
  assert.match((await new ConnectedChatModel(devChatModel, box, post("x")).diary(job, { port: storePort(null), signal }) as { text: string }).text, /开发环境/);
  assert.deepEqual(await new ConnectedChatModel(undefined, box, async () => ({ status: 200, body: { choices: [{ message: { content: "" },
    finish_reason: "content_filter" }] } })).diary(job, { port: storePort(byok), signal }), { refused: true });
  await assert.rejects(new ConnectedChatModel(undefined, box, post("半", "length")).diary(job, { port: storePort(byok), signal }), /cut off/);
});

it("limits connection tests per Owner", () => {
  let now = 0;
  const connections = new Connections(box, async () => "CONNECTED", () => now);
  for (let i = 0; i < 10; i += 1) assert.ok(connections.allow("a"));
  assert.equal(connections.allow("a"), false);
  assert.ok(connections.allow("b"), "per Owner");
  now = 600_001;
  assert.ok(connections.allow("a"), "ten minutes later");
});

it("routes connections: tests before saving, never returns the key, 501 without a server key", async () => {
  const calls: unknown[][] = [];
  const port = {
    connectionView: async (...args: unknown[]) => { calls.push(["view", ...args]); return { kind: "PLATFORM" }; },
    saveConnection: async (...args: unknown[]) => { calls.push(["save", ...args]); return { kind: "BYOK", keyHint: args[2] }; },
    removeConnection: async (...args: unknown[]) => { calls.push(["remove", ...args]); return { kind: "PLATFORM" }; },
  } as unknown as ChatPort;
  const session: AuthenticatedOwnerSession = { ownerId, owner: {} as OwnerApiPort, chat: port };
  const replies = new ChatReplies();
  const request = (method: string, body?: unknown): MvpHttpRequest => ({ method, url: `/v0/companions/${companion}/connection`,
    headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body }) });
  let result: "CONNECTED" | "AUTH_FAILED" = "AUTH_FAILED";
  const connections = new Connections(box, async () => result);
  const handle = (req: MvpHttpRequest, c: Connections | undefined = connections) => handleChatRequest(req, session, "t", replies, undefined, c);
  const byok = { kind: "BYOK", provider: "glm", model: "glm-4-flash", apiKey: "sk-glm-abcd1234", consent: true };

  assert.deepEqual((await handle(request("GET")))!.body, { kind: "PLATFORM" });
  assert.deepEqual((await handle(request("DELETE")))!.body, { kind: "PLATFORM" });
  assert.deepEqual((await handle(request("PUT", byok)))!.body, { result: "AUTH_FAILED", connection: { kind: "PLATFORM" } });
  assert.ok(!calls.some(c => c[0] === "save"), "a failed test saves nothing");
  result = "CONNECTED";
  const saved = await handle(request("PUT", byok));
  assert.deepEqual(saved!.body, { result: "CONNECTED", connection: { kind: "BYOK", keyHint: "1234" } });
  const save = calls.find(c => c[0] === "save")!;
  const stored = save[2] as StoredConnection;
  assert.equal(box.open(stored.secret, companion), "sk-glm-abcd1234", "sealed for this Companion");
  assert.doesNotMatch(JSON.stringify(saved!.body), /sk-glm/);
  await handle(request("PUT", { ...byok, apiKey: "sk-short1" }));
  assert.equal(calls.at(-1)![3], "", "a key under 12 characters gets no hint, so it is never stored in clear");
  assert.deepEqual((await handle(request("PUT", { ...byok, provider: "custom", baseUrl: "https://10.0.0.1/v1" })))!.body,
    { result: "BLOCKED_ADDRESS", connection: { kind: "PLATFORM" } });
  assert.equal((await handleChatRequest(request("PUT", byok), session, "t", replies))!.status, 501);
  const refusal = (req: MvpHttpRequest) => handle(req).then(() => "ok", (e: PostgresPersistenceError) => e.code);
  for (const bad of [{ ...byok, kind: "OTHER" }, { ...byok, extra: 1 }, { ...byok, apiKey: 5 }, { ...byok, consent: "yes" },
    { ...byok, baseUrl: 7 }, { ...byok, consent: false }, { ...byok, provider: "custom", baseUrl: "http://x.example.com" },
    { kind: "EXTERNAL", name: "x", endpoint: "https://a.example.com", bearerToken: "", consent: true, model: 3 }]) {
    assert.equal(await refusal(request("PUT", bad)), "INVALID_INPUT", JSON.stringify(bad));
  }
  assert.equal(await refusal(request("POST", byok)), "NOT_FOUND");
  const busy = new Connections(box, async () => "CONNECTED", () => 0);
  for (let i = 0; i < 10; i += 1) busy.allow(ownerId);
  assert.equal((await handle(request("PUT", byok), busy))!.status, 429);
});

it("turns connections on only with a server key", () => {
  assert.equal("connections" in chatFromEnvironment("supabase-auth", {}), false);
  const on = chatFromEnvironment("supabase-auth", { CONNECTION_SECRET_KEY: Buffer.alloc(32, 1).toString("base64") });
  assert.ok(on.connections instanceof Connections);
});
