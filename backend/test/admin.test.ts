import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { after, it } from "node:test";
import type pg from "pg";
import { AdminRefusal, PgAdminDb, explain, type AdminDb, type AdminFunction } from "../src/admin/db.ts";
import type { ChatList, ChatPage, LogPage, Models, OwnerDetail, OwnerList, Report, ReportQueue, Spend } from "../src/admin/pages.ts";
import { createAdminServer } from "../src/admin/server.ts";

const TOKEN = "t".repeat(64);
const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const OWNER = id(1), TWIN = id(2), REPORT = id(3), POST = id(4), COMMENT = id(5), CHAT = id(6), COMPANION = id(7);
const AT = "2026-11-23T08:00:00.123456+00:00";
const NASTY = `<script>alert("x")</script>&'`;

const human = { id: id(11), kind: "HUMAN" as const, displayName: "Reporter", handle: "human_1", ownerId: id(12), ownerStatus: "ACTIVE", twinId: null, twinStatus: null };
const companion = { id: id(13), kind: "AI" as const, displayName: NASTY, handle: "ai_1", ownerId: OWNER, ownerStatus: "SUSPENDED", twinId: TWIN, twinStatus: "ACTIVE" };
const report = (change: Partial<Report> = {}): Report => ({
  id: REPORT, createdAt: AT, reason: "HARASSMENT", details: NASTY, targetType: "POST", targetId: POST, evidence: { body: NASTY },
  status: "SUBMITTED", resolution: null, note: null, reviewedBy: null, reviewedAt: null, reporter: human, target: companion, live: true, others: 2, ...change,
});
const fixtures = {
  reports: { pending: 3, items: [report(), report({ id: id(31), targetType: "ACTOR", target: human, evidence: { displayName: "Someone" }, live: null, others: 0, details: "" }),
    report({ id: id(32), live: false, others: 0 })] } satisfies ReportQueue as ReportQueue,
  owners: { items: [{ id: OWNER, email: "a@example.test", displayName: NASTY, status: "ACTIVE", createdAt: AT, companions: 2, posts: 5 },
    { id: id(12), email: null, displayName: null, status: "SUSPENDED", createdAt: AT, companions: 0, posts: 0 }], more: true } satisfies OwnerList as OwnerList,
  owner_detail: {
    owner: { id: OWNER, email: "a@example.test", displayName: "Alice", status: "ACTIVE", createdAt: AT },
    companions: [{ id: COMPANION, status: "ACTIVE", displayName: "Mochi", twinId: TWIN, twinStatus: "ACTIVE" },
      { id: id(71), status: "ACTIVE", displayName: "Stopped", twinId: id(21), twinStatus: "SUSPENDED" },
      { id: id(72), status: "DRAFT", displayName: null, twinId: null, twinStatus: null }],
    posts: [{ id: POST, author: { kind: "HUMAN", displayName: "Alice" }, body: NASTY, source: "HUMAN_MANUAL", createdAt: AT, deletedAt: null, removedByAdmin: false },
      { id: id(41), author: { kind: "AI", displayName: "Mochi" }, body: "[已被管理员移除]", source: "OWNER_PROXY", createdAt: AT, deletedAt: AT, removedByAdmin: true },
      { id: id(42), author: { kind: "AI", displayName: null }, body: "[已删除]", source: "OWNER_PROXY", createdAt: AT, deletedAt: AT, removedByAdmin: false }],
    comments: [{ id: COMMENT, postId: POST, author: { kind: "HUMAN", displayName: "Alice" }, body: "a comment", source: "HUMAN_MANUAL", createdAt: AT, deletedAt: null, removedByAdmin: false }],
  } satisfies OwnerDetail as OwnerDetail | null,
  chats: { items: [{ id: CHAT, title: null, direct: true, members: [{ companionId: COMPANION, displayName: "Mochi" }], createdAt: AT, activeAt: AT, messages: 12 },
    { id: id(61), title: null, direct: false, members: [], createdAt: AT, activeAt: AT, messages: 0 },
    { id: id(62), title: NASTY, direct: false, members: [{ companionId: COMPANION, displayName: null }], createdAt: AT, activeAt: AT, messages: 1 }] } satisfies ChatList as ChatList,
  chat_read: {
    chat: { id: CHAT, ownerId: OWNER, title: null, direct: true, members: [{ companionId: COMPANION, displayName: "Mochi" }] },
    items: [{ id: id(81), companionId: id(99), body: null, status: "FAILED", failure: "QUOTA", createdAt: AT },
      { id: id(82), companionId: COMPANION, body: "second line", status: "SENT", failure: null, createdAt: AT },
      { id: id(83), companionId: null, body: NASTY, status: "SENT", failure: null, createdAt: AT },
      { id: id(84), companionId: COMPANION, body: null, status: "PENDING", failure: null, createdAt: AT }],
    next: { at: AT, id: id(81) },
  } satisfies ChatPage as ChatPage,
  models: { switches: [{ scope: "MODEL", key: "claude/claude-small", enabled: false, note: NASTY, updatedAt: AT },
    { scope: "PROVIDER", key: "other", enabled: false, note: "outage", updatedAt: AT }, { scope: "ALL", key: "*", enabled: true, note: "back on", updatedAt: AT }],
    quota: { dailyCalls: 200, dailyCostMinor: 100, currency: "USD", updatedAt: AT } } satisfies Models as Models,
  spend: { from: "2026-11-17", to: "2026-11-23", totals: [{ currency: "USD", calls: 12, costMinor: 345 }],
    byDay: [{ day: "2026-11-23", provider: "claude", model: "claude-big", currency: "USD", calls: 12, failed: 1, inputTokens: 9000, outputTokens: 700, costMinor: 345 }],
    byCompanion: [{ companionId: COMPANION, ownerId: OWNER, displayName: "Mochi", currency: "USD", calls: 12, costMinor: 345 }] } satisfies Spend as Spend,
  log: { items: [{ id: 9, operator: "admin_alice", action: "REMOVE_POST", targetType: "POST", targetId: POST, ownerId: OWNER, reason: NASTY, detail: { body: NASTY }, createdAt: AT },
    { id: 8, operator: "admin_bob", action: "MODEL_SWITCH", targetType: "ALL", targetId: "*", ownerId: null, reason: "outage", detail: {}, createdAt: AT }], next: 8 } satisfies LogPage as LogPage,
};
type Returned = Partial<Record<AdminFunction, unknown>>;

