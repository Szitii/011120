/**
 * The admin console's pages, as plain HTML with no script. Everything that came from a user or the
 * database goes through `html`, which escapes it; only values built by `html` itself are trusted.
 */

import { flyMonthCents, machineCents, volumeCents, type Hosts } from "./fly.ts";
import type { Balance, VendorStatus } from "./vendors.ts";

// ---------- what the console functions return (schema companion_admin) ----------

export interface Actor {
  id: string; kind: "HUMAN" | "AI"; displayName: string | null; handle: string | null;
  ownerId: string; ownerStatus: string; twinId: string | null; twinStatus: string | null;
}
export interface Report {
  id: string; createdAt: string; reason: string; details: string; targetType: "ACTOR" | "POST" | "COMMENT"; targetId: string;
  evidence: Record<string, unknown>; status: "SUBMITTED" | "REVIEWED"; resolution: string | null; note: string | null;
  reviewedBy: string | null; reviewedAt: string | null; reporter: Actor; target: Actor; live: boolean | null; others: number;
}
export interface ReportQueue { pending: number; items: Report[] }
export interface OwnerRow {
  id: string; email: string | null; displayName: string | null; status: string; createdAt: string; companions: number; posts: number;
}
export interface OwnerList { items: OwnerRow[]; more: boolean }
export interface Content {
  id: string; postId?: string; author: { kind: string; displayName: string | null }; body: string; source: string;
  createdAt: string; deletedAt: string | null; removedByAdmin: boolean;
}
export interface OwnerDetail {
  owner: { id: string; email: string | null; displayName: string | null; status: string; createdAt: string };
  companions: { id: string; status: string; displayName: string | null; twinId: string | null; twinStatus: string | null }[];
  posts: Content[]; comments: Content[];
}
export interface Member { companionId: string; displayName: string | null }
export interface ChatList {
  items: { id: string; title: string | null; direct: boolean; members: Member[]; createdAt: string; activeAt: string; messages: number }[];
}
export interface ChatPage {
  chat: { id: string; ownerId: string; title: string | null; direct: boolean; members: Member[] };
  items: { id: string; companionId: string | null; body: string | null; action?: string | null; status: string; failure: string | null; createdAt: string }[];
  next: { at: string; id: string } | null;
}
export interface Models {
  switches: { scope: "ALL" | "PROVIDER" | "MODEL"; key: string; enabled: boolean; note: string | null; updatedAt: string }[];
  quota: { dailyCalls: number; dailyCostMinor: number; currency: string; updatedAt: string };
  cap: { enabled: boolean; dailyCostMinor: number; currency: string; spentTodayMinor: number; updatedAt: string };
  wallet: { enabled: boolean; welcomeCredits: number; creditsPerCent: number; backgroundFloor: number; updatedAt: string };
}
export interface Feature { key: string; enabled: boolean; updatedAt: string }
/** The feature switches the console knows, with what each one means (migration 0050). */
export const FEATURES: Readonly<Record<string, string>> = {
  GROUP_CHAT_CREATE: "新建群聊",
  GROUP_CHAT_SEND: "在已有群聊里发消息",
  COMMUNITY_NEW_NOTICES: "社区的点赞通知和 @提及通知（新版 App 上线后再开）",
  COMPANION_ACTIONS: "家机在私聊里主动做小家动作，比如抱抱主人（新版 App 上线后再开）",
  VOICE_INPUT: "主人发语音（语音转文字的账户充值后再开；关着时 App 不显示按住说话）",
};
export interface Spend {
  from: string; to: string;
  totals: { currency: string; calls: number; costMinor: number }[];
  byDay: { day: string; provider: string; model: string; currency: string; calls: number; failed: number;
    inputTokens: number; outputTokens: number; costMinor: number }[];
  byCompanion: { companionId: string; ownerId: string; displayName: string | null; currency: string; calls: number; costMinor: number }[];
}
/** One month of everything the platform paid for (companion_admin.costs, migration 0058). Money in USD cents. */
export interface Costs {
  month: string; from: string; to: string;
  totals: { modelCents: number; hearCents: number; speakPoints: number; speakOverCents: number; fixedCents: number };
  prices: { planPoints: number; speakCentsPerMillion: number; hearCentsPerHour: number; updatedAt: string };
  fixed: { item: string; cents: number; note: string | null; updatedAt: string }[];
  days: { day: string; modelCents: number; modelCalls: number; hearSeconds: number; hears: number; hearCents: number;
    speakPoints: number; speaks: number }[];
  models: Spend;
}
export interface LogPage {
  items: { id: number; operator: string; action: string; targetType: string; targetId: string; ownerId: string | null;
    reason: string; detail: Record<string, unknown>; createdAt: string }[];
  next: number | null;
}
/** One model of the server's catalog, as far as the switches care. */
export interface CatalogEntry { readonly name: string; readonly provider: string; readonly model: string }

// ---------- escaping ----------

