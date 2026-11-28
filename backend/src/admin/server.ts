/**
 * The admin console: a small web server for operators, on a server in the tailnet behind
 * `tailscale serve`.
 *
 *  * It answers only requests addressed to its tailnet name, and Tailscale tells it who is asking
 *    (Tailscale-User-Login; `tailscale serve` removes any such header the browser sent and sets it
 *    from the WireGuard key). Each person on the list has their own database login, so the log
 *    names them. It must listen on 127.0.0.1, where only `tailscale serve` can reach it.
 *  * A form must be posted from the console's own pages (Origin), so a web page open in the same
 *    browser cannot use the console.
 *  * Pages carry no script, and the browser is told to run none.
 *  * Every change needs a reason (a dangerous one also a ticked box); the database writes the log.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import { AdminRefusal, type AdminDb } from "./db.ts";
import { hosts, type FlyAccess } from "./fly.ts";
import { vendorStatus, type VendorKey } from "./vendors.ts";
import { promptBlock, promptTextRefusal, tidyPromptText } from "../chat/prompt-texts.ts";
import { parseCharacterCard } from "../companion-import/parser.ts";
import { hasActiveContent, hasCredential } from "../companion-import/policy.ts";
import { SKILL_CHARS, skillLine } from "../chat/prompt.ts";
import { ledgerSheets } from "./ledger.ts";
import { workbook } from "./xlsx.ts";
import { withPending, feedbackPage, type FeedbackQueue, chatGatePage, chatPage, costSettingsPage, costsPage, costsYearPage, errorPage, statsPage, systemPage, type Activity, type SystemInfo, logPage, modelsPage, ownerPage, ownersPage, promptsPage, reportsPage, switchTargets, RESOLUTIONS, FEATURES,
  type CatalogEntry, type ChatList, type Costs, type ChatPage, type LogPage, type Models, type OwnerDetail, type OwnerList, type ReportQueue, type SavedPrompts,
  type Feature, kitPage, type Kit, type ToolServerRow } from "./pages.ts";
import { checkUrl } from "../connections/guard.ts";

/** On the tailnet: the console's machine name, and each allowed Tailscale login with their own database login. */
export interface Tailnet {
  readonly hostname: string;
  readonly operators: ReadonlyMap<string, AdminDb>;
}