/** A console database that returns the fixtures (or what the test put in `returns`) and remembers every call. */
function fakeDb(returns: Returned = {}, failure?: unknown) {
  const calls: [AdminFunction, ...unknown[]][] = [];
  const db: AdminDb = {
    async call<T>(fn: AdminFunction, ...args: unknown[]): Promise<T> {
      calls.push([fn, ...args]);
      if (failure !== undefined) throw failure;
      return (fn in returns ? returns[fn] : (fixtures as Returned)[fn]) as T;
    },
  };
  return { db, calls };
}

const catalog = [{ name: "Big", provider: "claude", model: "claude-big" }, { name: "Small", provider: "claude", model: "claude-small" },
  { name: "Cheap", provider: "other", model: "other-chat" }];
const servers: ReturnType<typeof createAdminServer>[] = [];
after(() => { for (const server of servers) server.close(); });

interface Sent { method?: string; cookie?: string | null; host?: string; origin?: string; form?: Record<string, string>; body?: string; type?: string }
async function start(returns: Returned = {}, failure?: unknown) {
  const { db, calls } = fakeDb(returns, failure);
  const errors: unknown[] = [];
  const server = createAdminServer({ db, token: TOKEN, catalog, timeZone: "UTC", now: () => new Date("2026-11-23T12:00:00Z"), onError: e => errors.push(e) });
  servers.push(server);
  const port = await new Promise<number>(resolve => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
  const send = (path: string, sent: Sent = {}) => new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
    const body = sent.body ?? (sent.form === undefined ? undefined : new URLSearchParams(sent.form).toString());
    const req = httpRequest({ host: "127.0.0.1", port, path, method: sent.method ?? (body === undefined ? "GET" : "POST"), headers: {
      Host: sent.host ?? `127.0.0.1:${port}`,
      ...(sent.cookie === null ? {} : { Cookie: sent.cookie ?? `other=1; admin_console=${TOKEN}` }),
      ...(body === undefined && sent.origin === undefined || sent.origin === "" ? {} : { Origin: sent.origin ?? `http://127.0.0.1:${port}` }),
      ...(body === undefined ? {} : { "Content-Type": sent.type ?? "application/x-www-form-urlencoded" }),
    } }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(chunk as Buffer));
      response.on("end", () => resolve({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(body);
  });
  return { send, calls, errors, port };
}
const change = (fields: Record<string, string> = {}) => ({ reason: " because ", confirm: "yes", ...fields });

it("lets in only this machine, the start-up token and the console's own forms", async () => {
  const { send, calls, errors, port } = await start();
  assert.throws(() => createAdminServer({ db: fakeDb().db, token: "short", catalog }));
  for (const host of ["evil.example", `evil.example:${port}`, `127.0.0.1:${port + 1}`]) {
    assert.deepEqual([(await send("/reports", { host })).status, (await send("/reports", { host })).body], [403, "Forbidden"]);
  }
  for (const cookie of [null, "admin_console=", `admin_console=${"x".repeat(64)}`, `admin_console=${TOKEN}x`, `admin_console=${"é".repeat(64)}`]) {
    const refused = await send("/reports", { cookie });
    assert.equal(refused.status, 403);
    assert.match(refused.body, /请用后台启动时终端里打印的链接打开/);
  }
  assert.equal((await send(`/?token=${"x".repeat(64)}`, { cookie: null })).status, 403);
  assert.equal((await send(`/reports?token=${TOKEN}`, { cookie: null })).status, 403, "the token is taken only at the start page");
  const entered = await send(`/?token=${TOKEN}`, { cookie: null });
  assert.deepEqual([entered.status, entered.headers.location, entered.headers["set-cookie"]],
    [303, "/reports", [`admin_console=${TOKEN}; HttpOnly; SameSite=Strict; Path=/`]]);
  assert.equal(calls.length, 0, "nothing is read before the token is shown");

  const opened = await send("/reports", { host: `localhost:${port}` });
  assert.equal(opened.status, 200);
  assert.match(String(opened.headers["content-security-policy"]), /default-src 'none'/);
  // Not no-referrer: a browser posts forms from a no-referrer page with "Origin: null", which the console refuses.
  assert.deepEqual([opened.headers["cache-control"], opened.headers["referrer-policy"], opened.headers["x-content-type-options"]], ["no-store", "same-origin", "nosniff"]);
  assert.deepEqual([(await send("/")).status, (await send("/")).headers.location], [303, "/reports"]);
  assert.equal((await send("/nowhere")).status, 404);
  assert.equal((await send("/owners/not-an-id")).status, 404);
  assert.equal((await send("/reports", { method: "PUT" })).status, 405);
  assert.deepEqual([(await send("//[", { cookie: null })).status, (await send("//[")).status, errors], [400, 400, []], "an address that is not one is refused quietly");

  const before = calls.length;
  for (const origin of ["https://evil.example", `http://127.0.0.1:${port + 1}`, "null", ""]) {
    assert.equal((await send(`/owners/${OWNER}/suspend`, { form: change(), origin })).status, 403);
  }
  assert.equal(calls.length, before, "a form from another page changes nothing");
  assert.equal((await send(`/owners/${OWNER}/suspend`, { form: change(), origin: `http://localhost:${port}` })).status, 303);
  assert.equal((await send("/elsewhere", { form: change() })).status, 404);
  assert.equal((await send(`/owners/${OWNER}/suspend`, { body: "{}", type: "application/json" })).status, 409);
  for (const length of [20_000, 300_000]) {
    const tooLong = await send(`/owners/${OWNER}/suspend`, { form: change({ reason: "x".repeat(length) }) });
    assert.deepEqual([tooLong.status, /提交的内容太长/.test(tooLong.body)], [409, true], "a body that is too long is refused, not left hanging");
  }
});

it("shows the report queue with everything escaped, and closes a report only with a reason and a tick", async () => {
  const { send, calls } = await start();
  const queue = await send("/reports");
  assert.deepEqual(calls, [["reports", "SUBMITTED"]]);
  assert.ok(!queue.body.includes("<script>alert"), "user text never becomes markup");
  assert.ok(queue.body.includes("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;"));
  assert.match(queue.body, /待处理\(3\)/);
  assert.match(queue.body, /同一对象还有 2 条待处理举报/);
  assert.match(queue.body, /现在还能看到/);
  assert.match(queue.body, /现在已经看不到/);
  assert.match(queue.body, /主人<span class="tag bad">已封禁<\/span> 家机<span class="tag ">正常<\/span>/);
  const cards = queue.body.split('<div class="card">').slice(1);
  const offered = (card: string) => [...card.matchAll(/<option value="([A-Z_]+)"/g)].map(m => m[1]);
  assert.deepEqual(offered(cards[0]!), ["NONE", "REMOVED", "TWIN_SUSPENDED", "OWNER_SUSPENDED"], "a Companion's post");
  assert.deepEqual(offered(cards[1]!), ["NONE", "OWNER_SUSPENDED"], "a person's account");
  assert.match(cards[1]!, /&quot;displayName&quot;: &quot;Someone&quot;/);
  assert.ok(!cards[1]!.includes("举报说明"));

  const reviewed = await start({ reports: { pending: 0, items: [report({ status: "REVIEWED", resolution: "REMOVED", note: "spam", reviewedBy: "admin_alice", reviewedAt: AT })] } });
  const done = await reviewed.send("/reports?status=REVIEWED&ok=1");
  assert.deepEqual(reviewed.calls, [["reports", "REVIEWED"]]);
  assert.match(done.body, /处理结果:<b>移除内容<\/b> · admin_alice · 2026\/11\/23 08:00:00/);
  assert.match(done.body, /操作已完成,已记入日志/);
  assert.ok(!done.body.includes("<select"));
  assert.match((await (await start({ reports: { pending: 0, items: [] } })).send("/reports")).body, /没有待处理的举报/);
  assert.match((await (await start({ reports: { pending: 0, items: [] } })).send("/reports?status=REVIEWED")).body, /还没有处理过的举报/);
  assert.match((await (await start({ reports: { pending: 100, items: Array.from({ length: 100 }, () => report()) } })).send("/reports")).body, /只显示前 100 条/);

  calls.length = 0;
  const closed = await send(`/reports/${REPORT}/resolve`, { form: change({ resolution: "REMOVED", back: "/reports?status=SUBMITTED" }) });
  assert.deepEqual([closed.status, closed.headers.location], [303, "/reports?status=SUBMITTED&ok=1"]);
  assert.deepEqual(calls, [["report_resolve", REPORT, "REMOVED", "because"]]);
  calls.length = 0;
  for (const form of [change({ resolution: "REMOVED", confirm: "" }), { resolution: "REMOVED", confirm: "yes", reason: "  " }, { resolution: "REMOVED", confirm: "yes" },
    change({ resolution: "BANISHED" }), change()]) {
    const refused = await send(`/reports/${REPORT}/resolve`, { form: { ...form, back: `/owners/${OWNER}` } });
    assert.equal(refused.status, 409);
    assert.match(refused.body, new RegExp(`<a href="/owners/${OWNER}">返回</a>`));
  }
  assert.deepEqual(calls, [], "nothing reaches the database without a reason, a tick and a valid choice");
  for (const back of ["https://evil.example/", "//evil.example", "/reports//x", "reports", "/owners/<x>", ""]) {
    assert.equal((await send(`/reports/${REPORT}/resolve`, { form: change({ resolution: "NONE", back }) })).headers.location, "/reports?ok=1", back);
  }
});

it("tells the operator why the database refused, and hides what went wrong otherwise", async () => {
  const refused = await start({}, new AdminRefusal("这条举报已经被 admin_bob 处理过了,这次没有执行。"));
  const answer = await refused.send(`/reports/${REPORT}/resolve`, { form: change({ resolution: "NONE", back: "/reports?status=SUBMITTED" }) });
  assert.equal(answer.status, 409);
  assert.match(answer.body, /已经被 admin_bob 处理过了/);
  assert.match(answer.body, /<a href="\/reports\?status=SUBMITTED">返回<\/a>/);
  assert.equal((await refused.send("/reports")).status, 409);
  assert.deepEqual(refused.errors, []);

  const broken = await start({}, new Error("connection lost: secret-host:5432"));
  const failed = await broken.send("/reports");
  assert.equal(failed.status, 500);
  assert.ok(!failed.body.includes("secret-host"));
  assert.equal(broken.errors.length, 1);

  assert.equal(explain({ code: "55000", message: "report already reviewed by admin_bob" }) instanceof AdminRefusal, true);
  const said = (code: string, message: string) => (explain({ code, message }) as Error).message;
  assert.equal(said("55000", "report already reviewed by admin_bob"), "这条举报已经被 admin_bob 处理过了,这次没有执行。");
  assert.equal(said("22023", "a reason of 1 to 500 characters is required"), "请填写原因(1 到 500 个字)。");
  assert.equal(said("23514", "new row violates check constraint"), "没有执行:new row violates check constraint");
  assert.equal(said("22007", "invalid input syntax for type timestamp with time zone"), "没有执行:invalid input syntax for type timestamp with time zone");
  assert.match(said("42501", "permission denied for schema companion_admin"), /没有管理权限/);
  const other = new Error("boom");
  assert.equal(explain(other), other);
  assert.equal(explain(Object.assign(new Error("deadlock"), { code: "40P01" })) instanceof AdminRefusal, false);

  const queries: [string, unknown[]][] = [];
  const pool = { query: async (text: string, values: unknown[]) => {
    queries.push([text, values]);
    if (text.includes("owner_suspend")) throw Object.assign(new Error("already suspended"), { code: "55000" });
    return { rows: [{ r: { pending: 0, items: [] } }] };
  } } as unknown as pg.Pool;
  const db = new PgAdminDb(pool);
  assert.deepEqual(await db.call("reports", "SUBMITTED"), { pending: 0, items: [] });
  assert.deepEqual(await db.call("models"), { pending: 0, items: [] });
  await assert.rejects(db.call("owner_suspend", OWNER, true, "why"), (error: unknown) =>
    error instanceof AdminRefusal && error.message === "已经是停用 / 封禁状态,没有重复执行。");
  assert.deepEqual(queries, [["select companion_admin.reports($1) as r", ["SUBMITTED"]], ["select companion_admin.models() as r", []],
    ["select companion_admin.owner_suspend($1, $2, $3) as r", [OWNER, true, "why"]]]);
});

it("lists and searches Owners, and opens one with what can be done about them", async () => {
  const { send, calls } = await start();
  const list = await send("/owners?q=%20alice%20");
  assert.deepEqual(calls, [["owners", "alice"]]);
  assert.match(list.body, /value="alice"/);
  assert.match(list.body, /结果超过 100 个/);
  assert.match(list.body, new RegExp(`<a href="/owners/${OWNER}">a@example.test</a>`));
  assert.match(list.body, /\(没有邮箱\)/);
  assert.ok(!list.body.includes("<script>alert"));
  calls.length = 0;
  await send("/owners");
  assert.deepEqual(calls, [["owners", null]]);
  assert.match((await (await start({ owners: { items: [], more: false } })).send("/owners")).body, /没有找到/);

  calls.length = 0;
  const detail = await send(`/owners/${OWNER}?ok=1`);
  assert.deepEqual(calls, [["owner_detail", OWNER], ["chats", OWNER], ["log", null, OWNER]]);
  assert.ok(!detail.body.includes("<script>alert"));
  const actions = [...detail.body.matchAll(/<form class="act" method="post" action="([^"]+)">/g)].map(m => m[1]);
  assert.deepEqual(actions, [`/owners/${OWNER}/suspend`, `/twins/${TWIN}/suspend`, `/twins/${id(21)}/restore`,
    `/content/post/${POST}/remove`, `/content/post/${id(41)}/restore`, `/content/comment/${COMMENT}/remove`]);
  assert.match(detail.body, /作者已删除/);
  assert.match(detail.body, /本人发的[\s\S]*主人代发/);
  assert.match(detail.body, /<b>Mochi<\/b> <span class="muted">正常<\/span>[\s\S]*<span class="muted">草稿<\/span>/);
  assert.match(detail.body, /社区身份:还没有/);
  assert.match(detail.body, new RegExp(`<a href="/chats/${CHAT}">一对一</a>`));
  assert.match(detail.body, /<a href="\/chats\/[0-9a-f-]+">群聊<\/a>/);
  assert.match(detail.body, new RegExp(`<a href="/log\\?owner=${OWNER}&before=8">更早的记录</a>`));
  assert.match(detail.body, /操作已完成/);
  assert.ok((detail.body.match(new RegExp(`name="back" value="/owners/${OWNER}"`, "g")) ?? []).length === 6);

  const gone = await start({ owner_detail: null });
  assert.equal((await gone.send(`/owners/${OWNER}`)).status, 404);
  const quiet = await start({ owner_detail: { owner: { ...fixtures.owner_detail!.owner, status: "SUSPENDED", email: null, displayName: null }, companions: [], posts: [], comments: [] },
    chats: { items: [] }, log: { items: [], next: null } });
  const empty = await quiet.send(`/owners/${OWNER}`);
  assert.match(empty.body, new RegExp(`action="/owners/${OWNER}/restore"`));
  assert.match(empty.body, /没有家机。[\s\S]*没有会话。[\s\S]*没有记录。/);
  const deleted = await start({ owner_detail: { ...fixtures.owner_detail!, owner: { ...fixtures.owner_detail!.owner, status: "DELETED" } } });
  assert.ok(!(await deleted.send(`/owners/${OWNER}`)).body.includes(`action="/owners/${OWNER}/`));

  calls.length = 0;
  const back = `/owners/${OWNER}`;
  for (const path of [`/owners/${OWNER}/suspend`, `/owners/${OWNER}/restore`, `/twins/${TWIN}/suspend`, `/twins/${TWIN}/restore`,
    `/content/post/${POST}/remove`, `/content/post/${POST}/restore`, `/content/comment/${COMMENT}/remove`, `/content/comment/${COMMENT}/restore`]) {
    const answer = await send(path, { form: change({ back }) });
    assert.deepEqual([answer.status, answer.headers.location], [303, `${back}?ok=1`], path);
  }
  assert.deepEqual(calls, [["owner_suspend", OWNER, true, "because"], ["owner_suspend", OWNER, false, "because"],
    ["twin_suspend", TWIN, true, "because"], ["twin_suspend", TWIN, false, "because"],
    ["content_remove", "POST", POST, "because"], ["content_restore", "POST", POST, "because"],
    ["content_remove", "COMMENT", COMMENT, "because"], ["content_restore", "COMMENT", COMMENT, "because"]]);
  assert.equal((await send(`/content/actor/${POST}/remove`, { form: change() })).status, 404);
});

it("shows a private chat only after a reason is given", async () => {
  const { send, calls } = await start();
  const gate = await send(`/chats/${CHAT}`);
  assert.equal(gate.status, 200);
  assert.match(gate.body, /查看私聊内容需要填写原因/);
  assert.deepEqual(calls, [], "opening the page reads nothing");
  assert.match(gate.body, new RegExp(`name="back" value="/chats/${CHAT}"`));
  for (const reason of ["", "   "]) {
    const refused = await send(`/chats/${CHAT}`, { form: { reason, back: `/chats/${CHAT}` } });
    assert.equal(refused.status, 409);
    assert.match(refused.body, new RegExp(`<a href="/chats/${CHAT}">返回</a>`));
  }
  assert.deepEqual(calls, []);

  const shown = await send(`/chats/${CHAT}`, { form: { reason: " Checking a report " } });
  assert.equal(shown.status, 200);
  assert.deepEqual(calls, [["chat_read", CHAT, "Checking a report", null, null]]);
  assert.ok(!shown.body.includes("<script>alert"));
  const speakers = [...shown.body.matchAll(/<div class="msg"><b>([^<]+)<\/b>/g)].map(m => m[1]);
  assert.deepEqual(speakers, ["Mochi", "主人", "Mochi", "(已离开的家机)"], "oldest first");
  assert.match(shown.body, /\(正在回复\)/);
  assert.match(shown.body, /\(回复失败\) QUOTA/);
  assert.match(shown.body, /本次查看已记入日志,原因:Checking a report/);
  assert.match(shown.body, new RegExp(`name="back" value="/chats/${CHAT}"><input type="hidden" name="reason" value="Checking a report">\\s*` +
    `<input type="hidden" name="at" value="${AT.replace("+", "\\+")}">\\s*<input type="hidden" name="id" value="${id(81)}">`));

  calls.length = 0;
  const last = await start({ chat_read: { chat: { ...fixtures.chat_read.chat, title: "Family", direct: false }, items: [], next: null } });
  const earlier = await last.send(`/chats/${CHAT}`, { form: { reason: "Checking a report", at: AT, id: id(81) } });
  assert.deepEqual(last.calls, [["chat_read", CHAT, "Checking a report", AT, id(81)]]);
  assert.match(earlier.body, /私聊:Family/);
  assert.match(earlier.body, /已经是最早的消息[\s\S]*没有消息/);
  assert.match((await (await start({ chat_read: { ...fixtures.chat_read, chat: { ...fixtures.chat_read.chat, direct: false } } }))
    .send(`/chats/${CHAT}`, { form: { reason: "why" } })).body, /私聊:群聊/);
});

it("shows model switches, the quota and what was spent, and changes only what the catalog names", async () => {
  const { send, calls } = await start();
  const page = await send("/models");
  assert.deepEqual(calls, [["models"], ["spend", "2026-11-17", "2026-11-23"]], "the last seven days by default");
  const states = [...page.body.matchAll(/<td>claude\/claude-big<\/td><td><span class="tag ([a-z]*)">([^<]+)</g)].map(m => [m[1], m[2]]);
  assert.deepEqual(states, [["", "开"]]);
  assert.match(page.body, /claude\/claude-small<\/td><td><span class="tag bad">关\(模型关闭\)/);
  assert.match(page.body, /other\/other-chat<\/td><td><span class="tag bad">关\(厂商关闭\)/);
  assert.deepEqual([...page.body.matchAll(/<option value="((?:ALL|PROVIDER|MODEL):[^"]+)"/g)].map(m => m[1]),
    ["ALL:*", "PROVIDER:claude", "PROVIDER:other", "MODEL:claude/claude-big", "MODEL:claude/claude-small", "MODEL:other/other-chat"]);
  assert.match(page.body, /每天 200 次调用、1\.00 USD/);
  assert.match(page.body, /合计:12 次调用,3\.45 USD/);
  assert.match(page.body, new RegExp(`<a href="/owners/${OWNER}">Mochi</a></td><td>12</td><td>3.45 USD`));
  assert.ok(!page.body.includes("<script>alert"));

  const allOff = await start({ models: { ...fixtures.models, switches: [{ scope: "ALL", key: "*", enabled: false, note: "stop", updatedAt: AT }] },
    spend: { from: "2026-11-01", to: "2026-11-02", totals: [], byDay: [], byCompanion: [] } });
  const stopped = await allOff.send("/models?from=2026-11-01&to=2026-11-02&ok=1");
  assert.deepEqual(allOff.calls[1], ["spend", "2026-11-01", "2026-11-02"]);
  assert.equal((stopped.body.match(/关\(全部关闭\)/g) ?? []).length, 3);
  assert.match(stopped.body, /这段时间没有模型调用/);
  assert.match(stopped.body, /操作已完成/);
  const noSwitches = await start({ models: { ...fixtures.models, switches: [] } });
  assert.ok(!(await noSwitches.send("/models?from=yesterday&to=2026-11-10")).body.includes("最近一次的原因"));
  assert.deepEqual(noSwitches.calls[1], ["spend", "2026-11-04", "2026-11-10"], "a date that is not a date falls back");
  for (const range of ["from=2026-02-31&to=2026-13-01", "from=2026-02-30&to=0000-00-00", "to=2026-11-23T10:00"]) {
    const impossible = await start();
    assert.equal((await impossible.send(`/models?${range}`)).status, 200, range);
    assert.deepEqual(impossible.calls[1], ["spend", "2026-11-17", "2026-11-23"], "a day that does not exist falls back too");
  }

  calls.length = 0;
  const back = "/models?from=2026-11-17&to=2026-11-23";
  const switched = await send("/models/switch", { form: change({ target: "MODEL:claude/claude-big", enabled: "off", back }) });
  assert.deepEqual([switched.status, switched.headers.location], [303, `${back}&ok=1`]);
  await send("/models/switch", { form: change({ target: "ALL:*", enabled: "on" }) });
  await send("/models/switch", { form: change({ target: "PROVIDER:other", enabled: "off" }) });
  assert.deepEqual(calls, [["model_switch_set", "MODEL", "claude/claude-big", false, "because"], ["model_switch_set", "ALL", "*", true, "because"],
    ["model_switch_set", "PROVIDER", "other", false, "because"]]);
  calls.length = 0;
  for (const form of [change({ target: "MODEL:claude/unknown", enabled: "off" }), change({ target: "PROVIDER:nobody", enabled: "off" }),
    change({ target: "ALL:*" }), change({ target: "ALL:*", enabled: "maybe" }), change({ enabled: "off" })]) {
    assert.equal((await send("/models/switch", { form })).status, 409);
  }
  for (const form of [change({ calls: "150" }), change({ calls: "-1", cents: "80" }), change({ calls: "1.5", cents: "80" }), change({ calls: "150", cents: "lots" })]) {
    assert.equal((await send("/models/quota", { form })).status, 409);
  }
  assert.deepEqual(calls, []);
  assert.equal((await send("/models/quota", { form: change({ calls: "150", cents: "80" }) })).status, 303);
  assert.deepEqual(calls, [["chat_quota_set", 150, 80, "because"]]);
});

it("pages through the log, for everyone or one Owner", async () => {
  const { send, calls } = await start();
  const all = await send("/log");
  assert.deepEqual(calls, [["log", null, null]]);
  assert.match(all.body, /<td>admin_alice<\/td><td>移除帖子<\/td>/);
  assert.match(all.body, /<td>admin_bob<\/td><td>模型开关<\/td>\s*<td>全部模型 \*<\/td>/);
  assert.match(all.body, new RegExp(`<a href="/owners/${OWNER}">帖子</a>`));
  assert.match(all.body, /<a href="\/log\?before=8">更早的记录<\/a>/);
  assert.ok(!all.body.includes("<script>alert"));
  calls.length = 0;
  const one = await send(`/log?before=8&owner=${OWNER}`);
  assert.deepEqual(calls, [["log", 8, OWNER]]);
  assert.match(one.body, new RegExp(`<a href="/log\\?before=8&amp;owner=${OWNER}">更早的记录</a>`));
  assert.match(one.body, /看全部/);
  calls.length = 0;
  await send("/log?before=abc&owner=nobody");
  assert.deepEqual(calls, [["log", null, null]]);
  const empty = await start({ log: { items: [], next: null } });
  const none = await empty.send("/log");
  assert.match(none.body, /没有记录/);
  assert.ok(!none.body.includes("更早的记录"));
});
