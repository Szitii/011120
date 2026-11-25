/**
 * The admin console: a small web server for operators. It runs in one of two ways.
 *
 *  * On the operator's own machine: it answers only requests addressed to this machine (Host
 *    127.0.0.1 or localhost) that carry the token made at start-up (a new one every start). The
 *    link printed at start-up hands the token to the browser; after that it travels in a cookie
 *    the browser sends to no other site.
 *  * On a server in the tailnet, behind `tailscale serve`: it answers only requests addressed to
 *    its tailnet name, and Tailscale tells it who is asking (Tailscale-User-Login; `tailscale serve`
 *    removes any such header the browser sent and sets it from the WireGuard key). Each person on
 *    the list has their own database login, so the log still names them. It must listen on
 *    127.0.0.1, where only `tailscale serve` can reach it.
 *
 *  * Either way a form must be posted from the console's own pages (Origin), so a web page open
 *    in the same browser cannot use the console.
 *  * Pages carry no script, and the browser is told to run none.
 *  * Every change needs a reason and a ticked box; the database writes the log.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { AdminRefusal, type AdminDb } from "./db.ts";
import { hosts, type FlyAccess } from "./fly.ts";
import { ledgerSheets } from "./ledger.ts";
import { workbook } from "./xlsx.ts";
import { chatGatePage, chatPage, costSettingsPage, costsPage, costsYearPage, errorPage, statsPage, systemPage, type Activity, type SystemInfo, logPage, modelsPage, ownerPage, ownersPage, reportsPage, switchTargets, RESOLUTIONS, FEATURES,
  type CatalogEntry, type ChatList, type Costs, type ChatPage, type LogPage, type Models, type OwnerDetail, type OwnerList, type ReportQueue,
  type Feature } from "./pages.ts";

/** On the tailnet: the console's machine name, and each allowed Tailscale login with their own database login. */
export interface Tailnet {
  readonly hostname: string;
  readonly operators: ReadonlyMap<string, AdminDb>;
}

export type AdminServerOptions = Common & ({
  readonly db: AdminDb;
  /** The start-up token: at least 32 characters, unguessable. */
  readonly token: string;
} | { readonly tailnet: Tailnet });

interface Common {
  readonly catalog: readonly CatalogEntry[];
  /** IANA time zone for the times shown; default: this machine's. */
  readonly timeZone?: string;
  readonly now?: () => Date;
  readonly onError?: (error: unknown) => void;
  /** A read-only Fly token and the apps to show on the 系统 page; without it the page says so. */
  readonly fly?: FlyAccess;
}

const COOKIE = "admin_console";
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ROUTES = {
  owner: new RegExp(`^/owners/(${UUID})$`),
  chat: new RegExp(`^/chats/(${UUID})$`),
  resolve: new RegExp(`^/reports/(${UUID})/resolve$`),
  ownerStatus: new RegExp(`^/owners/(${UUID})/(suspend|restore)$`),
  twinStatus: new RegExp(`^/twins/(${UUID})/(suspend|restore)$`),
  content: new RegExp(`^/content/(post|comment)/(${UUID})/(remove|restore)$`),
  uuid: new RegExp(`^${UUID}$`),
};
const HEADERS = {
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  // same-origin, not no-referrer: a no-referrer page posts its forms with "Origin: null", which is refused below.
  "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin", "Cache-Control": "no-store",
};
const FORM_LIMIT = 16_384;
const DOLLARS = /^\d{1,7}(\.\d{1,2})?$/;
const PRICE = /^\d{1,7}(\.\d{1,4})?$/;
/** Dollars as typed, in cents (a price may be a fraction of a cent). */
const cents = (dollars: string) => Number((Number(dollars) * 100).toFixed(2));