/** HTML that is safe to send: built only by `html`. */
class Safe {
  readonly text: string;
  constructor(text: string) { this.text = text; }
}
const ESCAPES: Readonly<Record<string, string>> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const piece = (value: unknown): string =>
  value instanceof Safe ? value.text
    : Array.isArray(value) ? value.map(piece).join("")
    : value === null || value === undefined || value === false ? ""
    : String(value).replace(/[&<>"']/g, c => ESCAPES[c]!);
/** A template whose inserted values are escaped, except other `html` results and lists of them. */
function html(strings: TemplateStringsArray, ...values: unknown[]): Safe {
  return new Safe(strings.reduce((out, s, i) => out + s + (i < values.length ? piece(values[i]) : ""), ""));
}

// ---------- words ----------

const REASONS: Readonly<Record<string, string>> = { SPAM: "垃圾信息", HARASSMENT: "骚扰", HARMFUL: "有害内容", PRIVACY: "隐私", OTHER: "其他" };
export const RESOLUTIONS: Readonly<Record<string, string>> = {
  NONE: "不处理", REMOVED: "移除内容", TWIN_SUSPENDED: "停用家机的社区身份", OWNER_SUSPENDED: "封禁主人",
};
const OWNER_STATUS: Readonly<Record<string, string>> = { ACTIVE: "正常", SUSPENDED: "已封禁", DELETED: "已删除" };
const TWIN_STATUS: Readonly<Record<string, string>> = { ACTIVE: "正常", LIMITED: "受限", SUSPENDED: "已停用" };
const COMPANION_STATUS: Readonly<Record<string, string>> = { DRAFT: "草稿", ACTIVE: "正常", PAUSED: "已暂停", QUARANTINED: "已隔离", DELETED: "已删除" };
const SOURCES: Readonly<Record<string, string>> = {
  HUMAN_MANUAL: "本人发的", OWNER_PROXY: "主人代发", PLATFORM_MODEL: "平台模型写的", EXTERNAL_AGENT: "外部家机写的",
};
/** What a report or a log row is about. */
const TARGETS: Readonly<Record<string, string>> = {
  ACTOR: "账号", POST: "帖子", COMMENT: "评论", OWNER: "主人", SOCIAL_TWIN: "家机", REPORT: "举报", CHAT: "会话",
  CHAT_QUOTA: "每日额度", ALL: "全部模型", PROVIDER: "厂商", MODEL: "模型", FIXED_COST: "固定月费", VOICE_PRICES: "语音单价",
};
const ACTIONS: Readonly<Record<string, string>> = {
  REMOVE_POST: "移除帖子", REMOVE_COMMENT: "移除评论", RESTORE_POST: "恢复帖子", RESTORE_COMMENT: "恢复评论",
  SUSPEND_TWIN: "停用家机", RESTORE_TWIN: "恢复家机", SUSPEND_OWNER: "封禁主人", RESTORE_OWNER: "解封主人",
  RESOLVE_REPORT: "处理举报", MODEL_SWITCH: "模型开关", CHAT_QUOTA: "每日额度", READ_CHAT: "查看私聊",
  FIXED_COST: "固定月费", VOICE_PRICES: "语音单价",
};
const MESSAGE_STATUS: Readonly<Record<string, string>> = {
  PENDING: "(正在回复)", FAILED: "(回复失败)", BLOCKED: "(被安全扫描拦下)", PASSED: "(选择不说话)",
};
const ACTION_WORD: Readonly<Record<string, string>> = { WAVE: "(小家动作:挥手)", PAT_HEAD: "(小家动作:摸头)", HUG: "(小家动作:抱抱)", CUDDLE: "(小家动作:贴贴)" };
const word = (table: Readonly<Record<string, string>>, key: string | null) => key === null ? "" : table[key] ?? key;

/** A moment as the operator reads it, in the IANA time zone `zone`. */
const time = (zone: string, value: string | null) => value === null ? "" :
  new Date(value).toLocaleString("zh-CN", { timeZone: zone, hour12: false });
const money = (minor: number, currency: string) => `${(minor / 100).toFixed(2)} ${currency}`;
/** Dollars from cents that may be a fraction: a little that is not nothing shows as "< $0.01". */
const usd = (cents: number) => cents > 0 && cents < 1 ? "< $0.01" : `$${(Math.round(cents) / 100).toFixed(2)}`;
const count = (n: number) => Math.round(n).toLocaleString("en-US");
const name = (value: string | null) => value ?? "(未命名)";

// ---------- shared pieces ----------

const STYLE = `
*{box-sizing:border-box}
body{font:14px/1.6 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;margin:0;color:#1f2328;background:#f3f4f6}
a{color:#2563eb}
nav{background:#111827;padding:0 24px;min-height:56px;display:flex;flex-wrap:wrap;align-items:center;gap:4px}
nav b{color:#fff;margin-right:20px;font-size:16px}nav a{color:#cbd5e1;text-decoration:none;font-size:15px;padding:8px 14px;border-radius:8px}
nav a:hover{color:#fff;background:#1f2937}nav a.on{color:#111827;background:#fff;font-weight:600}
main{max-width:1100px;margin:0 auto;padding:20px 16px 60px}
.head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;margin:4px 0 16px}
h1{font-size:22px;margin:0}h2{font-size:15px;margin:0 0 12px}main>h2{margin:28px 0 8px}h2 .links{font-weight:400;font-size:13px;margin-left:8px}
.tools{display:flex;flex-wrap:wrap;align-items:center;gap:8px;color:#6b7280;font-size:13px}.tools form{margin:0}
.btn,button{display:inline-block;font:inherit;font-size:13px;padding:4px 12px;border:1px solid #d1d5db;border-radius:6px;background:#fff;color:#1f2328;
cursor:pointer;text-decoration:none}.btn:hover,button:hover{background:#f3f4f6}.btn.on{background:#e8f0fe;border-color:#93b4f5;color:#1d4ed8}
section.panel{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:16px 20px;margin:16px 0}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:12px 16px;margin:12px 0}
.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;background:#fff}
th,td{border-bottom:1px solid #eef0f3;padding:7px 10px;text-align:left;vertical-align:top}
th{background:#f9fafb;color:#6b7280;font-weight:600;font-size:13px;white-space:nowrap}tr:hover td{background:#fafbfc}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}td:first-child{white-space:nowrap}
blockquote{margin:8px 0;padding:8px 12px;background:#f9fafb;border-left:3px solid #9ca3af;white-space:pre-wrap;word-break:break-word}
form.act{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:8px 0}input,select{font:inherit;padding:4px 8px;border:1px solid #d1d5db;border-radius:6px}
input[name=reason]{flex:1;min-width:200px}
form.sw{display:inline-flex;align-items:center;gap:8px;margin:0;vertical-align:middle}
button.switch,button.switch:hover{position:relative;width:46px;height:28px;padding:0;border:0;border-radius:14px;background:#d1d5db;flex:none;transition:background .2s}
button.switch::after{content:"";position:absolute;top:2px;left:2px;width:24px;height:24px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.3);transition:left .2s}
button.switch.on,button.switch.on:hover{background:#34c759}button.switch.on::after{left:20px}button.switch:focus-visible{outline:2px solid #2563eb;outline-offset:2px}
details.edit{margin-top:12px;padding-top:8px;border-top:1px dashed #e5e7eb}details.edit>summary{cursor:pointer;color:#2563eb;width:max-content}
.muted{color:#6b7280}.tag{display:inline-block;padding:0 8px;border-radius:999px;background:#eef0f3;font-size:13px}
.bad{background:#fde8e8;color:#b42318}.ok{background:#e6f4ea;border:1px solid #b7dfc3;padding:8px 12px;border-radius:8px}
.err{background:#fde8e8;border:1px solid #f1b0b0;padding:8px 12px;border-radius:8px}pre{white-space:pre-wrap;word-break:break-word;margin:4px 0}
.msg{margin:6px 0}.msg b{margin-right:8px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin:16px 0}.cards .card{margin:0}
.cards.hero{grid-template-columns:repeat(auto-fit,minmax(300px,1fr))}
.big{font-size:28px;font-weight:700;line-height:1.25;font-variant-numeric:tabular-nums}.hero .big{font-size:36px}
.total{background:#111827;color:#fff;border-color:#111827}.total .muted{color:#9ca3af}
.warn{border-color:#f5c26b;background:#fffbeb}.alarm{border-color:#f1b0b0;background:#fef2f2}
.bar{height:10px;background:#eef0f3;border-radius:5px;overflow:hidden;margin:8px 0}
.bar span{display:block;height:100%;background:#2563eb}.bar span.over{background:#d1242f}.bar span.near{background:#d97706}
.seg{display:inline-flex}.seg .btn{border-radius:0;margin-left:-1px}.seg .btn:first-child{border-radius:6px 0 0 6px;margin-left:0}
.seg .btn:last-child{border-radius:0 6px 6px 0}
svg.chart{width:100%;height:auto;display:block}svg.chart text{font-size:12px;fill:#6b7280}svg.chart text.end{fill:#1f2328;font-size:13px}
svg.chart .grid{stroke:#eef0f3}svg.chart rect.hit{fill:transparent}svg.chart rect.hit:hover{fill:rgba(17,24,39,.05)}
.legend{display:flex;flex-wrap:wrap;gap:16px;font-size:13px;color:#4b5563;margin:0 0 6px}
.legend i,.vhead i{display:inline-block;width:12px;height:12px;border-radius:3px;vertical-align:-1px;margin-right:6px}
.links a{margin-right:16px}.vendors{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px;margin:8px 0 16px}.vendors .card{margin:0}
.vhead,.mhead{display:flex;justify-content:space-between;gap:8px}table.lines{table-layout:fixed}table.lines td{padding:6px 0;border-bottom:1px solid #f3f4f6}
table.lines td:first-child{white-space:normal;word-break:break-word}table.lines td.num{width:88px}table.lines .muted{display:block;font-size:12px}table.lines tr:hover td{background:none}
.sub{margin-top:12px;padding-top:10px;border-top:1px solid #f3f4f6}svg.spark{width:100%;height:36px;display:block;margin:4px 0}`;

const NAV: readonly (readonly [string, string])[] = [["/reports", "举报"], ["/owners", "用户与聊天"], ["/stats", "运营数据"], ["/costs", "花费"],
  ["/system", "系统"], ["/models", "模型与额度"], ["/log", "操作日志"]];

/** `tools` goes to the right of the title. */
function page(title: string, at: string, body: Safe, done = false, tools: Safe | "" = ""): string {
  return html`<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · 管理后台</title><style>${new Safe(STYLE)}</style></head><body>
<nav><b>管理后台</b>${NAV.map(([path, label]) => html`<a href="${path}" class="${at === path ? "on" : ""}">${label}</a>`)}</nav>
<main>${done ? html`<p class="ok">操作已完成,已记入日志。</p>` : ""}<div class="head"><h1>${title}</h1>${tools}</div>${body}</main></body></html>`.text;
}

/** A titled white block of the page. */
const panel = (title: string | Safe, body: Safe) => html`<section class="panel"><h2>${title}</h2>${body}</section>`;
/** A change form folded away under a link, so the page reads as the current state first. */
const edit = (label: string, form: Safe) => html`<details class="edit"><summary>${label}</summary>${form}</details>`;
/** When the numbers were read, and a button that reads them again. */
const fresh = (zone: string, now: Date, self: string, more: Safe | "" = "") =>
  html`<div class="tools">${more}<span>数据时间 ${time(zone, now.toISOString())}</span><a class="btn" href="${self}">刷新</a></div>`;
/** A bar filled to `share` (0..1+): blue, amber from 80 %, red past 100 %. */
const meter = (share: number) =>
  html`<div class="bar"><span class="${share > 1 ? "over" : share > 0.8 ? "near" : ""}" style="width:${Math.min(100, Math.round(share * 100))}%"></span></div>`;
const percent = (part: number, whole: number) => whole > 0 ? `${Math.round(part / whole * 100)}%` : "—";

export function errorPage(title: string, message: string, back: string): string {
  return page(title, "", html`<p class="err">${message}</p><p><a href="${back}">返回</a></p>`);
}

/** A form that changes something: the operator must give a reason and tick the box. */
function act(path: string, label: string, back: string, fields: Safe | "" = ""): Safe {
  return html`<form class="act" method="post" action="${path}"><input type="hidden" name="back" value="${back}">${fields}
<input name="reason" required maxlength="500" placeholder="原因(必填,会记入日志)">
<label><input type="checkbox" name="confirm" value="yes" required> 确认</label><button>${label}</button></form>`;
}
/**
 * A switch like a phone's: one click flips it. The reason in the log says which switch and which way;
 * `fields` carries what else the route needs, unchanged.
 */
function toggle(path: string, on: boolean, what: string, back: string, fields: Safe | "" = "", text: Safe | string = ""): Safe {
  return html`<form class="sw" method="post" action="${path}"><input type="hidden" name="back" value="${back}">${fields}
<input type="hidden" name="enabled" value="${on ? "off" : "on"}"><input type="hidden" name="reason" value="点开关:${on ? "关掉" : "打开"}${what}">
<input type="hidden" name="confirm" value="yes"><button class="switch ${on ? "on" : ""}" role="switch" aria-checked="${on ? "true" : "false"}"
 aria-label="${what}" title="${on ? "点一下关掉" : "点一下打开"}"></button>${text}</form>`;
}
const hidden = (name: string, value: string | number) => html`<input type="hidden" name="${name}" value="${String(value)}">`;
const ownerLink = (id: string, label: string | null) => html`<a href="/owners/${id}">${name(label)}</a>`;
const status = (table: Readonly<Record<string, string>>, value: string | null) =>
  html`<span class="tag ${value === "ACTIVE" ? "" : "bad"}">${word(table, value)}</span>`;

function logTable(zone: string, log: LogPage): Safe {
  if (log.items.length === 0) return html`<p class="muted">没有记录。</p>`;
  return html`<table><tr><th>时间</th><th>操作人</th><th>操作</th><th>对象</th><th>原因</th><th>详情</th></tr>${log.items.map(l => html`
<tr><td>${time(zone, l.createdAt)}</td><td>${l.operator}</td><td>${word(ACTIONS, l.action)}</td>
<td>${l.ownerId === null ? html`${word(TARGETS, l.targetType)} ${l.targetId}`
    : html`<a href="/owners/${l.ownerId}">${word(TARGETS, l.targetType)}</a> <span class="muted">${l.targetId}</span>`}</td>
<td>${l.reason}</td><td>${Object.keys(l.detail).length === 0 ? "" : html`<details><summary>查看</summary><pre>${JSON.stringify(l.detail, null, 1)}</pre></details>`}</td></tr>`)}</table>`;
}

// ---------- pages ----------

function reportCard(zone: string, r: Report, back: string): Safe {
  const options = ["NONE", ...(r.targetType === "ACTOR" ? [] : ["REMOVED"]), ...(r.target.kind === "AI" ? ["TWIN_SUSPENDED"] : []), "OWNER_SUSPENDED"];
  const who = (a: Actor) => html`${ownerLink(a.ownerId, a.displayName)} <span class="muted">${a.kind === "AI" ? "家机" : "真人"}</span>`;
  return html`<div class="card">
<div><b>${word(REASONS, r.reason)}</b> · 举报的是${word(TARGETS, r.targetType)} · ${time(zone, r.createdAt)}
${r.others > 0 ? html` · <span class="tag bad">同一对象还有 ${r.others} 条待处理举报,会一起结案</span>` : ""}</div>
<div>举报人:${who(r.reporter)} 被举报:${who(r.target)}
 主人${status(OWNER_STATUS, r.target.ownerStatus)}${r.target.twinStatus === null ? "" : html` 家机${status(TWIN_STATUS, r.target.twinStatus)}`}</div>
${r.details === "" ? "" : html`<div>举报说明:${r.details}</div>`}
<div class="muted">举报时的内容快照${r.live === null ? "" : r.live ? "(现在还能看到)" : "(现在已经看不到)"}:</div>
<blockquote>${typeof r.evidence.body === "string" ? r.evidence.body : JSON.stringify(r.evidence, null, 1)}</blockquote>
${r.status === "SUBMITTED"
    ? act(`/reports/${r.id}/resolve`, "结案", back, html`<select name="resolution" required><option value="">怎么处理…</option>${
      options.map(o => html`<option value="${o}">${word(RESOLUTIONS, o)}</option>`)}</select>`)
    : html`<div>处理结果:<b>${word(RESOLUTIONS, r.resolution)}</b> · ${r.reviewedBy} · ${time(zone, r.reviewedAt)}<br>原因:${r.note}</div>`}
</div>`;
}

export function reportsPage(zone: string, queue: ReportQueue, state: "SUBMITTED" | "REVIEWED", done: boolean): string {
  const back = `/reports?status=${state}`;
  return page("举报", "/reports", html`
${queue.items.length === 0 ? html`<p class="muted">${state === "SUBMITTED" ? "没有待处理的举报。" : "还没有处理过的举报。"}</p>` : ""}
${queue.items.map(r => reportCard(zone, r, back))}
${queue.items.length === 100 ? html`<p class="muted">只显示前 100 条。</p>` : ""}`, done, html`<div class="tools">
<a class="btn ${state === "SUBMITTED" ? "on" : ""}" href="/reports?status=SUBMITTED">待处理(${queue.pending})</a>
<a class="btn ${state === "REVIEWED" ? "on" : ""}" href="/reports?status=REVIEWED">已处理</a><a class="btn" href="${back}">刷新</a></div>`);
}

export function ownersPage(zone: string, list: OwnerList, search: string): string {
  return page("用户", "/owners", html`<form method="get" action="/owners" class="act">
<input name="q" value="${search}" placeholder="邮箱或名字的一部分,或完整的主人编号"><button>搜索</button></form>
${list.more ? html`<p class="muted">结果超过 100 个,只显示最新的 100 个。请用搜索缩小范围。</p>` : ""}
<p class="muted">要看某个人的聊天记录:点他那一行的“聊天记录”,再点某个会话,填写原因后就能看。</p>
<div class="scroll"><table><tr><th>邮箱</th><th>名字</th><th>状态</th><th>家机</th><th>帖子</th><th>注册时间</th><th></th></tr>${list.items.map(o => html`
<tr><td><a href="/owners/${o.id}">${o.email ?? "(没有邮箱)"}</a></td><td>${name(o.displayName)}</td><td>${status(OWNER_STATUS, o.status)}</td>
<td>${o.companions}</td><td>${o.posts}</td><td>${time(zone, o.createdAt)}</td><td><a href="/owners/${o.id}#chats">聊天记录</a></td></tr>`)}</table></div>
${list.items.length === 0 ? html`<p class="muted">没有找到。</p>` : ""}`);
}

function contentRows(zone: string, kind: "post" | "comment", items: Content[], back: string): Safe {
  if (items.length === 0) return html`<p class="muted">没有。</p>`;
  return html`${items.map(c => html`<div class="card"><div class="muted">${name(c.author.displayName)}(${c.author.kind === "AI" ? "家机" : "真人"})
 · ${time(zone, c.createdAt)} · ${word(SOURCES, c.source)}${c.removedByAdmin ? html` · <span class="tag bad">已被管理员移除</span>`
    : c.deletedAt === null ? "" : html` · <span class="tag">作者已删除</span>`}</div>
<blockquote>${c.body}</blockquote>
${c.removedByAdmin ? act(`/content/${kind}/${c.id}/restore`, "恢复", back)
    : c.deletedAt === null ? act(`/content/${kind}/${c.id}/remove`, "移除", back) : ""}</div>`)}`;
}

export function ownerPage(zone: string, detail: OwnerDetail, chats: ChatList, log: LogPage, done: boolean): string {
  const o = detail.owner, back = `/owners/${o.id}`, suspended = o.status === "SUSPENDED";
  return page(`用户:${o.email ?? name(o.displayName)}`, "/owners", html`
<div class="card">名字:${name(o.displayName)} · 邮箱:${o.email ?? "(没有)"} · 注册:${time(zone, o.createdAt)} · 状态:${status(OWNER_STATUS, o.status)}
<div class="muted">主人编号:${o.id}</div>
${o.status === "DELETED" ? "" : act(`/owners/${o.id}/${suspended ? "restore" : "suspend"}`, suspended ? "解封" : "封禁", back)}
<div class="muted">封禁后:这个人的所有请求立刻被拒绝,他和他的家机在社区里对别人不可见。</div></div>
<h2 id="chats">聊天记录(私聊会话)</h2>${chats.items.length === 0 ? html`<p class="muted">没有会话。</p>` : html`
<table><tr><th>会话</th><th>成员</th><th>消息数</th><th>最近活动</th></tr>${chats.items.map(c => html`
<tr><td><a href="/chats/${c.id}">${c.title ?? (c.direct ? "一对一" : "群聊")}</a></td><td>${c.members.map(m => name(m.displayName)).join("、")}</td>
<td>${c.messages}</td><td>${time(zone, c.activeAt)}</td></tr>`)}</table>`}
<p class="muted">点会话名打开,要填写原因,每次查看都会记入日志。</p>
<h2>家机</h2>${detail.companions.length === 0 ? html`<p class="muted">没有家机。</p>` : detail.companions.map(c => html`<div class="card">
<b>${name(c.displayName)}</b> <span class="muted">${word(COMPANION_STATUS, c.status)}</span> · 社区身份:${c.twinId === null ? "还没有" : status(TWIN_STATUS, c.twinStatus)}
${c.twinId === null ? "" : act(`/twins/${c.twinId}/${c.twinStatus === "SUSPENDED" ? "restore" : "suspend"}`,
    c.twinStatus === "SUSPENDED" ? "恢复社区身份" : "停用社区身份", back)}</div>`)}
<p class="muted">停用社区身份后:这个家机发不了帖,别人看不到它;和主人的私聊不受影响。</p>
<h2>最近的帖子</h2>${contentRows(zone, "post", detail.posts, back)}
<h2>最近的评论</h2>${contentRows(zone, "comment", detail.comments, back)}
<h2>关于这个用户的操作记录</h2>${logTable(zone, log)}
${log.next === null ? "" : html`<p><a href="/log?owner=${o.id}&before=${log.next}">更早的记录</a></p>`}`, done);
}

export function chatGatePage(chatId: string): string {
  return page("查看私聊", "/owners", html`<p>查看私聊内容需要填写原因。每次查看都会记入日志:谁、看了哪个会话、为什么。</p>
<form class="act" method="post" action="/chats/${chatId}"><input type="hidden" name="back" value="/chats/${chatId}">
<input name="reason" required maxlength="500" placeholder="原因(必填,会记入日志)">
<button>查看</button></form>`);
}

export function chatPage(zone: string, chat: ChatPage, reason: string): string {
  const names = new Map(chat.chat.members.map(m => [m.companionId, name(m.displayName)]));
  const speaker = (id: string | null) => id === null ? "主人" : names.get(id) ?? "(已离开的家机)";
  return page(`私聊:${chat.chat.title ?? (chat.chat.direct ? "一对一" : "群聊")}`, "/owners", html`
<p><a href="/owners/${chat.chat.ownerId}">回到这个用户</a> · 成员:${chat.chat.members.map(m => name(m.displayName)).join("、")}</p>
<p class="muted">本次查看已记入日志,原因:${reason}</p>
${chat.next === null ? html`<p class="muted">已经是最早的消息。</p>` : html`<form method="post" action="/chats/${chat.chat.id}">
<input type="hidden" name="back" value="/chats/${chat.chat.id}"><input type="hidden" name="reason" value="${reason}">
<input type="hidden" name="at" value="${chat.next.at}">
<input type="hidden" name="id" value="${chat.next.id}"><button>更早的消息</button></form>`}
<div class="card">${chat.items.length === 0 ? html`<span class="muted">没有消息。</span>` : [...chat.items].reverse().map(m => html`
<div class="msg"><b>${speaker(m.companionId)}</b><span class="muted">${time(zone, m.createdAt)}</span>
<pre>${m.body ?? html`<span class="muted">${m.action ? word(ACTION_WORD, m.action)
  : `${word(MESSAGE_STATUS, m.status)}${m.failure === null ? "" : ` ${m.failure}`}`}</span>`}</pre></div>`)}</div>`);
}

/** Whether a catalog model can be called now, and which switch stops it. */
function switchState(models: Models, entry: CatalogEntry): string {
  const off = (scope: string, key: string) => models.switches.some(s => s.scope === scope && s.key === key && !s.enabled);
  return off("ALL", "*") ? "关(全部关闭)" : off("PROVIDER", entry.provider) ? "关(厂商关闭)"
    : off("MODEL", `${entry.provider}/${entry.model}`) ? "关(模型关闭)" : "开";
}

/** The switch targets an operator may pick: everything, each provider, each model of the catalog. */
export function switchTargets(catalog: readonly CatalogEntry[]): { value: string; label: string }[] {
  return [{ value: "ALL:*", label: "全部平台模型" },
    ...[...new Set(catalog.map(m => m.provider))].map(p => ({ value: `PROVIDER:${p}`, label: `厂商 ${p}` })),
    ...catalog.map(m => ({ value: `MODEL:${m.provider}/${m.model}`, label: `模型 ${m.name}(${m.provider}/${m.model})` }))];
}

export function modelsPage(zone: string, now: Date, models: Models, catalog: readonly CatalogEntry[], features: readonly Feature[],
  done: boolean, vendors: readonly VendorStatus[] = []): string {
  const q = models.quota, w = models.wallet, back = "/models";
  const offModels = catalog.filter(m => switchState(models, m) !== "开").length;
  const ownOn = (scope: string, key: string) => !models.switches.some(s => s.scope === scope && s.key === key && !s.enabled);
  const gift = w.welcomeCredits > 0 ? w.welcomeCredits : 1000;
  return page("模型与额度", "/models", html`
<div class="cards">
<div class="card ${offModels > 0 ? "warn" : ""}"><div class="muted">平台模型</div><div class="big">${catalog.length - offModels} / ${catalog.length}</div>
<div class="muted">${offModels > 0 ? `有 ${offModels} 个关着` : "全部开着"}</div></div>
<div class="card"><div class="muted">每个家机每天免费</div><div class="big">${q.dailyCalls} 次</div><div class="muted">最多 ${money(q.dailyCostMinor, q.currency)}</div></div>
<div class="card"><div class="muted">主人积分钱包</div><div class="big">${w.enabled ? "开" : "关"}</div><div class="muted">每 1 分 = ${w.creditsPerCent} 积分</div></div>
<div class="card ${w.welcomeCredits > 0 ? "" : "warn"}"><div class="muted">新人送积分</div><div class="big">${w.welcomeCredits > 0 ? "开" : "关"}</div>
<div class="muted">${w.welcomeCredits > 0 ? `每个新主人 ${count(w.welcomeCredits)} 积分${w.enabled ? "" : "(钱包关着,暂时不送)"}` : "新主人不送积分"}</div></div>
</div>
${vendors.length === 0 ? "" : panel("模型厂商", html`<div class="scroll"><table><tr><th>厂商</th><th>模型</th><th>线上服务器的 Key</th><th>余额(实时)</th><th></th></tr>
${vendors.map(v => html`<tr><td>${vendorName(v.key)}</td><td>${catalog.filter(m => m.provider === v.key).map(m => m.name).join("、")}</td>
<td>${v.serverKey === null ? html`<span class="tag bad">没有</span> <span class="muted">${v.keyEnv}</span>` : "why" in v.serverKey
    ? html`<span class="muted">看不到:${v.serverKey.why}</span>` : html`<span class="tag">已设置</span> <span class="muted">更新于 ${time(zone, v.serverKey.at)}</span>`}</td>
<td>${v.balance === null ? html`<span class="muted">${v.balanceNote}</span>` : balanceText(v.balance)}</td><td class="links">${billingLink(v.key)}</td></tr>`)}</table></div>
<p class="muted">Key 只放在服务器的密钥里,后台看得到有没有、什么时候换过,看不到 Key 本身,也改不了:这样即使有人进了后台,也换不掉线上用的 Key。
要加一家或换 Key,找 Claude 弹出输入框,Key 直接存进服务器,不经过聊天。余额每次打开这页时从厂商那里读。</p>`)}
${panel("模型开关", html`<div class="scroll"><table><tr><th>开关</th><th>厂商 / 模型名</th><th>现在</th></tr>${switchTargets(catalog).map(t => {
    const cut = t.value.indexOf(":"), scope = t.value.slice(0, cut), key = t.value.slice(cut + 1), on = ownOn(scope, key);
    const entry = scope === "MODEL" ? catalog.find(m => `${m.provider}/${m.model}` === key) : undefined;
    const state = entry === undefined ? (on ? "开" : "关") : switchState(models, entry);
    const text = entry?.name ?? (scope === "ALL" ? html`<b>全部平台模型</b>` : `${vendorName(key)}的全部模型`);
    return html`<tr><td>${toggle("/models/switch", on, t.label, back, hidden("target", t.value), text)}</td><td>${scope === "ALL" ? "" : key}</td><td><span class="tag ${state === "开" ? "" : "bad"}">${state}</span></td></tr>`;
  })}</table></div>
<p class="muted">点一下就生效,并记进操作日志。关掉后:回复显示“平台模型暂时关闭”,不扣额度。上面的开关关着时,下面的模型也停,“现在”一栏写的是实际能不能用。</p>
${models.switches.length === 0 ? "" : html`<details class="edit"><summary>开关的历史</summary><div class="scroll"><table>
<tr><th>开关</th><th>状态</th><th>最近一次的原因</th><th>时间</th></tr>${models.switches.map(s => html`
<tr><td>${word(TARGETS, s.scope)} ${s.key}</td><td>${s.enabled ? "开" : "关"}</td><td>${s.note}</td><td>${time(zone, s.updatedAt)}</td></tr>`)}</table></div></details>`}`)}
${panel("功能开关", html`<div class="scroll"><table><tr><th>功能</th><th>改于</th></tr>${features.map(f => html`
<tr><td>${toggle("/models/feature", f.enabled, word(FEATURES, f.key), back, hidden("key", f.key), word(FEATURES, f.key))}</td><td>${time(zone, f.updatedAt)}</td></tr>`)}</table></div>
<p class="muted">点一下就生效。群聊关掉后:不能新建;已有群聊只能看和删除,不能发消息。单聊不受影响。</p>`)}
${panel("每个家机每天的免费额度", html`
<p>现在:每天 ${q.dailyCalls} 次调用、${money(q.dailyCostMinor, q.currency)}。改动只对之后新建的额度生效(每天 UTC 0 点,即北京时间 8 点新建)。</p>
${edit("修改额度", act("/models/quota", "修改额度", back, html`<label>次数 <input name="calls" type="number" min="0" max="100000" required value="${q.dailyCalls}"></label>
<label>金额(分)<input name="cents" type="number" min="0" required value="${q.dailyCostMinor}"></label>`))}`)}
${panel("新人送积分", html`
<div>${toggle("/models/welcome", w.welcomeCredits > 0, "新人送积分", back, hidden("welcome", gift),
    w.welcomeCredits > 0 ? `开:每个新主人第一次用钱包时送 ${count(w.welcomeCredits)} 积分(只送一次)` : "关:新主人不送积分")}${
    w.enabled ? "" : html` <span class="muted">积分钱包关着时,不管这里开不开都不送。</span>`}</div>
${w.welcomeCredits > 0 ? edit("改送多少", act("/models/welcome", "保存", back, html`${hidden("enabled", "on")}
<label>送多少积分 <input name="welcome" type="number" min="1" max="100000000" required value="${w.welcomeCredits}"></label>`)) : ""}
<p class="muted">关掉期间注册的主人,之后再打开时,会在他下一次用钱包时补送一次。${w.welcomeCredits > 0 ? "" : `打开时送 ${count(gift)} 积分,打开后可以改。`}</p>`)}
${panel("主人积分钱包", html`
<div>${toggle("/models/wallet", w.enabled, "主人积分钱包", back, html`${hidden("welcome", w.welcomeCredits)}${hidden("rate", w.creditsPerCent)}${hidden("floor", w.backgroundFloor)}`,
    w.enabled ? "开" : "关(只按每个家机每天的免费额度限制)")}</div>
<p>新主人送 ${w.welcomeCredits} 积分;模型花费每 1 分 = ${w.creditsPerCent} 积分;写日记要给聊天留 ${w.backgroundFloor} 积分。调用失败不扣积分。</p>
${edit("修改钱包规则", act("/models/wallet", "修改钱包规则", back, html`${hidden("enabled", w.enabled ? "on" : "off")}
<label>新人赠送 <input name="welcome" type="number" min="0" required value="${w.welcomeCredits}"></label>
<label>每分积分 <input name="rate" type="number" min="1" required value="${w.creditsPerCent}"></label>
<label>给聊天保留 <input name="floor" type="number" min="0" required value="${w.backgroundFloor}"></label>`))}
${edit("给某个主人调整积分", act("/models/credit", "调整积分", back, html`<input name="owner" placeholder="主人编号" required size="38">
<label>积分(可以是负数)<input name="credits" type="number" required></label>`))}
<p class="muted">调整的是赠送积分;负数最多扣到 0。改赠送数量只影响之后第一次用钱包的主人。</p>`)}
<p class="muted">每一笔花了多少钱、全平台每天的花费上限,在<a href="/costs">“花费”页</a>。</p>`, done, fresh(zone, now, back));
}

// ---------- charts: inline SVG, no script; the hover text of a day is the SVG <title> ----------

interface Series { readonly name: string; readonly color: string; readonly values: readonly number[] }
/** The reference categorical palette, in its fixed order: a series gets its slot by what it is, never by rank. */
const SLOTS = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"] as const;
const INK = "#111827";
const r1 = (n: number) => Math.round(n * 10) / 10;
/** A round number at or above `max`, for the top of a y axis. */
function niceMax(max: number): number {
  if (max <= 0) return 1;
  const unit = 10 ** Math.floor(Math.log10(max));
  return [1, 2, 2.5, 5, 10].map(f => f * unit).find(v => v >= max)!;
}

/** Lines over days (or months), one y axis. Up to four series are also named at their line's end. */
function lineChart(labels: readonly string[], series: readonly Series[], format: (n: number) => string, label: (d: string) => string, whole = false): Safe {
  if (labels.length === 0 || series.length === 0) return html`<p class="muted">还没有数据。</p>`;
  const named = series.length <= 4, W = 1000, H = 240, L = 64, R = named ? 110 : 16, T = 12, B = 28;
  // Counts get whole-number ticks: the top is a multiple of the four steps.
  const top = niceMax(Math.max(0, ...series.flatMap(s => s.values))), max = whole ? Math.max(4, Math.ceil(top / 4) * 4) : top;
  const span = W - L - R, step = labels.length > 1 ? span / (labels.length - 1) : span;
  const x = (i: number) => r1(labels.length === 1 ? L + span / 2 : L + i * step);
  const y = (v: number) => r1(T + (H - T - B) * (1 - v / max));
  const every = Math.ceil(labels.length / 10);
  const ends = series.map(s => ({ name: s.name, y: y(s.values.at(-1) ?? 0) })).sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) ends[i]!.y = Math.max(ends[i]!.y, ends[i - 1]!.y + 15);
  // …and none below the x axis: push the lowest back up, and the others above it.
  for (let i = ends.length - 1; i >= 0; i--) ends[i]!.y = Math.min(ends[i]!.y, i === ends.length - 1 ? H - B - 4 : ends[i + 1]!.y - 15);
  return html`${series.length > 1 ? html`<div class="legend">${series.map(s => html`<span><i style="background:${s.color}"></i>${s.name}</span>`)}</div>` : ""}
<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${series.map(s => s.name).join("、")}">
${[0, 0.25, 0.5, 0.75, 1].map(f => html`<line class="grid" x1="${L}" x2="${W - R}" y1="${y(max * f)}" y2="${y(max * f)}"/><text x="${L - 8}" y="${y(max * f) + 4}" text-anchor="end">${format(max * f)}</text>`)}
${labels.map((d, i) => i % every === 0 || i === labels.length - 1 ? html`<text x="${x(i)}" y="${H - 8}" text-anchor="middle">${label(d)}</text>` : "")}
${series.map(s => html`<polyline fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" points="${s.values.map((v, i) => `${x(i)},${y(v)}`).join(" ")}"/>
${labels.length <= 31 ? s.values.map((v, i) => html`<circle cx="${x(i)}" cy="${y(v)}" r="3" fill="${s.color}"/>`) : ""}`)}
${named ? ends.map(e => html`<text class="end" x="${W - R + 8}" y="${e.y + 4}">${e.name}</text>`) : ""}
${labels.map((d, i) => html`<rect class="hit" x="${r1(x(i) - step / 2)}" y="${T}" width="${r1(step)}" height="${H - T - B}"><title>${d}
${series.map(s => `${s.name}:${format(s.values[i] ?? 0)}`).join("\n")}</title></rect>`)}
</svg>`;
}

/** A tiny line of one model's days, no axes. */
function spark(values: readonly number[], color: string): Safe {
  const max = Math.max(0, ...values), W = 160, H = 36;
  return html`<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><polyline fill="none" stroke="${color}" stroke-width="2"
 vector-effect="non-scaling-stroke" points="${values.map((v, i) => `${r1(values.length === 1 ? W / 2 : i * W / (values.length - 1))},${r1(H - 3 - (max > 0 ? v / max : 0) * (H - 6))}`).join(" ")}"/></svg>`;
}

/** Each day from `from` to `to`, but not past today (UTC). */
function daysOf(from: string, to: string, now: Date): string[] {
  const last = Math.min(Date.parse(`${to}T00:00:00Z`), Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`));
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= last; t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}
/** From the first item that has anything in it: the days (or months) before the App started are left out. */
const fromFirst = <T>(items: readonly T[], used: (item: T) => boolean): T[] => {
  const i = items.findIndex(used);
  return i < 0 ? [] : items.slice(i);
};
/** The months of a year from the first one anything was used in (fixed bills alone do not count: they are filled in for every month). */
export const usedMonths = (months: readonly Costs[]) => fromFirst(months, c => c.days.length > 0 || c.models.byDay.length > 0);
const compact = (n: number) => n >= 1e6 ? `${r1(n / 1e6)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : count(n);
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

// ---------- vendors: the companies the money goes to ----------

/** Display names; the keys are the model catalog's provider names, plus the bills that are not models. */
const VENDOR_NAMES: Readonly<Record<string, string>> = {
  anthropic: "Anthropic", deepseek: "DeepSeek", openai: "OpenAI", qwen: "通义千问", moonshot: "Moonshot", zhipu: "智谱",
  openrouter: "OpenRouter", minimax: "MiniMax", supabase: "Supabase", fly: "Fly.io",
};
/** Where each company shows its own bill and usage: the real numbers. */
const BILLING: Readonly<Record<string, string>> = {
  anthropic: "https://console.anthropic.com/settings/billing", deepseek: "https://platform.deepseek.com/usage",
  openai: "https://platform.openai.com/usage", qwen: "https://bailian.console.aliyun.com/", moonshot: "https://platform.moonshot.cn/console/account",
  zhipu: "https://open.bigmodel.cn/finance/overview", openrouter: "https://openrouter.ai/activity", minimax: "https://platform.minimax.io/user-center/basic-information",
  supabase: "https://supabase.com/dashboard/org/_/usage", fly: "https://fly.io/dashboard/personal/billing",
};
const billingLink = (key: string) => BILLING[key] === undefined ? ""
  : html`<a href="${BILLING[key]}" target="_blank" rel="noreferrer">去 ${vendorName(key)} 看账单 ↗</a>`;
const CURRENCY_SIGN: Readonly<Record<string, string>> = { CNY: "¥", USD: "$" };
/** What a company says is left: each currency, and whether it is enough to keep calling. */
function balanceText(b: Balance): Safe {
  if (!b.ok) return html`<span class="err">读不到余额:${b.why}</span>`;
  const left = b.money.map(m => `${CURRENCY_SIGN[m.currency] ?? `${m.currency} `}${m.total.toFixed(2)}`).join(" + ") || "0";
  return html`<b>${left}</b>${b.enough ? "" : html` <span class="tag bad">余额不够,调用会失败</span>`}${b.money.some(m => m.granted > 0)
    ? html` <span class="muted">(其中赠送 ${b.money.map(m => `${CURRENCY_SIGN[m.currency] ?? ""}${m.granted.toFixed(2)}`).join(" + ")})</span>` : ""}`;
}
/** Each vendor's colour, the same on every chart. */
const VENDOR_COLORS: Readonly<Record<string, string>> = {
  anthropic: SLOTS[0], minimax: SLOTS[1], deepseek: SLOTS[2], openai: SLOTS[3], qwen: SLOTS[4], moonshot: SLOTS[5], zhipu: SLOTS[6], openrouter: SLOTS[7],
};
const vendorColor = (key: string) => VENDOR_COLORS[key] ?? "#6b7280";
const vendorName = (key: string) => key === "other" ? "其他" : VENDOR_NAMES[key] ?? key;
/** Which company a fixed bill belongs to, from its name ("Fly 服务器" → fly), or other. */
export function billVendor(item: string): string {
  const lower = item.toLowerCase();
  return Object.keys(VENDOR_NAMES).find(k => lower.includes(k) || lower.includes(VENDOR_NAMES[k]!.toLowerCase())) ?? "other";
}

export interface ModelMonth {
  provider: string; model: string; currency: string; calls: number; failed: number; inputTokens: number; outputTokens: number;
  costMinor: number; perDay: Map<string, number>;
}
export interface Vendor {
  key: string; name: string; cents: number; usageCents: number; fixedCents: number;
  lines: { label: string; cents: number; fixed: boolean; note: string | null }[];
  models: ModelMonth[]; perDay: Map<string, number>;
}
const addTo = (map: Map<string, number>, key: string, n: number) => map.set(key, (map.get(key) ?? 0) + n);

/** One month's money per company, biggest first. MiniMax, Supabase and Fly are always there. Money in USD cents. */
export function vendorsOf(c: Costs): Vendor[] {
  const all = new Map<string, Vendor>();
  const of = (key: string): Vendor => {
    if (!all.has(key)) all.set(key, { key, name: vendorName(key), cents: 0, usageCents: 0, fixedCents: 0, lines: [], models: [], perDay: new Map() });
    return all.get(key)!;
  };
  for (const key of ["minimax", "supabase", "fly"]) of(key);
  const models = new Map<string, ModelMonth>();
  for (const d of c.models.byDay) {
    const key = `${d.provider}/${d.model} ${d.currency}`;
    const m = models.get(key) ?? { provider: d.provider, model: d.model, currency: d.currency, calls: 0, failed: 0, inputTokens: 0,
      outputTokens: 0, costMinor: 0, perDay: new Map<string, number>() };
    m.calls += d.calls; m.failed += d.failed; m.inputTokens += d.inputTokens; m.outputTokens += d.outputTokens; m.costMinor += d.costMinor;
    addTo(m.perDay, d.day, d.costMinor);
    models.set(key, m);
  }
  for (const m of [...models.values()].sort((a, b) => b.costMinor - a.costMinor)) {
    const v = of(m.provider);
    v.models.push(m);
    if (m.currency !== "USD") continue;
    v.usageCents += m.costMinor;
    for (const [day, cents] of m.perDay) addTo(v.perDay, day, cents);
  }
  for (const v of all.values()) if (v.models.length > 0) v.lines.push({ label: "AI 模型(按用量)", cents: v.usageCents, fixed: false, note: null });
  const minimax = of("minimax");
  minimax.lines.push({ label: "语音转文字(按时长)", cents: c.totals.hearCents, fixed: false, note: null },
    { label: "文字转语音 · 超出包月", cents: c.totals.speakOverCents, fixed: false, note: null });
  minimax.usageCents += c.totals.hearCents + c.totals.speakOverCents;
  for (const d of c.days) if (d.hearCents > 0) addTo(minimax.perDay, d.day, d.hearCents);
  for (const f of c.fixed) {
    const v = of(billVendor(f.item));
    v.lines.push({ label: f.item, cents: f.cents, fixed: true, note: f.note });
    v.fixedCents += f.cents;
  }
  for (const v of all.values()) v.cents = v.usageCents + v.fixedCents;
  return [...all.values()].sort((a, b) => b.cents - a.cents || a.name.localeCompare(b.name));
}

// ---------- 花费 ----------

/** Month or year, and the export of what is shown. */
const costsTabs = (year: boolean, month: string) => html`<span class="seg"><a class="btn ${year ? "" : "on"}" href="/costs?month=${month}">按月</a><a class="btn ${
  year ? "on" : ""}" href="/costs?year=${month.slice(0, 4)}">按年</a></span>`;

/** The Fly estimate under its card: a month at today's machine sizes, from Fly's list prices. Not in any total. */
const FLY_ESTIMATE_NOTE = "按 Fly 公布的单价和现在每台机器的配置算,运行中的机器按整月算。不含流量和 IP 等小额费用,也没扣 Fly 每月的免费额度;以 Fly 账单为准。";
function flyEstimate(h: Hosts): Safe {
  return h.ok ? html`<div class="sub"><div>估算:按现在的配置,一整月约 <b>${usd(flyMonthCents(h))}</b> <span class="tag">估算</span></div>
<div class="muted">${FLY_ESTIMATE_NOTE}不计入上面的总花费。</div></div>` : html`<div class="sub muted">估算不出:${h.why}</div>`;
}

function vendorCard(v: Vendor, total: number, c: Costs, days: readonly string[], fly: Hosts | null, status: VendorStatus | undefined): Safe {
  const p = c.prices, used = p.planPoints > 0 ? c.totals.speakPoints / p.planPoints : 0;
  return html`<div class="card vendor"><div class="vhead"><span><i style="background:${vendorColor(v.key)}"></i><b>${v.name}</b></span>
<span class="muted">占 ${percent(v.cents, total)}</span></div><div class="big">${usd(v.cents)}</div>
${v.lines.length === 0 ? html`<p class="muted">这个月没有花费。${v.key === "supabase" ? "免费版没有月费。" : html`有月费的话,去 <a href="/costs/settings">费用设置</a> 里填。`}</p>`
    : html`<table class="lines">${v.lines.map(l => html`<tr><td>${l.label}${l.fixed ? html` <span class="tag">固定月费</span>` : ""}${
      l.note ? html` <span class="muted">${l.note}</span>` : ""}</td><td class="num">${usd(l.cents)}</td></tr>`)}</table>`}
${v.key === "minimax" ? html`<div class="sub"><div>语音包月点数:已用 ${count(c.totals.speakPoints)} / ${count(p.planPoints)}(${Math.round(used * 100)}%)</div>${meter(used)}
<div class="muted">${used > 1 ? "已经超出包月,超出部分按量收费。" : used > 0.8 ? "快用完了,用完后按量收费。" : "家机发的每条语音和选声音时的试听按字数用点数。在 MiniMax 网站上自己试的不算。"}</div></div>` : ""}
${v.models.map(m => html`<div class="sub model"><div class="mhead"><b>${m.model}</b><b>${m.currency === "USD" ? usd(m.costMinor) : money(m.costMinor, m.currency)}</b></div>
${spark(days.map(d => m.perDay.get(d) ?? 0), vendorColor(v.key))}
<div class="muted">调用 ${count(m.calls)} 次${m.failed > 0 ? ` · 未成功 ${count(m.failed)}` : ""} · 输入 ${compact(m.inputTokens)} token · 输出 ${compact(m.outputTokens)} token</div></div>`)}
${status?.balance ? html`<div class="sub">${v.name} 账户余额(实时):${balanceText(status.balance)}</div>` : ""}
${v.key === "fly" && fly !== null ? flyEstimate(fly) : ""}
<p class="muted links">${billingLink(v.key)}${v.key === "supabase" || v.key === "fly" ? html`<a href="/system">${v.key === "supabase" ? "数据库" : "主机"}状态 →</a>` : ""}</p></div>`;
}

/**
 * Everything the platform paid for in one month: the total and today first, then a chart, then each company.
 * `cap` is today's platform spend and its ceiling, shown (and changed) only for the running month.
 * `fly` is the servers as they are now, for an estimate under Fly's card; `statuses`, what each model company says is left
 * (both for the running month only).
 */
export function costsPage(zone: string, now: Date, c: Costs, cap: Models["cap"] | null, done: boolean, fly: Hosts | null = null,
  statuses: readonly VendorStatus[] = []): string {
  const t = c.totals, self = `/costs?month=${c.month}`;
  const used = new Set([...c.days.map(d => d.day), ...c.models.byDay.map(d => d.day)]);
  const vendors = vendorsOf(c), days = fromFirst(daysOf(c.from, c.to, now), d => used.has(d));
  const usage = t.modelCents + t.hearCents + t.speakOverCents, total = usage + t.fixedCents;
  const thisMonth = c.month === now.toISOString().slice(0, 7);
  const capShare = cap !== null && cap.dailyCostMinor > 0 ? cap.spentTodayMinor / cap.dailyCostMinor : 0;
  const daily = vendors.filter(v => v.perDay.size > 0).map(v => ({ name: v.name, color: vendorColor(v.key), values: days.map(d => v.perDay.get(d) ?? 0) }));
  const series = daily.length > 1 ? [{ name: "合计", color: INK, values: days.map((_, i) => daily.reduce((n, s) => n + s.values[i]!, 0)) }, ...daily] : daily;
  const m = c.models;
  const tools = html`${costsTabs(false, c.month)}<form method="get" action="/costs" class="act"><input type="month" name="month" value="${c.month}" required><button>看这个月</button></form>
<a class="btn" href="/costs/export.xlsx?month=${c.month}">导出 xlsx</a>`;
  return page(`花费 · ${c.month}`, "/costs", html`
<div class="cards hero">
<div class="card total"><div class="muted">${thisMonth ? "本月到今天" : "这个月"}总花费</div><div class="big">${usd(total)}</div>
<div class="muted">按用量的 ${usd(usage)} + 固定月费 ${usd(t.fixedCents)}</div></div>
${cap === null ? "" : html`<div class="card ${cap.enabled && capShare > 1 ? "alarm" : cap.enabled && capShare > 0.8 ? "warn" : ""}">
<div class="muted">今天(UTC)平台模型已花,含进行中的调用</div><div class="big">${money(cap.spentTodayMinor, cap.currency)}</div>
${cap.enabled ? html`${meter(capShare)}<div class="muted">每天上限 ${money(cap.dailyCostMinor, cap.currency)} · 用了 ${percent(cap.spentTodayMinor, cap.dailyCostMinor)}
</div>` : html`<div class="muted">没有设每天上限</div>`}
<div>${toggle("/costs/cap", cap.enabled, "每天花费上限", self, hidden("dollars", ((cap.dailyCostMinor > 0 ? cap.dailyCostMinor : 500) / 100).toString()),
    cap.enabled ? "上限开着" : `上限关着${cap.dailyCostMinor > 0 ? "" : ",打开时是每天 5 美元"}`)}</div>
${edit("改金额", act("/costs/cap", "保存", self, html`${hidden("enabled", cap.enabled ? "on" : "off")}
<label>每天(美元)<input name="dollars" required inputmode="decimal" size="6" value="${(cap.dailyCostMinor / 100).toString()}"></label>`))}
<div class="muted">到了上限,平台模型当天就不再回复(显示“平台模型暂时关闭”),不扣主人额度。</div></div>`}
</div>
${panel("每天按用量的花费", html`${series.length === 0 ? html`<p class="muted">这个月还没有按用量的花费。</p>` : lineChart(days, series, usd, d => d.slice(5))}
<p class="muted">鼠标停在某一天上,能看到那天每家花了多少。固定月费和语音包月不按天算,不在图里。</p>`)}
<h2>按厂商</h2>
<div class="vendors">${vendors.map(v => vendorCard(v, total, c, days, fly, statuses.find(s => s.key === v.key)))}</div>
${panel("每天明细", c.days.length === 0 ? html`<p class="muted">这个月还没有按用量的花费。</p>` : html`<details class="edit"><summary>展开每天的表</summary><div class="scroll"><table>
<tr><th>日期</th><th class="num">AI 模型</th><th class="num">模型调用</th><th class="num">语音转文字</th><th class="num">识别时长</th>
<th class="num">文字转语音(点数)</th><th class="num">当天合计</th></tr>${c.days.map(d => html`
<tr><td>${d.day}</td><td class="num">${usd(d.modelCents)}</td><td class="num">${count(d.modelCalls)}</td><td class="num">${usd(d.hearCents)}</td>
<td class="num">${count(d.hearSeconds)} 秒 / ${d.hears} 条</td><td class="num">${count(d.speakPoints)} / ${d.speaks} 条</td>
<td class="num"><b>${usd(d.modelCents + d.hearCents)}</b></td></tr>`)}</table></div>
${m.byDay.length === 0 ? "" : html`<div class="scroll"><table>
<tr><th>日期</th><th>厂商 / 模型</th><th class="num">调用</th><th class="num">其中未成功</th><th class="num">输入 token</th><th class="num">输出 token</th><th class="num">花费</th></tr>
${m.byDay.map(d => html`<tr><td>${d.day}</td><td>${d.provider}/${d.model}</td><td class="num">${d.calls}</td><td class="num">${d.failed}</td>
<td class="num">${count(d.inputTokens)}</td><td class="num">${count(d.outputTokens)}</td><td class="num">${d.currency === "USD" ? usd(d.costMinor) : money(d.costMinor, d.currency)}</td></tr>`)}</table></div>`}
</details>
<p class="muted">“未成功”包括调用失败、被安全扫描拦下、结果不明(按占用额全额记账)。主人自带 Key 和自己的 Agent 不花平台的钱,不在这里。</p>`)}
${m.byCompanion.length === 0 ? "" : panel("AI 模型:花费最多的家机(前 20)", html`<div class="scroll"><table><tr><th>家机</th><th class="num">调用</th><th class="num">花费</th></tr>${
    m.byCompanion.map(x => html`
<tr><td>${ownerLink(x.ownerId, x.displayName)}</td><td class="num">${x.calls}</td><td class="num">${x.currency === "USD" ? usd(x.costMinor) : money(x.costMinor, x.currency)}</td></tr>`)}</table></div>`)}
<p class="muted">按 UTC 日期,金额都是美元。每次打开或点“刷新”都直接从数据库读,模型调用和语音一发生就记账。
固定月费和语音单价在 <a href="/costs/settings">费用设置</a> 里改。</p>`, done,
  fresh(zone, now, self, tools));
}

/** A year of months (oldest first), each company's share, like a ledger. */
export function costsYearPage(zone: string, now: Date, year: string, months: readonly Costs[]): string {
  const rows = usedMonths(months).map(c => ({ c, vendors: vendorsOf(c) }));
  const keys = [...new Set(rows.flatMap(r => r.vendors.filter(v => v.cents > 0).map(v => v.key)))];
  const cents = (r: (typeof rows)[number], key: string) => r.vendors.find(v => v.key === key)?.cents ?? 0;
  const sum = (r: (typeof rows)[number]) => r.vendors.reduce((n, v) => n + v.cents, 0);
  const total = rows.reduce((n, r) => n + sum(r), 0);
  const series = [...(keys.length > 1 ? [{ name: "合计", color: INK, values: rows.map(sum) }] : []),
    ...keys.map(k => ({ name: vendorName(k), color: k === "supabase" || k === "fly" || k === "other" ? "#9ca3af" : vendorColor(k), values: rows.map(r => cents(r, k)) }))];
  const self = `/costs?year=${year}`, y = Number(year);
  const tools = html`${costsTabs(true, `${year}-${months.at(-1)?.month.slice(5) ?? "01"}`)}
<span class="seg"><a class="btn" href="/costs?year=${y - 1}">← ${y - 1}</a>${y < now.getUTCFullYear() ? html`<a class="btn" href="/costs?year=${y + 1}">${y + 1} →</a>` : ""}</span>
<a class="btn" href="/costs/export.xlsx?year=${year}">导出 xlsx</a>`;
  return page(`花费 · ${year} 年`, "/costs", html`
<div class="cards hero"><div class="card total"><div class="muted">${year} 年${y === now.getUTCFullYear() ? "到今天" : ""}总花费</div><div class="big">${usd(total)}</div>
<div class="muted">${rows.length} 个月 · 平均每月 ${usd(rows.length > 0 ? total / rows.length : 0)}</div></div></div>
${rows.length === 0 ? html`<p class="muted">${year} 年还没有任何用量。</p>` : html`${panel("每月花费(含固定月费)", lineChart(rows.map(r => r.c.month), series.length > 8 ? series.slice(0, 8) : series, usd, d => `${Number(d.slice(5))}月`))}
${panel("账本", html`<div class="scroll"><table><tr><th>月份</th>${keys.map(k => html`<th class="num">${vendorName(k)}</th>`)}<th class="num">合计</th></tr>
${[...rows].reverse().map(r => html`<tr><td><a href="/costs?month=${r.c.month}">${r.c.month}</a></td>${keys.map(k => html`<td class="num">${usd(cents(r, k))}</td>`)}
<td class="num"><b>${usd(sum(r))}</b></td></tr>`)}
<tr><td><b>全年</b></td>${keys.map(k => html`<td class="num"><b>${usd(rows.reduce((n, r) => n + cents(r, k), 0))}</b></td>`)}<td class="num"><b>${usd(total)}</b></td></tr></table></div>
<p class="muted">点月份看那个月的明细。从第一次有用量的月份开始算。固定月费用的是现在填的数:改了以后,以前的月份也按新数算。</p>`)}`}`, false, fresh(zone, now, self, tools));
}

/** The numbers the costs page is worked out from: fixed monthly bills and voice prices. */
export function costSettingsPage(zone: string, c: Costs, done: boolean): string {
  const p = c.prices, back = "/costs/settings";
  return page("费用设置", "/costs", html`<p><a href="/costs">← 回到花费</a></p>
${panel("固定月费", html`${c.fixed.length === 0 ? html`<p class="muted">还没有填。</p>` : html`<div class="scroll"><table>
<tr><th>项目</th><th>归到</th><th class="num">每月</th><th>备注</th><th>更新时间</th></tr>${c.fixed.map(f => html`
<tr><td>${f.item}</td><td>${vendorName(billVendor(f.item))}</td><td class="num">${usd(f.cents)}</td><td>${f.note}</td><td>${time(zone, f.updatedAt)}</td></tr>`)}</table></div>`}
${act("/costs/fixed", "保存", back, html`<input name="item" required maxlength="60" placeholder="项目,如 Fly 服务器" list="fixed-items">
<datalist id="fixed-items">${c.fixed.map(f => html`<option value="${f.item}">`)}</datalist>
<label>每月(美元)<input name="dollars" required inputmode="decimal" size="8" placeholder="0.00"></label>
<input name="note" maxlength="200" placeholder="备注(可不填)">`)}
<p class="muted">项目名里带上厂商名(Fly、Supabase、MiniMax……),花费页就把它归到那家下面;都不带的归到“其他”。
同名项目会被改成新金额;金额填 <b>删除</b> 就删掉这一项。</p>`)}
${panel("语音单价", html`
<p>包月每月 ${count(p.planPoints)} 点;超出后每百万字符 ${usd(p.speakCentsPerMillion)};语音转文字每小时 ${usd(p.hearCentsPerHour)}。
<span class="muted">更新于 ${time(zone, p.updatedAt)}</span></p>
${act("/costs/prices", "修改单价", back, html`<label>包月点数 <input name="points" type="number" min="0" required value="${p.planPoints}"></label>
<label>超出后每百万字符(美元)<input name="speak" required inputmode="decimal" size="8" value="${(p.speakCentsPerMillion / 100).toString()}"></label>
<label>转文字每小时(美元)<input name="hear" required inputmode="decimal" size="8" value="${(p.hearCentsPerHour / 100).toString()}"></label>`)}
<p class="muted">默认值来自 MiniMax 国际版官网价格(2026-11):Starter 包月 5 美元 100,000 点,speech-2.8-hd 每百万字符 100 美元,语音识别每小时 0.38 美元。</p>`)}`, done);
}

// ---------- 运营数据 ----------

export interface ActivityDay {
  day: string; newOwners: number; chatters: number; ownerMessages: number; replies: number; failed: number;
  voiceIn: number; voiceOut: number; posts: number; aiPosts: number; comments: number; creditsSpent: number; creditsBought: number;
}
/** companion_admin.activity (migration 0059): one month, counts only. */
export interface Activity { month: string; from: string; to: string; owners: number; companions: number; chatters: number; days: ActivityDay[] }

export function statsPage(zone: string, now: Date, a: Activity): string {
  const self = `/stats?month=${a.month}`, thisMonth = a.month === now.toISOString().slice(0, 7);
  const days = fromFirst(a.days, d => Object.values(d).some(v => typeof v === "number" && v > 0));
  const sum = (k: keyof Omit<ActivityDay, "day">) => days.reduce((n, d) => n + d[k], 0);
  const today = thisMonth ? days.at(-1) : undefined;
  const labels = days.map(d => d.day);
  const line = (name: string, slot: number, k: keyof Omit<ActivityDay, "day">) => ({ name, color: SLOTS[slot]!, values: days.map(d => d[k]) });
  const tools = html`<form method="get" action="/stats" class="act"><input type="month" name="month" value="${a.month}" required><button>看这个月</button></form>`;
  const card = (label: string, value: string, note: string) => html`<div class="card"><div class="muted">${label}</div><div class="big">${value}</div><div class="muted">${note}</div></div>`;
  return page(`运营数据 · ${a.month}`, "/stats", html`
<div class="cards">
${card("主人", count(a.owners), "现在的账号数,不含已删除")}
${card("家机", count(a.companions), "不含已删除")}
${card(thisMonth ? "本月聊天的人" : "这个月聊天的人", count(a.chatters), `新注册 ${count(sum("newOwners"))} 人`)}
${today === undefined ? "" : card("今天聊天的人", count(today.chatters), `主人发 ${count(today.ownerMessages)} 条 · 家机回 ${count(today.replies)} 条`)}
${card("消息", count(sum("ownerMessages") + sum("replies")), `主人发 ${count(sum("ownerMessages"))} · 家机回 ${count(sum("replies"))}${sum("failed") > 0 ? ` · 失败 ${count(sum("failed"))}` : ""}`)}
${card("积分消耗", count(sum("creditsSpent")), "钱包开着时,模型调用扣的积分")}
${card("充值", count(sum("creditsBought")), "App 还没有付费功能,接上之后这里会有数")}
</div>
${days.length === 0 ? html`<p class="muted">这个月还没有任何使用。</p>` : html`${panel("每天的人", lineChart(labels, [line("聊天的人", 0, "chatters"), line("新注册", 1, "newOwners")], count, d => d.slice(5), true))}
${panel("每天的消息", lineChart(labels, [line("主人发的", 0, "ownerMessages"), line("家机回的", 1, "replies")], count, d => d.slice(5), true))}
${panel("每天的语音和社区", lineChart(labels, [line("主人发的语音", 0, "voiceIn"), line("家机发的语音", 1, "voiceOut"),
    line("帖子", 2, "posts"), line("评论", 3, "comments")], count, d => d.slice(5), true))}
${panel("每天明细", html`<details class="edit"><summary>展开每天的表</summary><div class="scroll"><table>
<tr><th>日期</th><th class="num">新注册</th><th class="num">聊天的人</th><th class="num">主人发</th><th class="num">家机回</th><th class="num">回复失败</th>
<th class="num">主人语音</th><th class="num">家机语音</th><th class="num">真人帖子</th><th class="num">家机帖子</th><th class="num">评论</th><th class="num">积分消耗</th></tr>
${[...days].reverse().map(d => html`<tr><td>${d.day}</td><td class="num">${count(d.newOwners)}</td><td class="num">${count(d.chatters)}</td>
<td class="num">${count(d.ownerMessages)}</td><td class="num">${count(d.replies)}</td><td class="num">${count(d.failed)}</td><td class="num">${count(d.voiceIn)}</td>
<td class="num">${count(d.voiceOut)}</td><td class="num">${count(d.posts)}</td><td class="num">${count(d.aiPosts)}</td><td class="num">${count(d.comments)}</td>
<td class="num">${count(d.creditsSpent)}</td></tr>`)}</table></div></details>`)}`}
<p class="muted">按 UTC 日期,只有数量,不含任何内容。“聊天的人”= 那天至少发过一条消息的主人。删掉的会话里的消息不再算。帖子数含家机帖子。“家机发的语音”也含选声音时的试听(每次服务器重启后,每个声音第一次试听要重新生成,也花点数)。从第一天有使用的日子开始画。</p>`,
  false, fresh(zone, now, self, tools));
}

// ---------- 系统 ----------

/** companion_admin.system (migration 0059). */
export interface SystemInfo {
  databaseBytes: number; connections: number; maxConnections: number; startedAt: string; version: string;
  tables: { name: string; bytes: number; rows: number | null }[];
}
/** Supabase's free plan: the database may hold 500 MB. */
export const DATABASE_LIMIT_BYTES = 500 * 1024 * 1024;
const MACHINE_STATE: Readonly<Record<string, string>> = { started: "运行中", stopped: "已停止", suspended: "已休眠", starting: "正在启动",
  stopping: "正在停止", replacing: "正在更新", destroyed: "已删除", failed: "失败" };

export function systemPage(zone: string, now: Date, s: SystemInfo, h: Hosts): string {
  const self = "/system", space = s.databaseBytes / DATABASE_LIMIT_BYTES, conns = s.maxConnections > 0 ? s.connections / s.maxConnections : 0;
  const running = h.ok ? h.machines.filter(m => m.state === "started").length : 0;
  const level = (share: number) => share > 0.9 ? "alarm" : share > 0.7 ? "warn" : "";
  return page("系统", "/system", html`
<div class="cards">
<div class="card ${level(space)}"><div class="muted">数据库空间</div><div class="big">${mb(s.databaseBytes)}</div>${meter(space)}
<div class="muted">免费版上限 500 MB · 用了 ${percent(s.databaseBytes, DATABASE_LIMIT_BYTES)}</div></div>
<div class="card ${level(conns)}"><div class="muted">数据库连接</div><div class="big">${s.connections} / ${s.maxConnections}</div>${meter(conns)}
<div class="muted">现在打开的连接 / 最多能开的</div></div>
<div class="card ${h.ok && running < h.machines.length ? "warn" : ""}"><div class="muted">主机</div>
<div class="big">${h.ok ? `${running} / ${h.machines.length}` : "—"}</div><div class="muted">${h.ok ? "在运行的机器 / 全部机器" : "读不到"}</div></div>
${h.ok ? html`<div class="card"><div class="muted">Fly 一整月约 <span class="tag">估算</span></div><div class="big">${usd(flyMonthCents(h))}</div>
<div class="muted">按现在的配置 · 每台的明细在下面</div></div>` : ""}
</div>
${panel(html`主机(Fly.io) <span class="muted links">${billingLink("fly")}</span>`, h.ok ? html`<div class="scroll"><table><tr><th>应用</th><th>机器</th><th>状态</th><th>地区</th><th>配置</th><th class="num">一整月约</th><th>版本</th><th>最近一次停止</th></tr>
${h.machines.map(m => html`<tr><td>${m.app}</td><td>${m.name} <span class="muted">${m.id}</span></td>
<td><span class="tag ${m.state === "started" ? "" : "bad"}">${word(MACHINE_STATE, m.state)}</span></td><td>${m.region}</td>
<td>${m.cpus === null ? "" : `${m.cpus} 核`}${m.memoryMb === null ? "" : ` · ${m.memoryMb} MB 内存`}</td>
<td class="num">${machineCents(m) === null ? html`<span class="muted">停止时只收磁盘</span>` : usd(machineCents(m)!)}</td><td>${m.image}</td>
<td>${m.lastExit === null ? html`<span class="muted">没有记录</span>` : html`${time(zone, m.lastExit.at)}${m.lastExit.code === null ? "" : ` · 退出码 ${m.lastExit.code}`}${
    m.lastExit.oom ? html` <span class="tag bad">内存不够被杀掉</span>` : ""}`}</td></tr>`)}</table></div>
${h.volumes.length === 0 ? "" : html`<div class="scroll"><table><tr><th>应用</th><th>磁盘</th><th>地区</th><th class="num">大小</th><th class="num">一整月约</th></tr>
${h.volumes.map(v => html`<tr><td>${v.app}</td><td>${v.name} <span class="muted">${v.id}</span></td><td>${v.region}</td>
<td class="num">${v.sizeGb} GB</td><td class="num">${usd(volumeCents(v))}</td></tr>`)}</table></div>`}
<p class="muted">“最近一次停止”包括每次部署时的正常重启;如果写着“内存不够被杀掉”,说明机器内存太小了。</p>
<p class="muted">费用是估算:${FLY_ESTIMATE_NOTE}</p>`
    : html`<p class="err">${h.why}</p>`)}
${panel(html`数据库(Supabase 免费版) <span class="muted links">${billingLink("supabase")}</span>`, html`<p>PostgreSQL ${s.version} · 上次重启 ${time(zone, s.startedAt)}</p>
<div class="scroll"><table><tr><th>最大的表</th><th class="num">占用</th><th class="num">大约行数</th></tr>${s.tables.map(t => html`
<tr><td>${t.name}</td><td class="num">${mb(t.bytes)}</td><td class="num">${t.rows === null ? "—" : count(t.rows)}</td></tr>`)}</table></div>
<p class="muted">免费版的限制:数据库 500 MB(满了只能读不能写)、每月流出流量 5 GB、文件存储 1 GB;
连续 7 天没有任何请求,项目会被暂停。流量和文件存储只能在 <a href="https://supabase.com/dashboard">Supabase 控制台</a> 的 Usage 里看。</p>`)}`,
  false, fresh(zone, now, self));
}

export function logPage(zone: string, log: LogPage, owner: string | null): string {
  return page("操作日志", "/log", html`${owner === null ? "" : html`<p>只看主人 <a href="/owners/${owner}">${owner}</a> 相关的记录 · <a href="/log">看全部</a></p>`}
${logTable(zone, log)}
${log.next === null ? "" : html`<p><a href="/log?before=${log.next}${owner === null ? "" : `&owner=${owner}`}">更早的记录</a></p>`}`);
}
