/**
 * The admin console: a small web server for operators, meant to run on the operator's own machine.
 *
 *  * It answers only requests addressed to this machine (Host 127.0.0.1 or localhost) that carry
 *    the token made at start-up. The link printed at start-up hands the token over once; after
 *    that it travels in a cookie the browser sends to no other site. A form posted from any other
 *    page is refused. So a web page open in the same browser cannot use the console.
 *  * Pages carry no script, and the browser is told to run none.
 *  * Every change needs a reason and a ticked box; the database writes the log.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { AdminRefusal, type AdminDb } from "./db.ts";
import { chatGatePage, chatPage, errorPage, logPage, modelsPage, ownerPage, ownersPage, reportsPage, switchTargets, RESOLUTIONS,
  type CatalogEntry, type ChatList, type ChatPage, type LogPage, type Models, type OwnerDetail, type OwnerList, type ReportQueue,
  type Spend } from "./pages.ts";

export interface AdminServerOptions {
  readonly db: AdminDb;
  /** The start-up token: at least 32 characters, unguessable. */
  readonly token: string;
  readonly catalog: readonly CatalogEntry[];
  /** IANA time zone for the times shown; default: this machine's. */
  readonly timeZone?: string;
  readonly now?: () => Date;
  readonly onError?: (error: unknown) => void;
}

const COOKIE = "admin_console";
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const HEADERS = {
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Cache-Control": "no-store",
} as const;

class NotFound extends Error {}
type Form = Readonly<Record<string, string>>;

function same(a: string, b: string): boolean {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function readForm(request: IncomingMessage): Promise<Form> {
  if (!(request.headers["content-type"] ?? "").startsWith("application/x-www-form-urlencoded")) throw new AdminRefusal("表单格式不对。");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > 16_384) throw new AdminRefusal("提交的内容太长。");
    chunks.push(chunk);
  }
  return Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString("utf8")));
}

/** Where to go after a change: a path on this console that the form sent along, nothing else. */
const backPath = (form: Form) => /^\/[a-z]+[a-z0-9/?=&_:.-]*$/i.test(form.back ?? "") && !form.back!.includes("//") ? form.back! : "/reports";

