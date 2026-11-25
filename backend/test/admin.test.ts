import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { after, it } from "node:test";
import type pg from "pg";
import { AdminRefusal, PgAdminDb, explain, type AdminDb, type AdminFunction } from "../src/admin/db.ts";
import type { Activity, ChatList, ChatPage, Costs, LogPage, SystemInfo, Models, OwnerDetail, OwnerList, Report, ReportQueue, Spend } from "../src/admin/pages.ts";
import type { FlyAccess } from "../src/admin/fly.ts";
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
      { id: id(85), companionId: null, body: null, action: "HUG", status: "SENT", failure: null, createdAt: AT },
      { id: id(84), companionId: COMPANION, body: null, status: "PENDING", failure: null, createdAt: AT }],
    next: { at: AT, id: id(81) },
  } satisfies ChatPage as ChatPage,
  features: [{ key: "GROUP_CHAT_CREATE", enabled: false, updatedAt: AT }, { key: "GROUP_CHAT_SEND", enabled: true, updatedAt: AT }],
  models: { switches: [{ scope: "MODEL", key: "claude/claude-small", enabled: false, note: NASTY, updatedAt: AT },
    { scope: "PROVIDER", key: "other", enabled: false, note: "outage", updatedAt: AT }, { scope: "ALL", key: "*", enabled: true, note: "back on", updatedAt: AT }],
    quota: { dailyCalls: 200, dailyCostMinor: 100, currency: "USD", updatedAt: AT },
    cap: { enabled: true, dailyCostMinor: 2000, currency: "USD", spentTodayMinor: 345, updatedAt: AT },
    wallet: { enabled: false, welcomeCredits: 1000, creditsPerCent: 10, backgroundFloor: 200, updatedAt: AT } } satisfies Models as Models,
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
async function start(returns: Returned = {}, failure?: unknown, fly?: FlyAccess, more: Partial<Parameters<typeof createAdminServer>[0]> = {}) {
  const { db, calls } = fakeDb(returns, failure);
  const errors: unknown[] = [];
  const server = createAdminServer({ db, token: TOKEN, catalog, timeZone: "UTC", now: () => new Date("2026-11-23T12:00:00Z"), onError: e => errors.push(e),
    ...(fly === undefined ? {} : { fly }), ...more } as Parameters<typeof createAdminServer>[0]);
  servers.push(server);
  const port = await new Promise<number>(resolve => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
  const send = (path: string, sent: Sent = {}) => new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string; raw: Buffer }>((resolve, reject) => {
    const body = sent.body ?? (sent.form === undefined ? undefined : new URLSearchParams(sent.form).toString());
    const req = httpRequest({ host: "127.0.0.1", port, path, method: sent.method ?? (body === undefined ? "GET" : "POST"), headers: {
      Host: sent.host ?? `127.0.0.1:${port}`,
      ...(sent.cookie === null ? {} : { Cookie: sent.cookie ?? `other=1; admin_console=${TOKEN}` }),
      ...(body === undefined && sent.origin === undefined || sent.origin === "" ? {} : { Origin: sent.origin ?? `http://127.0.0.1:${port}` }),
      ...(body === undefined ? {} : { "Content-Type": sent.type ?? "application/x-www-form-urlencoded" }),
    } }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(chunk as Buffer));
      response.on("end", () => { const raw = Buffer.concat(chunks); resolve({ status: response.statusCode!, headers: response.headers, body: raw.toString("utf8"), raw }); });
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
  assert.match(empty.body, /没有会话。[\s\S]*没有家机。[\s\S]*没有记录。/);
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
  assert.deepEqual(speakers, ["Mochi", "主人", "主人", "Mochi", "(已离开的家机)"], "oldest first");
  assert.match(shown.body, /\(正在回复\)/);
  assert.match(shown.body, /\(小家动作:抱抱\)/);
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

it("shows each model company: whether the API server has its key, and its balance", async () => {
  const asked: [string, string][] = [];
  const get = (async (url: string, init: RequestInit) => {
    asked.push([url, (init.headers as Record<string, string>).Authorization!]);
    if (url.endsWith("/secrets")) return Response.json({ secrets: [{ name: "CLAUDE_KEY", digest: "x", created_at: AT, updated_at: "2026-11-25T08:00:00Z" }] });
    return Response.json({ is_available: false, balance_infos: [{ currency: "CNY", total_balance: "110.00", granted_balance: "10.00", topped_up_balance: "100.00" }] });
  }) as typeof fetch;
  const fly: FlyAccess = { token: "fly-ro", apps: ["the-api", "the-admin"], fetch: get };
  const vendors = [{ key: "claude", keyEnv: "CLAUDE_KEY", apiKey: undefined }, { key: "other", keyEnv: "OTHER_KEY", apiKey: undefined },
    { key: "deepseek", keyEnv: "DEEPSEEK_API_KEY", apiKey: "sk-console" }];
  const page = (await (await start({}, undefined, fly, { vendors, fetch: get })).send("/models")).body;
  assert.deepEqual(asked, [["https://api.machines.dev/v1/apps/the-api/secrets", "Bearer fly-ro"], ["https://api.deepseek.com/user/balance", "Bearer sk-console"]],
    "only names of the API server's secrets; the balance with the console's own copy of the key");
  assert.match(page, /<td>claude<\/td><td>Big、Small<\/td>\s*<td><span class="tag">已设置<\/span> <span class="muted">更新于 2026\/11\/25 08:00:00/);
  assert.match(page, /<td><span class="tag bad">没有<\/span> <span class="muted">OTHER_KEY<\/span><\/td>/);
  assert.match(page, /这家没有查余额的接口,去它的控制台看。/);
  assert.match(page, /<b>¥110\.00<\/b> <span class="tag bad">余额不够,调用会失败<\/span> <span class="muted">\(其中赠送 ¥10\.00\)/);
  const blind = (await (await start({}, undefined, undefined, { vendors })).send("/models")).body;
  assert.match(blind, /看不到:后台没有 Fly 只读令牌/);
  const noCopy = (await (await start({}, undefined, fly, { vendors: [{ ...vendors[2]!, apiKey: undefined }], fetch: get })).send("/models")).body;
  assert.match(noCopy, /后台没有这家的 Key\(DEEPSEEK_API_KEY\),查不了余额。/);
  const broken = (await (await start({}, undefined, fly, { vendors, fetch: (async () => new Response("no", { status: 401 })) as typeof fetch })).send("/models")).body;
  assert.match(broken, /读不到余额:DeepSeek 回答 401/);
});

it("shows model switches and the quota, and changes only what the catalog names", async () => {
  const { send, calls } = await start();
  const page = await send("/models");
  assert.deepEqual(calls, [["models"], ["features"]], "what was spent is on the costs page");
  const states = [...page.body.matchAll(/<td>claude\/claude-big<\/td><td><span class="tag ([a-z]*)">([^<]+)</g)].map(m => [m[1], m[2]]);
  assert.deepEqual(states, [["", "开"]]);
  assert.match(page.body, /claude\/claude-small<\/td><td><span class="tag bad">关\(模型关闭\)/);
  assert.match(page.body, /other\/other-chat<\/td><td><span class="tag bad">关\(厂商关闭\)/);
  // Each switch is one click: a form that posts the other way, with the reason filled in.
  const switches = (path: string, field: string) => [...page.body.matchAll(new RegExp(`action="${path}">[^]*?name="${field}" value="([^"]+)">\\s*`
    + `<input type="hidden" name="enabled" value="(on|off)"><input type="hidden" name="reason" value="([^"]+)">\\s*`
    + `<input type="hidden" name="confirm" value="yes"><button class="switch ([a-z]*)" role="switch" aria-checked="(true|false)"`, "g"))].map(m => m.slice(1));
  assert.deepEqual(switches("/models/switch", "target"), [
    ["ALL:*", "off", "点开关:关掉全部平台模型", "on", "true"], ["PROVIDER:claude", "off", "点开关:关掉厂商 claude", "on", "true"],
    ["PROVIDER:other", "on", "点开关:打开厂商 other", "", "false"],
    ["MODEL:claude/claude-big", "off", "点开关:关掉模型 Big(claude/claude-big)", "on", "true"],
    ["MODEL:claude/claude-small", "on", "点开关:打开模型 Small(claude/claude-small)", "", "false"],
    ["MODEL:other/other-chat", "off", "点开关:关掉模型 Cheap(other/other-chat)", "on", "true"]]);
  assert.deepEqual(switches("/models/feature", "key"), [["GROUP_CHAT_CREATE", "on", "点开关:打开新建群聊", "", "false"],
    ["GROUP_CHAT_SEND", "off", "点开关:关掉在已有群聊里发消息", "on", "true"]]);
  assert.ok(!page.body.includes("<select"), "no drop-downs left on the page");
  assert.match(page.body, /每天 200 次调用、1\.00 USD/);
  assert.ok(!page.body.includes("花费上限</h2>"), "the spend cap lives on the costs page");
  assert.match(page.body, /aria-label="主人积分钱包" title="点一下打开"><\/button>关\(只按每个家机每天的免费额度限制\)<\/form><\/div>\s*<p>新主人送 1000 积分/);
  assert.match(page.body, /<a href="\/costs" class="">花费<\/a>/);
  assert.ok(!page.body.includes("<script>alert"));

  const allOff = await start({ models: { ...fixtures.models, switches: [{ scope: "ALL", key: "*", enabled: false, note: "stop", updatedAt: AT }] } });
  const stopped = await allOff.send("/models?ok=1");
  assert.equal((stopped.body.match(/关\(全部关闭\)/g) ?? []).length, 3);
  assert.match(stopped.body, /操作已完成/);
  const noSwitches = await start({ models: { ...fixtures.models, switches: [] } });
  assert.ok(!(await noSwitches.send("/models")).body.includes("最近一次的原因"));

  calls.length = 0;
  const back = "/models";
  const switched = await send("/models/switch", { form: change({ target: "MODEL:claude/claude-big", enabled: "off", back }) });
  assert.deepEqual([switched.status, switched.headers.location], [303, "/models?ok=1"]);
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
  calls.length = 0;
  for (const form of [change({ key: "GROUP_CHAT_SEND" }), change({ key: "NOPE", enabled: "on" }), change({ enabled: "on" })]) {
    assert.equal((await send("/models/feature", { form })).status, 409);
  }
  assert.equal((await send("/models/feature", { form: change({ key: "GROUP_CHAT_CREATE", enabled: "on" }) })).status, 303);
  assert.deepEqual(calls, [["feature_set", "GROUP_CHAT_CREATE", true, "because"]]);
  calls.length = 0;
  const OWNER_ID = "00000000-0000-4000-8000-000000000001";
  for (const [path, form] of [
    ["/costs/cap", change({ enabled: "maybe", dollars: "20" })], ["/costs/cap", change({ enabled: "on", dollars: "-1" })],
    ["/costs/cap", change({ enabled: "on", dollars: "1.234" })],
    ["/models/wallet", change({ enabled: "on", welcome: "1000", rate: "0", floor: "200" })],
    ["/models/wallet", change({ enabled: "on", welcome: "x", rate: "10", floor: "200" })],
    ["/models/credit", change({ owner: "nobody", credits: "100" })], ["/models/credit", change({ owner: OWNER_ID, credits: "0" })],
    ["/models/credit", change({ owner: OWNER_ID, credits: "1.5" })],
    ["/models/welcome", change({ welcome: "1000" })], ["/models/welcome", change({ enabled: "on", welcome: "0" })],
    ["/models/welcome", change({ enabled: "on" })],
  ] as const) assert.equal((await send(path, { form })).status, 409, `${path} ${JSON.stringify(form)}`);
  assert.deepEqual(calls, []);
  await send("/costs/cap", { form: change({ enabled: "off", dollars: "25" }) });
  await send("/models/wallet", { form: change({ enabled: "on", welcome: "500", rate: "10", floor: "0" }) });
  await send("/models/credit", { form: change({ owner: OWNER_ID, credits: "-50" }) });
  assert.deepEqual(calls, [["spend_cap_set", false, 2500, "because"], ["wallet_policy_set", true, 500, 10, 0, "because"],
    ["wallet_adjust", OWNER_ID, -50, "because"]]);
  calls.length = 0;
  // The gift alone: the wallet's other rules are read and kept.
  await send("/models/welcome", { form: change({ enabled: "off", welcome: "1000" }) });
  await send("/models/welcome", { form: change({ enabled: "on", welcome: "300" }) });
  assert.deepEqual(calls, [["models"], ["wallet_policy_set", false, 0, 10, 200, "because"], ["models"], ["wallet_policy_set", false, 300, 10, 200, "because"]]);
  assert.match(page.body, /新人送积分<\/div><div class="big">开<\/div>\s*<div class="muted">每个新主人 1,000 积分\(钱包关着,暂时不送\)/);
  const noGift = await (await start({ models: { ...fixtures.models, wallet: { ...fixtures.models.wallet, welcomeCredits: 0 } } })).send("/models");
  assert.match(noGift.body, /title="点一下打开"><\/button>关:新主人不送积分<\/form>/);
  assert.match(noGift.body, /action="\/models\/welcome"><input type="hidden" name="back" value="\/models"><input type="hidden" name="welcome" value="1000">\s*<input type="hidden" name="enabled" value="on">/);
  assert.ok(!noGift.body.includes("改送多少"), "the amount is changed once the gift is on");
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

it("on the tailnet, lets in only its own name, people on the list (as their own login) and its own forms", async () => {
  const alice = fakeDb(), bob = fakeDb();
  assert.throws(() => createAdminServer({ tailnet: { hostname: "Bad.Name", operators: new Map([["a@x.test", alice.db]]) }, catalog }));
  assert.throws(() => createAdminServer({ tailnet: { hostname: "companion-admin", operators: new Map() }, catalog }));
  const server = createAdminServer({ tailnet: { hostname: "companion-admin", operators: new Map([["alice@x.test", alice.db], ["bob@x.test", bob.db]]) },
    catalog, timeZone: "UTC" });
  servers.push(server);
  const port = await new Promise<number>(resolve => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
  const send = (path: string, headers: Record<string, string>, form?: Record<string, string>) => new Promise<{ status: number; location: string | undefined; body: string }>((resolve, reject) => {
    const body = form === undefined ? undefined : new URLSearchParams(form).toString();
    const req = httpRequest({ host: "127.0.0.1", port, path, method: body === undefined ? "GET" : "POST",
      headers: { ...headers, ...(body === undefined ? {} : { "Content-Type": "application/x-www-form-urlencoded" }) } }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(chunk as Buffer));
      response.on("end", () => resolve({ status: response.statusCode!, location: response.headers.location, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(body);
  });
  const as = (login: string, host = "companion-admin") => ({ Host: host, "Tailscale-User-Login": login });

  for (const host of ["evil.example", "companion-admin.evil.example", `127.0.0.1:${port}`, "companion-admin:8080", "xcompanion-admin"]) {
    assert.deepEqual([(await send("/reports", as("alice@x.test", host))).status], [403], host);
  }
  for (const headers of [{ Host: "companion-admin" }, as("mallory@x.test"), as("")]) {
    const refused = await send("/reports", headers);
    assert.deepEqual([refused.status, /不在管理员名单里/.test(refused.body)], [403, true]);
  }
  assert.equal((await send(`/?token=${TOKEN}`, { Host: "companion-admin", Cookie: `admin_console=${TOKEN}` })).status, 403, "no token way in on the tailnet");
  assert.equal(alice.calls.length + bob.calls.length, 0, "nothing is read for someone not on the list");

  assert.equal((await send("/reports", as("Alice@X.test"))).status, 200, "the login is matched without case");
  assert.equal((await send("/reports", as("bob@x.test", "companion-admin.tail1234.ts.net"))).status, 200);
  assert.deepEqual([alice.calls.length, bob.calls.length], [1, 1], "each person reads through their own login");

  for (const origin of ["http://evil.example", "http://companion-admin.tail1234.ts.net", "null"]) {
    assert.equal((await send(`/owners/${OWNER}/suspend`, { ...as("alice@x.test"), Origin: origin }, change())).status, 403, origin);
  }
  const done = await send(`/owners/${OWNER}/suspend`, { ...as("bob@x.test"), Origin: "http://companion-admin" }, change());
  assert.deepEqual([done.status, done.location, bob.calls.at(-1)], [303, "/reports?ok=1", ["owner_suspend", OWNER, true, "because"]]);
  assert.equal(alice.calls.length, 1, "Bob's change went through Bob's login only");
});

it("shows one month of everything the platform paid for, and changes the fixed bills and the voice prices", async () => {
  const costs: Costs = {
    month: "2026-11", from: "2026-11-01", to: "2026-11-30",
    totals: { modelCents: 345, hearCents: 0.4, speakPoints: 120000, speakOverCents: 200, fixedCents: 3500 },
    prices: { planPoints: 100000, speakCentsPerMillion: 10000, hearCentsPerHour: 38, updatedAt: AT },
    fixed: [{ item: "Fly 服务器", cents: 3000, note: NASTY, updatedAt: AT }, { item: "MiniMax 语音包月(Starter)", cents: 500, note: null, updatedAt: AT }],
    days: [{ day: "2026-11-23", modelCents: 345, modelCalls: 12, hearSeconds: 38, hears: 4, hearCents: 0.4, speakPoints: 120000, speaks: 900 }],
    models: fixtures.spend,
  };
  const { send, calls } = await start({ costs });
  const page = await send("/costs");
  assert.equal(page.status, 200);
  assert.deepEqual(calls, [["costs", "2026-11-01"], ["models"]], "this month (UTC) by default, with today's cap");
  assert.ok(!page.body.includes("http-equiv") && !page.body.includes("自动刷新"), "the page is read again only on 刷新");
  assert.match(page.body, /数据时间 2026\/11\/23 12:00:00<\/span><a class="btn" href="\/costs\?month=2026-11">刷新<\/a>/);
  assert.match(page.body, /今天\(UTC\)平台模型已花,含进行中的调用<\/div><div class="big">3\.45 USD<\/div>/);
  assert.match(page.body, /每天上限 20\.00 USD · 用了 17%/);
  assert.match(page.body, /<summary>改金额<\/summary><form class="act" method="post" action="\/costs\/cap"><input type="hidden" name="back" value="\/costs\?month=2026-11">/);
  assert.match(page.body, /name="dollars" required inputmode="decimal" size="6" value="20">/);
  assert.match(page.body, /<a href="\/costs" class="on">花费<\/a>/);
  assert.match(page.body, /总花费<\/div><div class="big">\$40\.45<\/div>/, "models + recognition + over the plan + fixed");
  assert.match(page.body, /按用量的 \$5\.45 \+ 固定月费 \$35\.00/);
  const vendor = (name: string) => page.body.split('<div class="card vendor">').find(card => card.includes(`<b>${name}</b>`)) ?? "";
  assert.deepEqual([...page.body.matchAll(/<div class="card vendor"><div class="vhead"><span><i [^>]*><\/i><b>([^<]+)<\/b><\/span>\s*<span class="muted">占 ([^<]+)<\/span><\/div><div class="big">([^<]+)</g)]
    .map(m => [m[1], m[2], m[3]]), [["Fly.io", "74%", "$30.00"], ["MiniMax", "17%", "$7.00"], ["claude", "9%", "$3.45"], ["Supabase", "0%", "$0.00"]],
    "each company, biggest first; a fixed bill goes to the company its name says");
  assert.match(vendor("MiniMax"), /语音转文字\(按时长\)<\/td><td class="num">&lt; \$0\.01</, "a little that is not nothing");
  assert.match(vendor("MiniMax"), /MiniMax 语音包月\(Starter\) <span class="tag">固定月费<\/span><\/td><td class="num">\$5\.00/);
  assert.match(vendor("MiniMax"), /已用 120,000 \/ 100,000\(120%\)/);
  assert.match(vendor("MiniMax"), /<span class="over" style="width:100%">/);
  assert.match(vendor("MiniMax"), /已经超出包月/);
  assert.match(vendor("claude"), /<b>claude-big<\/b><b>\$3\.45<\/b>[\s\S]*调用 12 次 · 未成功 1 · 输入 9,000 token · 输出 700 token/);
  assert.match(vendor("Supabase"), /免费版没有月费/);
  assert.match(vendor("Fly.io"), /href="https:\/\/fly\.io\/dashboard\/personal\/billing" target="_blank" rel="noreferrer">去 Fly\.io 看账单/);
  assert.match(vendor("MiniMax"), /去 MiniMax 看账单 ↗/);
  assert.match(vendor("Fly.io"), /<a href="\/system">主机状态/);
  assert.match(vendor("Fly.io"), /估算不出:后台还没有 Fly 只读令牌/, "the running month guesses Fly's bill from the servers");
  assert.match(page.body, /<title>2026-11-23\n合计:\$3\.45\nMiniMax:&lt; \$0\.01\nclaude:\$3\.45<\/title>/, "a day's hover text");
  assert.match(page.body, /<td>2026-11-23<\/td><td class="num">\$3\.45<\/td><td class="num">12<\/td>/);
  assert.match(page.body, /38 秒 \/ 4 条/);
  assert.match(page.body, new RegExp(`<a href="/owners/${OWNER}">Mochi</a></td><td class="num">12</td><td class="num">\\$3\\.45<`));
  assert.match(page.body, /href="\/costs\/export\.xlsx\?month=2026-11">导出 xlsx/);
  assert.ok(!page.body.includes("<script>alert"));
  assert.deepEqual([...page.body.matchAll(/method="post" action="([^"]+)"/g)].map(m => m[1]), ["/costs/cap", "/costs/cap"],
    "the costs page changes only the cap; bills and prices are on the settings page");
  const settings = await send("/costs/settings");
  assert.deepEqual(calls.at(-1), ["costs", "2026-11-01"]);
  assert.match(settings.body, /<td>Fly 服务器<\/td><td>Fly\.io<\/td><td class="num">\$30\.00<\/td>/);
  assert.ok(!settings.body.includes("<script>alert"));
  assert.match(settings.body, /size="8" value="100">/, "the price per million characters in dollars");
  assert.match(settings.body, /size="8" value="0\.38">/);
  assert.match(settings.body, /name="back" value="\/costs\/settings"/);
  assert.match(settings.body, /<a href="\/costs" class="on">花费<\/a>/);

  const quiet = await start({ costs: { ...costs, month: "2026-10", days: [], fixed: [], models: { ...fixtures.spend, byDay: [], byCompanion: [] },
    totals: { modelCents: 0, hearCents: 0, speakPoints: 10, speakOverCents: 0, fixedCents: 0 } } });
  const october = await quiet.send("/costs?month=2026-10&ok=1");
  assert.deepEqual(quiet.calls, [["costs", "2026-10-01"]], "a past month: no cap, no reloading");
  assert.ok(!october.body.includes("http-equiv") && !october.body.includes("自动刷新"));
  assert.match(october.body, /这个月总花费<\/div><div class="big">\$0\.00/);
  assert.match(october.body, /这个月还没有按用量的花费/);
  assert.ok(!october.body.includes("估算"), "a past month has no estimate: the servers then are not known");
  assert.ok(!october.body.includes("card vendor\"><div class=\"vhead\"><span><i style=\"background:#2a78d6"), "no model company without calls");
  assert.match((await quiet.send("/costs/settings")).body, /还没有填/);
  assert.match(october.body, /操作已完成/);
  for (const month of ["2026-13", "nope", "2026-1"]) {
    const fallback = await start({ costs });
    await fallback.send(`/costs?month=${month}`);
    assert.deepEqual(fallback.calls, [["costs", "2026-11-01"], ["models"]], month);
  }

  calls.length = 0;
  for (const form of [change({ item: "", dollars: "5" }), change({ item: "Fly", dollars: "-1" }), change({ item: "Fly", dollars: "1.234" }),
    change({ item: "Fly" }), change({ item: "Fly", dollars: "five" })]) {
    assert.equal((await send("/costs/fixed", { form })).status, 409, JSON.stringify(form));
  }
  for (const form of [change({ points: "1.5", speak: "100", hear: "0.38" }), change({ points: "100000", speak: "-1", hear: "0.38" }),
    change({ points: "100000", speak: "100", hear: "0.123456" })]) {
    assert.equal((await send("/costs/prices", { form })).status, 409, JSON.stringify(form));
  }
  assert.deepEqual(calls, []);
  const saved = await send("/costs/fixed", { form: change({ item: " Fly 服务器 ", dollars: "12.5", note: "两个应用", back: "/costs?month=2026-11" }) });
  assert.deepEqual([saved.status, saved.headers.location], [303, "/costs?month=2026-11&ok=1"]);
  await send("/costs/fixed", { form: change({ item: "Fly 服务器", dollars: "删除" }) });
  await send("/costs/prices", { form: change({ points: "300000", speak: "60", hear: "0.38" }) });
  assert.deepEqual(calls, [["fixed_cost_set", "Fly 服务器", 1250, "两个应用", "because"], ["fixed_cost_set", "Fly 服务器", null, "", "because"],
    ["voice_prices_set", 300000, 6000, 38, "because"]]);
});

it("shows a year as a ledger, and exports a month or a year as an Excel file", async () => {
  const month: Costs = {
    month: "2026-11", from: "2026-11-01", to: "2026-11-30",
    totals: { modelCents: 345, hearCents: 0, speakPoints: 0, speakOverCents: 0, fixedCents: 500 },
    prices: { planPoints: 100000, speakCentsPerMillion: 10000, hearCentsPerHour: 38, updatedAt: AT },
    fixed: [{ item: "MiniMax 语音包月", cents: 500, note: NASTY, updatedAt: AT }],
    days: [{ day: "2026-11-23", modelCents: 345, modelCalls: 12, hearSeconds: 0, hears: 0, hearCents: 0, speakPoints: 0, speaks: 0 }],
    models: fixtures.spend,
  };
  const { send, calls } = await start({ costs: month });
  const year = await send("/costs?year=2026");
  assert.equal(year.status, 200);
  assert.deepEqual(calls.map(c => c[1]), Array.from({ length: 11 }, (_, i) => `2026-${String(i + 1).padStart(2, "0")}-01`), "January up to this month");
  assert.match(year.body, /2026 年到今天总花费<\/div><div class="big">\$92\.95<\/div>/);
  assert.match(year.body, /<th class="num">MiniMax<\/th><th class="num">claude<\/th><th class="num">合计<\/th>/);
  assert.match(year.body, /<td><b>全年<\/b><\/td><td class="num"><b>\$55\.00<\/b><\/td><td class="num"><b>\$37\.95<\/b><\/td>/);
  assert.match(year.body, /href="\/costs\/export\.xlsx\?year=2026"/);
  assert.ok(!year.body.includes("http-equiv") && !year.body.includes("2027 →"));
  for (const [asked, months] of [["2025", 12], ["1999", 11], ["2099", 11], ["x", 11]] as const) {
    const other = await start({ costs: month });
    await other.send(`/costs?year=${asked}`);
    assert.equal(other.calls.length, months, asked);
  }

  calls.length = 0;
  const file = await send("/costs/export.xlsx?month=2026-11");
  assert.deepEqual(calls, [["costs", "2026-11-01"]]);
  assert.equal(file.headers["content-type"], "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  assert.match(String(file.headers["content-disposition"]), /^attachment; filename="export\.xlsx"; filename\*=UTF-8''%E8%8A%B1%E8%B4%B9-2026-11\.xlsx$/);
  assert.equal(file.raw.subarray(0, 4).toString("hex"), "504b0304", "a zip");
  assert.equal(file.raw.readUInt32LE(file.raw.length - 22), 0x06054b50, "with its directory at the end");
  const text = file.raw.toString("utf8");
  for (const sheet of ["按月合计", "账本", "每天", "模型"]) assert.ok(text.includes(`<sheet name="${sheet}"`), sheet);
  assert.ok(text.includes('<t xml:space="preserve">MiniMax 语音包月</t></is></c><c r="D2" t="inlineStr"><is><t xml:space="preserve">固定月费</t></is></c><c r="E2"><v>5</v>'));
  assert.ok(text.includes("&lt;script&gt;") && !text.includes("<script>"), "text is escaped in the sheet");
  assert.ok(text.includes('<c r="H2"><v>3.45</v></c>'), "model cost in dollars");
  calls.length = 0;
  await send("/costs/export.xlsx?year=2025");
  assert.equal(calls.length, 12);
});

it("shows how much the App is used, and the database and the servers", async () => {
  const day = (d: string, n: number) => ({ day: d, newOwners: n, chatters: n + 1, ownerMessages: 10 * n, replies: 9 * n, failed: n, voiceIn: n, voiceOut: 2 * n,
    posts: n, aiPosts: 1, comments: 3, creditsSpent: 100 * n, creditsBought: 0 });
  const unused = (d: string) => ({ ...day(d, 0), chatters: 0, aiPosts: 0, comments: 0 });
  const activity: Activity = { month: "2026-11", from: "2026-11-01", to: "2026-11-30", owners: 25, companions: 31, chatters: 12,
    days: [unused("2026-11-21"), day("2026-11-22", 1), day("2026-11-23", 2)] };
  const { send, calls } = await start({ activity });
  const stats = await send("/stats");
  assert.deepEqual(calls, [["activity", "2026-11-01"]]);
  assert.match(stats.body, /<a href="\/stats" class="on">运营数据<\/a>/);
  assert.match(stats.body, /本月聊天的人<\/div><div class="big">12<\/div><div class="muted">新注册 3 人/);
  assert.match(stats.body, /今天聊天的人<\/div><div class="big">3<\/div><div class="muted">主人发 20 条 · 家机回 18 条/);
  assert.match(stats.body, /消息<\/div><div class="big">57<\/div><div class="muted">主人发 30 · 家机回 27 · 失败 3/);
  assert.match(stats.body, /<title>2026-11-23\n聊天的人:3\n新注册:2<\/title>/);
  assert.ok(!stats.body.includes("2026-11-21"), "the days before anyone used the App are left out");
  const past = await (await start({ activity: { ...activity, month: "2026-10", days: [unused("2026-10-01")] } })).send("/stats?month=2026-10");
  assert.ok(!past.body.includes("今天聊天的人") && past.body.includes("这个月还没有任何使用"));

  const system: SystemInfo = { databaseBytes: 400 * 1024 * 1024, connections: 12, maxConnections: 60, startedAt: AT, version: "17.4",
    tables: [{ name: "companion_private.chat_messages", bytes: 1024 * 1024, rows: 5000 }, { name: "public.owners", bytes: 8192, rows: null }] };
  const without = await (await start({ system })).send("/system");
  assert.match(without.body, /数据库空间<\/div><div class="big">400\.0 MB<\/div><div class="bar"><span class="" style="width:80%"><\/span><\/div>/);
  assert.match(without.body, /<div class="card warn"><div class="muted">数据库空间/, "80 % full is a warning");
  assert.match(without.body, /12 \/ 60/);
  assert.match(without.body, /<td>companion_private\.chat_messages<\/td><td class="num">1\.0 MB<\/td><td class="num">5,000<\/td>/);
  assert.match(without.body, /<td class="num">—<\/td>/);
  assert.match(without.body, /还没有 Fly 只读令牌/);

  const asked: [string, string][] = [];
  const fly = (answer: (app: string) => Response): FlyAccess => ({ token: "fly-ro", apps: ["api", "admin"], fetch: (async (url: string, init: RequestInit) => {
    asked.push([url, (init.headers as Record<string, string>).Authorization!]);
    const [app, what] = url.split("/apps/")[1]!.split("/");
    return what === "volumes" ? Response.json(app === "admin" ? [{ id: "v1", name: "data", region: "nrt", size_gb: 1 }] : []) : answer(app!);
  }) as typeof fetch });
  const machines = (app: string) => Response.json(app === "api" ? [{ id: "m1", name: "api-1", state: "started", region: "nrt",
    config: { guest: { cpus: 1, memory_mb: 512 } }, image_ref: { tag: "deployment-7" }, updated_at: AT,
    events: [{ type: "start", timestamp: 2 }, { type: "exit", timestamp: 1_764_000_000_000, request: { exit_event: { exit_code: 137, oom_killed: true } } },
      { type: "exit", timestamp: 5 }] }] : [{ id: "m2", state: "stopped", events: "nonsense" }, "junk"]);
  const page = await (await start({ system }, undefined, fly(machines))).send("/system");
  assert.deepEqual(asked, ["api/machines", "api/volumes", "admin/machines", "admin/volumes"].map(p => [`https://api.machines.dev/v1/apps/${p}`, "Bearer fly-ro"]));
  assert.match(page.body, /主机<\/div>\s*<div class="big">1 \/ 3<\/div>/);
  assert.match(page.body, /<td>api<\/td><td>api-1 <span class="muted">m1<\/span><\/td>\s*<td><span class="tag ">运行中<\/span><\/td><td>nrt<\/td>\s*<td>1 核 · 512 MB 内存<\/td>\s*<td class="num">\$4\.83<\/td><td>deployment-7<\/td>/);
  // shared-cpu-1x with 512 MB in Tokyo: ($0.69 + $3.00) × 1.308; the 1 GB disk $0.15; stopped machines nothing.
  assert.match(page.body, /<td class="num">1 GB<\/td><td class="num">\$0\.15<\/td>/);
  assert.match(page.body, /Fly 一整月约 <span class="tag">估算<\/span><\/div><div class="big">\$4\.98<\/div>/);
  assert.match(page.body, /停止时只收磁盘/);
  assert.match(page.body, /2025\/11\/24 16:00:00 · 退出码 137 <span class="tag bad">内存不够被杀掉<\/span>/, "the latest exit");
  assert.match(page.body, /<td><span class="tag bad">已停止<\/span><\/td>/);
  assert.match(page.body, /<span class="muted">没有记录<\/span>/);
  const refused = await (await start({ system }, undefined, fly(() => new Response("no", { status: 401 })))).send("/system");
  assert.match(refused.body, /读不到 Fly 的主机状态:Fly 回答 401\(应用 api\)/);
  const broken = await (await start({ system }, undefined, { token: "x", apps: ["api"], fetch: (async () => { throw "offline"; }) as typeof fetch })).send("/system?auto=off");
  assert.match(broken.body, /读不到 Fly 的主机状态:offline/);
  assert.ok(!broken.body.includes("http-equiv"));
});