class NotFound extends Error {}
type Form = Readonly<Record<string, string>>;
/** A file to download instead of a page. */
interface Download { readonly name: string; readonly type: string; readonly bytes: Buffer }
/** What a request gets back: a page, a file, or a redirect (with the cookie, once). */
type Answer = { status: number; body: string | Download } | { location: string; cookie?: string };
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function same(a: string, b: string): boolean {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Reads a posted form. The whole body is taken off the wire even when it is too long, so the refusal can be sent. */
async function readForm(request: IncomingMessage): Promise<Form> {
  if (!(request.headers["content-type"] ?? "").startsWith("application/x-www-form-urlencoded")) throw new AdminRefusal("表单格式不对。");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size <= FORM_LIMIT) chunks.push(chunk);
  }
  if (size > FORM_LIMIT) throw new AdminRefusal("提交的内容太长。");
  return Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString("utf8")));
}

/** Where to go after a change: a path on this console that the form sent along, nothing else. */
const backPath = (form: Form) => /^\/[a-z]+[a-z0-9/?=&_:.-]*$/i.test(form.back ?? "") && !form.back!.includes("//") ? form.back! : "/reports";

function reasonOf(form: Form): string {
  const reason = (form.reason ?? "").trim();
  if (reason === "") throw new AdminRefusal("请填写原因。");
  return reason;
}

/** A calendar day that exists, as YYYY-MM-DD, or the fallback. */
function dayOr(value: string | null, fallback: string): string {
  const time = Date.parse(`${value}T00:00:00Z`);
  return value !== null && !Number.isNaN(time) && new Date(time).toISOString().slice(0, 10) === value ? value : fallback;
}