export function createAdminServer(options: AdminServerOptions): Server {
  if (options.token.length < 32) throw new Error("The admin token must be at least 32 characters.");
  const { db, catalog } = options;
  const view = { timeZone: options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone };
  const now = options.now ?? (() => new Date());
  const targets = new Set(switchTargets(catalog).map(t => t.value));

  /** The reason and the ticked box every change needs. */
  const confirmed = (form: Form): string => {
    if (form.confirm !== "yes") throw new AdminRefusal("请勾选“确认”再提交。");
    if ((form.reason ?? "").trim() === "") throw new AdminRefusal("请填写原因。");
    return form.reason!;
  };

  async function get(url: URL): Promise<string> {
    const path = url.pathname, done = url.searchParams.get("ok") === "1";
    let m: RegExpExecArray | null;
    if (path === "/reports") {
      const state = url.searchParams.get("status") === "REVIEWED" ? "REVIEWED" : "SUBMITTED";
      return reportsPage(view, await db.call<ReportQueue>("reports", state), state, done);
    }
    if (path === "/owners") {
      const search = (url.searchParams.get("q") ?? "").trim();
      return ownersPage(view, await db.call<OwnerList>("owners", search === "" ? null : search), search);
    }
    if ((m = new RegExp(`^/owners/(${UUID})$`).exec(path))) {
      const detail = await db.call<OwnerDetail | null>("owner_detail", m[1]);
      if (detail === null) throw new NotFound();
      return ownerPage(view, detail, await db.call<ChatList>("chats", m[1]), await db.call<LogPage>("log", null, m[1]), done);
    }
    if ((m = new RegExp(`^/chats/(${UUID})$`).exec(path))) return chatGatePage(m[1]!);
    if (path === "/models") {
      const today = now().toISOString().slice(0, 10);
      const day = (name: string, fallback: string) => DAY.test(url.searchParams.get(name) ?? "") ? url.searchParams.get(name)! : fallback;
      const to = day("to", today);
      const from = day("from", new Date(Date.parse(to) - 6 * 86_400_000).toISOString().slice(0, 10));
      return modelsPage(view, await db.call<Models>("models"), await db.call<Spend>("spend", from, to), catalog, done);
    }
    if (path === "/log") {
      const before = /^\d{1,15}$/.test(url.searchParams.get("before") ?? "") ? Number(url.searchParams.get("before")) : null;
      const owner = new RegExp(`^${UUID}$`).test(url.searchParams.get("owner") ?? "") ? url.searchParams.get("owner") : null;
      return logPage(view, await db.call<LogPage>("log", before, owner), owner);
    }
    throw new NotFound();
  }

  /** Runs one change; returns the page to show, or null to go back to where the form was. */
  async function post(path: string, form: Form): Promise<string | null> {
    let m: RegExpExecArray | null;
    if ((m = new RegExp(`^/chats/(${UUID})$`).exec(path))) {
      // Reading a private chat: a reason, no tick; each page read is logged by the database.
      const reason = (form.reason ?? "").trim();
      if (reason === "") throw new AdminRefusal("请填写原因。");
      const cursor = form.at && form.id ? [form.at, form.id] : [null, null];
      return chatPage(view, await db.call<ChatPage>("chat_read", m[1], reason, ...cursor), reason);
    }
    const reason = confirmed(form);
    if ((m = new RegExp(`^/reports/(${UUID})/resolve$`).exec(path))) {
      if (!Object.hasOwn(RESOLUTIONS, form.resolution ?? "")) throw new AdminRefusal("请选择怎么处理。");
      await db.call("report_resolve", m[1], form.resolution, reason);
    } else if ((m = new RegExp(`^/owners/(${UUID})/(suspend|restore)$`).exec(path))) {
      await db.call("owner_suspend", m[1], m[2] === "suspend", reason);
    } else if ((m = new RegExp(`^/twins/(${UUID})/(suspend|restore)$`).exec(path))) {
      await db.call("twin_suspend", m[1], m[2] === "suspend", reason);
    } else if ((m = new RegExp(`^/content/(post|comment)/(${UUID})/(remove|restore)$`).exec(path))) {
      await db.call(m[3] === "remove" ? "content_remove" : "content_restore", m[1]!.toUpperCase(), m[2], reason);
    } else if (path === "/models/switch") {
      // Only what the catalog names can be switched, or the switch would silently cover nothing.
      if (!targets.has(form.target ?? "") || (form.enabled !== "on" && form.enabled !== "off")) throw new AdminRefusal("请选择开关哪一个,以及开还是关。");
      const cut = form.target!.indexOf(":");
      await db.call("model_switch_set", form.target!.slice(0, cut), form.target!.slice(cut + 1), form.enabled === "on", reason);
    } else if (path === "/models/quota") {
      if (!/^\d{1,6}$/.test(form.calls ?? "") || !/^\d{1,9}$/.test(form.cents ?? "")) throw new AdminRefusal("次数和金额要填整数。");
      await db.call("chat_quota_set", Number(form.calls), Number(form.cents), reason);
    } else {
      throw new NotFound();
    }
    return null;
  }

  async function handle(request: IncomingMessage, response: ServerResponse,
    send: (status: number, body: string, headers?: Record<string, string>) => void): Promise<void> {
    const go = (location: string, headers: Record<string, string> = {}) => {
      response.writeHead(303, { ...HEADERS, Location: location, ...headers });
      response.end();
    };
    // Only requests addressed to this machine: a page elsewhere cannot reach the console under its own name.
    const port = request.socket.localPort;
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!hosts.includes(request.headers.host ?? "")) return send(403, "Forbidden", { "Content-Type": "text/plain; charset=utf-8" });
    const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
    const method = request.method ?? "GET";

    // The start-up link: trade the token in the address for a cookie, and take it out of the address.
    const offered = url.searchParams.get("token");
    if (method === "GET" && url.pathname === "/" && offered !== null) {
      if (!same(offered, options.token)) return send(403, errorPage("打不开", "这个链接里的口令不对。请用后台启动时打印的链接。", "/"));
      return go("/reports", { "Set-Cookie": `${COOKIE}=${options.token}; HttpOnly; SameSite=Strict; Path=/` });
    }
    const cookie = (request.headers.cookie ?? "").split(";").map(part => part.trim()).find(part => part.startsWith(`${COOKIE}=`));
    if (!cookie || !same(cookie.slice(COOKIE.length + 1), options.token)) {
      return send(403, errorPage("打不开", "请用后台启动时终端里打印的链接打开。后台每次重新启动,链接都会换。", "/"));
    }
    let back = "/reports";
    try {
      if (method === "GET") return url.pathname === "/" ? go("/reports") : send(200, await get(url));
      if (method !== "POST") return send(405, errorPage("不支持", "不支持这种请求。", back));
      // A form posted from another page (any other origin, including another port here) is refused.
      const origin = request.headers.origin;
      if (origin !== undefined && !hosts.some(host => origin === `http://${host}`)) {
        return send(403, errorPage("已拒绝", "这个请求不是从管理后台的页面发出的。", back));
      }
      const form = await readForm(request);
      back = form.back === undefined && url.pathname.startsWith("/chats/") ? url.pathname : backPath(form);
      const shown = await post(url.pathname, form);
      return shown === null ? go(`${back}${back.includes("?") ? "&" : "?"}ok=1`) : send(200, shown);
    } catch (error) {
      if (error instanceof NotFound) return send(404, errorPage("没有这个页面", "没有找到这个页面或对象。", "/reports"));
      if (error instanceof AdminRefusal) return send(409, errorPage("没有执行", error.message, back));
      throw error;
    }
  }

  return createServer((request, response) => {
    const send = (status: number, body: string, headers: Record<string, string> = {}) => {
      response.writeHead(status, { ...HEADERS, "Content-Type": "text/html; charset=utf-8", ...headers });
      response.end(body);
    };
    handle(request, response, send).catch(error => {
      (options.onError ?? console.error)(error);
      if (response.headersSent) response.end();
      else send(500, errorPage("出错了", "后台出错了,这次操作没有完成。详细信息在启动后台的终端里。", "/reports"));
    });
  });
}