export interface AdminServerOptions {
  readonly tailnet: Tailnet;
  readonly catalog: readonly CatalogEntry[];
  /** IANA time zone for the times shown; default: this machine's. */
  readonly timeZone?: string;
  readonly now?: () => Date;
  readonly onError?: (error: unknown) => void;
  /** A read-only Fly token and the apps to show on the 系统 page; without it the page says so. */
  readonly fly?: FlyAccess;
  /** The model companies the catalog uses, with the console's own copy of each key (for balances). */
  readonly vendors?: readonly VendorKey[];
  /** Answers the companies' balance APIs; tests pass a stand-in. */
  readonly fetch?: typeof fetch;
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ROUTES = {
  owner: new RegExp(`^/owners/(${UUID})$`),
  chat: new RegExp(`^/chats/(${UUID})$`),
  resolve: new RegExp(`^/reports/(${UUID})/resolve$`),
  ownerStatus: new RegExp(`^/owners/(${UUID})/(suspend|restore)$`),
  twinStatus: new RegExp(`^/twins/(${UUID})/(suspend|restore)$`),
  content: new RegExp(`^/content/(post|comment)/(${UUID})/(remove|restore)$`),
  feedback: new RegExp(`^/feedback/(${UUID})/(reply|close|reopen)$`),
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
/** What a request gets back: a page, a file, or a redirect. */
type Answer = { status: number; body: string | Download } | { location: string };
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

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
  const { tailnet } = options;
  if (!/^[a-z0-9-]+$/.test(tailnet.hostname) || tailnet.operators.size === 0) {
    throw new Error("The tailnet needs a machine name (a-z, 0-9, -) and at least one operator.");
  }
  // The tailnet name: short (MagicDNS) or full (<name>.<tailnet>.ts.net); served on port 80, so no port.
  const tailnetHost = new RegExp(`^${tailnet.hostname}(\\.[a-z0-9-]+\\.ts\\.net)?$`);
  const { catalog } = options;
  const zone = options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const now = options.now ?? (() => new Date());
  const targets = new Set(switchTargets(catalog).map(t => t.value));
  // The API server is the first app the console watches.
  const vendorsNow = () => vendorStatus(options.vendors ?? [], options.fly ?? null, options.fly?.apps[0] ?? "", options.fetch);

  /** The months of a year, January up to this month when it is this year. */
  function yearMonths(year: string): string[] {
    const today = now(), last = Number(year) < today.getUTCFullYear() ? 12 : today.getUTCMonth() + 1;
    return Array.from({ length: last }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}-01`);
  }
  /** A year that has started: 2020 up to this one; else this one. */
  const yearOf = (value: string | null) => /^\d{4}$/.test(value ?? "") && Number(value) >= 2020 && Number(value) <= now().getUTCFullYear()
    ? value! : String(now().getUTCFullYear());

  /** The first day of a month as YYYY-MM, not after this one; else this month's. */
  function monthOf(value: string | null): string {
    const thisMonth = `${now().toISOString().slice(0, 7)}-01`, month = dayOr(`${value}-01`, thisMonth);
    return month > thisMonth ? thisMonth : month;
  }

  async function get(db: AdminDb, url: URL): Promise<string | Download> {
    const path = url.pathname, query = url.searchParams, done = query.get("ok") === "1";
    let m: RegExpExecArray | null;
    if (path === "/reports") {
      const state = query.get("status") === "REVIEWED" ? "REVIEWED" : "SUBMITTED";
      return reportsPage(zone, await db.call<ReportQueue>("reports", state), state, done);
    }
    if (path === "/feedback") {
      const state = query.get("status") === "CLOSED" ? "CLOSED" : "OPEN";
      return feedbackPage(zone, await db.call<FeedbackQueue>("feedback", state), state, done, query.get("open"));
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
    if (path === "/models") {
      const [models, features, vendors] = await Promise.all([db.call<Models>("models"), db.call<Feature[]>("features"), vendorsNow()]);
      return modelsPage(zone, models, catalog, features, done, vendors);
    }
    if (path === "/costs/settings") return costSettingsPage(zone, await db.call<Costs>("costs", `${now().toISOString().slice(0, 7)}-01`), done);
    if (path === "/costs/export.xlsx") {
      const year = query.get("year");
      const months = year !== null ? yearMonths(yearOf(year)) : [monthOf(query.get("month"))];
      const costs: Costs[] = [];
      for (const month of months) costs.push(await db.call<Costs>("costs", month));
      return { name: `花费-${year !== null ? yearOf(year) : months[0]!.slice(0, 7)}.xlsx`, type: XLSX, bytes: workbook(ledgerSheets(costs)) };
    }
    if (path === "/costs" && query.has("year")) {
      const year = yearOf(query.get("year")), costs: Costs[] = [];
      for (const month of yearMonths(year)) costs.push(await db.call<Costs>("costs", month));
      return costsYearPage(now(), year, costs);
    }
    if (path === "/stats") {
      const month = monthOf(query.get("month"));
      return statsPage(now(), await db.call<Activity>("activity", month));
    }
    if (path === "/system") {
      const [system, machines] = await Promise.all([db.call<SystemInfo>("system"), hosts(options.fly ?? null)]);
      return systemPage(zone, system, machines);
    }
    if (path === "/costs") {
      const thisMonth = `${now().toISOString().slice(0, 7)}-01`, month = monthOf(query.get("month"));
      const costs = await db.call<Costs>("costs", month);
      // Today's spend against the daily cap belongs to the running month only; so does reading itself again.
      // So does the Fly estimate, from the servers as they are now.
      const [cap, fly, vendors] = month === thisMonth
        ? await Promise.all([db.call<Models>("models").then(m => m.cap), hosts(options.fly ?? null), vendorsNow()]) : [null, null, []];
      return costsPage(now(), costs, cap, done, fly, vendors);
    }
    if (path === "/prompts") return promptsPage(zone, now(), await db.call<SavedPrompts>("prompts"), done);
    if (path === "/kit") {
      const [kit, servers] = await Promise.all([db.call<Kit>("kit"), db.call<ToolServerRow[]>("tool_servers")]);
      return kitPage(zone, kit, done, servers);
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
    } else if ((m = ROUTES.feedback.exec(path))) {
      if (m[2] === "reply") {
        const body = (form.body ?? "").trim();
        if (body === "" || Array.from(body).length > 2000) throw new AdminRefusal("回复不能是空的,最多 2000 个字。");
        await db.call("feedback_reply", m[1], body, form.close === "yes", reason);
      } else {
        await db.call("feedback_close", m[1], m[2] === "close", reason);
      }
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
    } else if (path === "/prompts/set") {
      // The same check the API server makes before using a wording: nothing is saved that it would ignore.
      const block = promptBlock(form.key ?? "");
      if (block === undefined) throw new AdminRefusal("没有这一段说明。");
      const body = form.restore === "yes" ? null : tidyPromptText(form.body ?? "");
      const refused = body === null ? null : promptTextRefusal(block, body);
      if (refused !== null) throw new AdminRefusal(refused);
      await db.call("prompt_set", block.key, body, reason);
    } else if (path === "/kit/template" || path === "/kit/skill") {
      const template = path === "/kit/template";
      const text = (name: string) => (form[name] ?? "").replace(/\r\n?/g, "\n").trim();
      const length = (name: string) => Array.from(text(name)).length;
      const id = form.id === undefined || form.id === "" ? null : form.id;
      if ((id !== null && !ROUTES.uuid.test(id)) || !/^\d{1,4}$/.test(form.position ?? "") || length("title") < 1 || length("title") > 20
        || length("summary") < 1 || length("summary") > 100) throw new AdminRefusal("名称(最多 20 字)和一句话介绍(最多 100 字)都要填,排序填 0 到 9999 的整数。");
      const shared = [id, text("title"), text("summary")], tail = [Number(form.position), form.enabled === "on", reason];
      if (template) {
        if (length("name") < 1 || length("name") > 20 || length("description") < 1 || length("description") > 600 || length("personality") > 600
          || length("example") > 1500) throw new AdminRefusal("默认名字(最多 20 字)和简介(最多 600 字)要填;性格最多 600 字,示例对话最多 1500 字。");
        // What an Owner will hand to the import: it must come through whole, or the template would arrive with parts greyed out.
        const card = { spec: "chara_card_v2", spec_version: "2.0", data: { name: text("name"), description: text("description"),
          ...(text("personality") === "" ? {} : { personality: text("personality") }), ...(text("example") === "" ? {} : { mes_example: text("example") }) } };
        const parsed = parseCharacterCard(new TextEncoder().encode(JSON.stringify(card)));
        // With the name put in for every {{char}} the example must still fit, or it would arrive cut off.
        if (parsed.findings.some(finding => finding.type === "FIELD_CONSTRAINT" && finding.sourcePath === "$.data.mes_example")) {
          throw new AdminRefusal("示例对话把 {{char}} 换成默认名字以后超过了 1500 字,主人导入时会被截断。请缩短一些再保存。");
        }
        const blocked = parsed.draft.candidates.filter(candidate => !candidate.approvable);
        if (blocked.length > 0) {
          const where: Readonly<Record<string, string>> = { displayName: "默认名字", identitySummary: "简介", personaTraits: "性格", dialogueExamples: "示例对话" };
          throw new AdminRefusal(`“${blocked.map(candidate => where[candidate.field] ?? candidate.field).join("”和“")}”里有不能用的内容(密钥、电话或邮箱、网址,或者像“忽略以上指令”的话),主人导入时会被拦下。请改掉再保存。`);
        }
        await db.call("template_set", ...shared, text("name"), text("description"), text("personality"), text("example"), ...tail);
      } else {
        if (length("body") < 1 || length("body") > SKILL_CHARS) throw new AdminRefusal(`技能内容要填,最多 ${SKILL_CHARS} 字。`);
        if (hasCredential(text("body")) || hasActiveContent(text("body"))) throw new AdminRefusal("技能内容里不能有密钥或网址。");
        if (skillLine(text("title"), text("body")) === null) throw new AdminRefusal("名称里除了【】还要有别的字,不然这个技能不会发给模型。");
        await db.call("skill_set", ...shared, text("body"), ...tail);
      }
    } else if (path === "/kit/tool") {
      const text = (name: string) => (form[name] ?? "").replace(/\r\n?/g, "\n").trim();
      const names = (name: string) => [...new Set(text(name).split(/[\s,，、]+/).filter(Boolean))];
      const id = form.id === undefined || form.id === "" ? null : form.id;
      const read = names("readTools"), confirm = names("confirmTools");
      const address = checkUrl(text("url"));
      if ((id !== null && !ROUTES.uuid.test(id)) || !/^[a-z][a-z0-9-]{1,30}$/.test(text("key")) || !/^\d{1,4}$/.test(form.position ?? "")
        || Array.from(text("title")).length < 1 || Array.from(text("title")).length > 20 || Array.from(text("summary")).length < 1 || Array.from(text("summary")).length > 100
        || Array.from(text("tokenHelp")).length < 1 || Array.from(text("tokenHelp")).length > 500) {
        throw new AdminRefusal("代号(小写字母、数字和 -)、名称(最多 20 字)、一句话介绍(最多 100 字)、怎么拿令牌(最多 500 字)都要填,排序填 0 到 9999 的整数。");
      }
      if (typeof address === "string") throw new AdminRefusal("地址要是 https 开头的公网地址,不带账号密码、问号和 # 号。");
      if ([...read, ...confirm].some(tool => !/^[A-Za-z0-9_.-]{1,64}$/.test(tool)) || read.some(tool => confirm.includes(tool)) || read.length + confirm.length > 60) {
        throw new AdminRefusal("工具名用空格或换行分开,只能有字母、数字、点、- 和 _;同一个工具不能两边都写;两栏加起来最多 60 个。");
      }
      await db.call("tool_server_set", id, text("key"), text("title"), text("summary"), address.href.replace(/\/$/, ""), text("tokenHelp"), read, confirm,
        Number(form.position), form.enabled === "on", reason);
    } else if (path === "/kit/shared") {
      // KEEP closes the reports this operator was shown: `seen` is the moment of the newest one on their page.
      const seen = form.decision === "KEEP" ? form.seen ?? "" : null;
      if (!ROUTES.uuid.test(form.id ?? "") || !["APPROVE", "REJECT", "REMOVE", "KEEP"].includes(form.decision ?? "")
        || (seen !== null && !Number.isFinite(Date.parse(seen)))) {
        throw new AdminRefusal("没有选中要处理的投稿。");
      }
      await db.call("shared_skill_review", form.id, form.decision, reason, seen);
    } else if (path === "/kit/template/delete" || path === "/kit/skill/delete") {
      if (!ROUTES.uuid.test(form.id ?? "")) throw new AdminRefusal("没有选中要删除的那一个。");
      await db.call(path === "/kit/template/delete" ? "template_delete" : "skill_delete", form.id, reason);
    } else if (path === "/models/quota") {
      if (!/^\d{1,6}$/.test(form.calls ?? "") || !DOLLARS.test((form.dollars ?? "").trim())) throw new AdminRefusal("次数填整数,金额填美元(最多两位小数)。");
      await db.call("chat_quota_set", Number(form.calls), Math.round(Number(form.dollars!.trim()) * 100), reason);
    } else {
      throw new NotFound();
    }
    return null;
  }

  /** Who may use the console: their database, and the host their forms come from; or what to answer instead. */
  function enter(request: IncomingMessage): { db: AdminDb; host: string } | Answer {
    const host = request.headers.host ?? "";
    // Only requests addressed to the tailnet name: a page elsewhere cannot reach the console under its own name.
    if (!tailnetHost.test(host)) return { status: 403, body: "Forbidden" };
    const login = request.headers["tailscale-user-login"];
    const db = typeof login === "string" ? tailnet.operators.get(login.toLowerCase()) : undefined;
    if (db === undefined) {
      return { status: 403, body: errorPage("打不开", "你的 Tailscale 账号不在管理员名单里。名单在服务器的 ADMIN_OPERATORS 里。", "/") };
    }
    return { db, host };
  }

  /** For the sidebar: reports waiting, feedback threads waiting for an answer. */
  const pending = async (db: AdminDb): Promise<[number, number]> => {
    const [reports, feedback] = await Promise.all([db.call<ReportQueue>("reports"), db.call<FeedbackQueue>("feedback")]);
    return [reports.pending, feedback.waiting];
  };

  async function answer(request: IncomingMessage): Promise<Answer> {
    const url = URL.parse(request.url ?? "/", "http://console");
    if (url === null) return { status: 400, body: "Bad request" };
    const method = request.method ?? "GET";
    const entered = enter(request);
    if (!("db" in entered)) return entered;
    const { db, host } = entered;
    let back = "/reports";
    try {
      if (method === "GET") {
        if (url.pathname === "/") return { location: "/reports" };
        // Every page shows how many reports and feedback threads wait (both read the open ones by default).
        const [body, waiting] = await Promise.all([get(db, url), pending(db)]);
        return { status: 200, body: typeof body === "string" ? withPending(body, ...waiting) : body };
      }
      if (method !== "POST") return { status: 405, body: errorPage("不支持", "不支持这种请求。", back) };
      // A form must come from the console's own pages: any other origin (another site, another port
      // here, a sandboxed frame's "null") is refused. Browsers send Origin with every POST.
      if (request.headers.origin !== `http://${host}`) {
        return { status: 403, body: errorPage("已拒绝", "这个请求不是从管理后台的页面发出的。", back) };
      }
      const form = await readForm(request);
      back = backPath(form);
      const shown = await post(db, url.pathname, form);
      return shown === null ? { location: `${back}${back.includes("?") ? "&" : "?"}ok=1` }
        : { status: 200, body: withPending(shown, ...await pending(db)) };
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
        response.writeHead(303, { ...HEADERS, Location: result.location }).end();
      } else if (typeof result.body === "string") {
        response.writeHead(result.status, { ...HEADERS, "Content-Type": "text/html; charset=utf-8" }).end(result.body);
      } else {
        response.writeHead(result.status, { ...HEADERS, "Content-Type": result.body.type,
          "Content-Disposition": `attachment; filename="export.xlsx"; filename*=UTF-8''${encodeURIComponent(result.body.name)}` }).end(result.body.bytes);
      }
    });
  });
}