export function createAdminServer(options: AdminServerOptions): Server {
  const tailnet = "tailnet" in options ? options.tailnet : null;
  if (tailnet === null && !("token" in options && options.token.length >= 32)) throw new Error("The admin token must be at least 32 characters.");
  if (tailnet !== null && (!/^[a-z0-9-]+$/.test(tailnet.hostname) || tailnet.operators.size === 0)) {
    throw new Error("The tailnet needs a machine name (a-z, 0-9, -) and at least one operator.");
  }
  // The tailnet name: short (MagicDNS) or full (<name>.<tailnet>.ts.net); served on port 80, so no port.
  const tailnetHost = tailnet && new RegExp(`^${tailnet.hostname}(\\.[a-z0-9-]+\\.ts\\.net)?$`);
  const { catalog } = options;
  const zone = options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const now = options.now ?? (() => new Date());
  const targets = new Set(switchTargets(catalog).map(t => t.value));

  /** The months of a year, January up to this month when it is this year. */
  function yearMonths(year: string): string[] {
    const today = now(), last = Number(year) < today.getUTCFullYear() ? 12 : today.getUTCMonth() + 1;
    return Array.from({ length: last }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}-01`);
  }
  /** A year that has started: 2020 up to this one; else this one. */
  const yearOf = (value: string | null) => /^\d{4}$/.test(value ?? "") && Number(value) >= 2020 && Number(value) <= now().getUTCFullYear()
    ? value! : String(now().getUTCFullYear());

  async function get(db: AdminDb, url: URL): Promise<string | Download> {
    const path = url.pathname, query = url.searchParams, done = query.get("ok") === "1";
    let m: RegExpExecArray | null;
    if (path === "/reports") {
      const state = query.get("status") === "REVIEWED" ? "REVIEWED" : "SUBMITTED";
      return reportsPage(zone, await db.call<ReportQueue>("reports", state), state, done);
    }
    if (path === "/owners") {
      const search = (query.get("q") ?? "").trim();
      return ownersPage(zone, await db.call<OwnerList>("owners", search === "" ? null : search), search);
    }
    if ((m = ROUTES.owner.exec(path))) {
      const detail = await db.call<OwnerDetail | null>("owner_detail", m[1]);
      if (detail === null) throw new NotFound();
      return ownerPage(zone, detail, await db.call<ChatList>("chats", m[1]), await db.call<LogPage>("log", null, m[1]), done);
    }
    if ((m = ROUTES.chat.exec(path))) return chatGatePage(m[1]!);
    if (path === "/models") return modelsPage(zone, now(), await db.call<Models>("models"), catalog, await db.call<Feature[]>("features"), done);
    if (path === "/costs/settings") return costSettingsPage(zone, await db.call<Costs>("costs", `${now().toISOString().slice(0, 7)}-01`), done);
    if (path === "/costs/export.xlsx") {
      const year = query.get("year");
      const months = year !== null ? yearMonths(yearOf(year)) : [dayOr(`${query.get("month")}-01`, `${now().toISOString().slice(0, 7)}-01`)];
      const costs: Costs[] = [];
      for (const month of months) costs.push(await db.call<Costs>("costs", month));
      return { name: `花费-${year !== null ? yearOf(year) : months[0]!.slice(0, 7)}.xlsx`, type: XLSX, bytes: workbook(ledgerSheets(costs)) };
    }
    if (path === "/costs" && query.has("year")) {
      const year = yearOf(query.get("year")), costs: Costs[] = [];
      for (const month of yearMonths(year)) costs.push(await db.call<Costs>("costs", month));
      return costsYearPage(zone, now(), year, costs);
    }
    if (path === "/stats") {
      const month = dayOr(`${query.get("month")}-01`, `${now().toISOString().slice(0, 7)}-01`);
      return statsPage(zone, now(), await db.call<Activity>("activity", month));
    }
    if (path === "/system") {
      const [system, machines] = await Promise.all([db.call<SystemInfo>("system"), hosts(options.fly ?? null)]);
      return systemPage(zone, now(), system, machines);
    }
    if (path === "/costs") {
      const thisMonth = `${now().toISOString().slice(0, 7)}-01`, month = dayOr(`${query.get("month")}-01`, thisMonth);
      const costs = await db.call<Costs>("costs", month);
      // Today's spend against the daily cap belongs to the running month only; so does reading itself again.
      // So does the Fly estimate, from the servers as they are now.
      const [cap, fly] = month === thisMonth
        ? await Promise.all([db.call<Models>("models").then(m => m.cap), hosts(options.fly ?? null)]) : [null, null];
      return costsPage(zone, now(), costs, cap, done, fly);
    }
    if (path === "/log") {
      const before = /^\d{1,15}$/.test(query.get("before") ?? "") ? Number(query.get("before")) : null;
      const owner = ROUTES.uuid.test(query.get("owner") ?? "") ? query.get("owner") : null;
      return logPage(zone, await db.call<LogPage>("log", before, owner), owner);
    }
    throw new NotFound();
  }

  /** Runs one posted form; returns the page to show, or null to go back to where the form was. */
  async function post(db: AdminDb, path: string, form: Form): Promise<string | null> {
    const reason = reasonOf(form);
    let m: RegExpExecArray | null;
    if ((m = ROUTES.chat.exec(path))) {
      // Reading a private chat changes nothing, so no tick; the database logs each page read.
      return chatPage(zone, await db.call<ChatPage>("chat_read", m[1], reason, form.at || null, form.id || null), reason);
    }
    if (form.confirm !== "yes") throw new AdminRefusal("请勾选“确认”再提交。");
    if ((m = ROUTES.resolve.exec(path))) {
      if (!Object.hasOwn(RESOLUTIONS, form.resolution ?? "")) throw new AdminRefusal("请选择怎么处理。");
      await db.call("report_resolve", m[1], form.resolution, reason);
    } else if ((m = ROUTES.ownerStatus.exec(path))) {
      await db.call("owner_suspend", m[1], m[2] === "suspend", reason);
    } else if ((m = ROUTES.twinStatus.exec(path))) {
      await db.call("twin_suspend", m[1], m[2] === "suspend", reason);
    } else if ((m = ROUTES.content.exec(path))) {
      await db.call(m[3] === "remove" ? "content_remove" : "content_restore", m[1]!.toUpperCase(), m[2], reason);
    } else if (path === "/models/switch") {
      // Only what the catalog names can be switched, or the switch would silently cover nothing.
      if (!targets.has(form.target ?? "") || (form.enabled !== "on" && form.enabled !== "off")) throw new AdminRefusal("请选择开关哪一个,以及开还是关。");
      const cut = form.target!.indexOf(":");
      await db.call("model_switch_set", form.target!.slice(0, cut), form.target!.slice(cut + 1), form.enabled === "on", reason);
    } else if (path === "/models/feature") {
      if (!Object.hasOwn(FEATURES, form.key ?? "") || (form.enabled !== "on" && form.enabled !== "off")) throw new AdminRefusal("请选择开关哪一个,以及开还是关。");
      await db.call("feature_set", form.key, form.enabled === "on", reason);
    } else if (path === "/costs/cap") {
      if ((form.enabled !== "on" && form.enabled !== "off") || !DOLLARS.test((form.dollars ?? "").trim())) throw new AdminRefusal("请选择开关,金额填美元(最多两位小数)。");
      await db.call("spend_cap_set", form.enabled === "on", Math.round(Number(form.dollars!.trim()) * 100), reason);
    } else if (path === "/models/wallet") {
      if ((form.enabled !== "on" && form.enabled !== "off") || !/^\d{1,8}$/.test(form.welcome ?? "")
        || !/^[1-9]\d{0,5}$/.test(form.rate ?? "") || !/^\d{1,8}$/.test(form.floor ?? "")) throw new AdminRefusal("请选择开关,数量要填整数(每分积分至少 1)。");
      await db.call("wallet_policy_set", form.enabled === "on", Number(form.welcome), Number(form.rate), Number(form.floor), reason);
    } else if (path === "/models/welcome") {
      // The gift on or off: off is a gift of 0; the other wallet rules stay as they are.
      if ((form.enabled !== "on" && form.enabled !== "off") || (form.enabled === "on" && !/^[1-9]\d{0,7}$/.test(form.welcome ?? ""))) {
        throw new AdminRefusal("请选择开还是关;打开时要填送多少积分(正整数)。");
      }
      const w = (await db.call<Models>("models")).wallet;
      await db.call("wallet_policy_set", w.enabled, form.enabled === "on" ? Number(form.welcome) : 0, w.creditsPerCent, w.backgroundFloor, reason);
    } else if (path === "/models/credit") {
      if (!ROUTES.uuid.test(form.owner ?? "") || !/^-?[1-9]\d{0,7}$/.test(form.credits ?? "")) throw new AdminRefusal("请填主人编号和不为 0 的整数积分。");
      await db.call("wallet_adjust", form.owner, Number(form.credits), reason);
    } else if (path === "/costs/fixed") {
      const item = (form.item ?? "").trim(), amount = (form.dollars ?? "").trim();
      if (item === "" || !(amount === "删除" || DOLLARS.test(amount))) throw new AdminRefusal("请填项目名称,金额填美元(最多两位小数),或填“删除”。");
      await db.call("fixed_cost_set", item, amount === "删除" ? null : Math.round(Number(amount) * 100), form.note ?? "", reason);
    } else if (path === "/costs/prices") {
      if (!/^\d{1,9}$/.test(form.points ?? "") || !PRICE.test(form.speak ?? "") || !PRICE.test(form.hear ?? "")) {
        throw new AdminRefusal("点数要填整数,单价填美元(最多四位小数)。");
      }
      await db.call("voice_prices_set", Number(form.points), cents(form.speak!), cents(form.hear!), reason);
    } else if (path === "/models/quota") {
      if (!/^\d{1,6}$/.test(form.calls ?? "") || !/^\d{1,9}$/.test(form.cents ?? "")) throw new AdminRefusal("次数和金额要填整数。");
      await db.call("chat_quota_set", Number(form.calls), Number(form.cents), reason);
    } else {
      throw new NotFound();
    }
    return null;
  }

  /** Who may use the console from here: their database, and the hosts their forms may come from; or what to answer instead. */
  function enter(request: IncomingMessage, url: URL, method: string): { db: AdminDb; hosts: string[] } | Answer {
    const host = request.headers.host ?? "";
    if (tailnet !== null) {
      // Only requests addressed to the tailnet name: a page elsewhere cannot reach the console under its own name.
      if (!tailnetHost!.test(host)) return { status: 403, body: "Forbidden" };
      const login = request.headers["tailscale-user-login"];
      const db = typeof login === "string" ? tailnet.operators.get(login.toLowerCase()) : undefined;
      if (db === undefined) {
        return { status: 403, body: errorPage("打不开", "你的 Tailscale 账号不在管理员名单里。名单在服务器的 ADMIN_OPERATORS 里。", "/") };
      }
      return { db, hosts: [host] };
    }
    const local = options as { db: AdminDb; token: string };
    // Only requests addressed to this machine: a page elsewhere cannot reach the console under its own name.
    const hosts = [`127.0.0.1:${request.socket.localPort}`, `localhost:${request.socket.localPort}`];
    if (!hosts.includes(host)) return { status: 403, body: "Forbidden" };
    // The start-up link: trade the token in the address for a cookie, and take it out of the address.
    const offered = url.searchParams.get("token");
    if (method === "GET" && url.pathname === "/" && offered !== null) {
      return same(offered, local.token) ? { location: "/reports", cookie: `${COOKIE}=${local.token}; HttpOnly; SameSite=Strict; Path=/` }
        : { status: 403, body: errorPage("打不开", "这个链接里的口令不对。请用后台启动时打印的链接。", "/") };
    }
    const cookie = (request.headers.cookie ?? "").split(";").map(part => part.trim()).find(part => part.startsWith(`${COOKIE}=`));
    if (!cookie || !same(cookie.slice(COOKIE.length + 1), local.token)) {
      return { status: 403, body: errorPage("打不开", "请用后台启动时终端里打印的链接打开。后台每次重新启动,链接都会换。", "/") };
    }
    return { db: local.db, hosts };
  }

  async function answer(request: IncomingMessage): Promise<Answer> {
    const url = URL.parse(request.url ?? "/", "http://console");
    if (url === null) return { status: 400, body: "Bad request" };
    const method = request.method ?? "GET";
    const entered = enter(request, url, method);
    if (!("db" in entered)) return entered;
    const { db, hosts } = entered;
    let back = "/reports";
    try {
      if (method === "GET") return url.pathname === "/" ? { location: "/reports" } : { status: 200, body: await get(db, url) };
      if (method !== "POST") return { status: 405, body: errorPage("不支持", "不支持这种请求。", back) };
      // A form must come from the console's own pages: any other origin (another site, another port
      // here, a sandboxed frame's "null") is refused. Browsers send Origin with every POST.
      if (!hosts.some(host => request.headers.origin === `http://${host}`)) {
        return { status: 403, body: errorPage("已拒绝", "这个请求不是从管理后台的页面发出的。", back) };
      }
      const form = await readForm(request);
      back = backPath(form);
      const shown = await post(db, url.pathname, form);
      return shown === null ? { location: `${back}${back.includes("?") ? "&" : "?"}ok=1` } : { status: 200, body: shown };
    } catch (error) {
      if (error instanceof NotFound) return { status: 404, body: errorPage("没有这个页面", "没有找到这个页面或对象。", "/reports") };
      if (error instanceof AdminRefusal) return { status: 409, body: errorPage("没有执行", error.message, back) };
      throw error;
    }
  }

  return createServer((request, response) => {
    answer(request).catch((error: unknown): Answer => {
      (options.onError ?? console.error)(error);
      return { status: 500, body: errorPage("出错了", "后台出错了,这次操作没有完成。详细信息在后台的运行日志里。", "/reports") };
    }).then(result => {
      if ("location" in result) {
        response.writeHead(303, { ...HEADERS, Location: result.location, ...(result.cookie ? { "Set-Cookie": result.cookie } : {}) }).end();
      } else if (typeof result.body === "string") {
        response.writeHead(result.status, { ...HEADERS, "Content-Type": "text/html; charset=utf-8" }).end(result.body);
      } else {
        response.writeHead(result.status, { ...HEADERS, "Content-Type": result.body.type,
          "Content-Disposition": `attachment; filename="export.xlsx"; filename*=UTF-8''${encodeURIComponent(result.body.name)}` }).end(result.body.bytes);
      }
    });
  });
}
