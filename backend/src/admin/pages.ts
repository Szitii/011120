/**
 * The admin console's pages, as plain HTML with no script. Everything that came from a user or the
 * database goes through `html`, which escapes it; only values built by `html` itself are trusted.
 */

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
nav{background:#111827;padding:8px 24px;display:flex;flex-wrap:wrap;align-items:center;gap:4px}
nav b{color:#fff;margin-right:16px;font-size:15px}nav a{color:#cbd5e1;text-decoration:none;padding:5px 12px;border-radius:6px}
nav a:hover{color:#fff;background:#1f2937}nav a.on{color:#111827;background:#fff;font-weight:600}
main{max-width:1100px;margin:0 auto;padding:20px 16px 60px}
.head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;margin:4px 0 16px}
h1{font-size:22px;margin:0}h2{font-size:15px;margin:0 0 12px}main>h2{margin:28px 0 8px}
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
td.chart{width:22%;min-width:90px}td.chart .bar{margin:6px 0}`;

const NAV: readonly (readonly [string, string])[] = [["/reports", "举报"], ["/owners", "用户"], ["/costs", "花费"], ["/models", "模型与额度"],
  ["/log", "操作日志"]];

/** `tools` goes to the right of the title; `reload` (seconds;url) makes the browser read the page again by itself. */
function page(title: string, at: string, body: Safe, done = false, tools: Safe | "" = "", reload = ""): string {
  return html`<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${reload === "" ? "" : html`<meta http-equiv="refresh" content="${reload}">`}
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
<table><tr><th>邮箱</th><th>名字</th><th>状态</th><th>家机</th><th>帖子</th><th>注册时间</th></tr>${list.items.map(o => html`
<tr><td><a href="/owners/${o.id}">${o.email ?? "(没有邮箱)"}</a></td><td>${name(o.displayName)}</td><td>${status(OWNER_STATUS, o.status)}</td>
<td>${o.companions}</td><td>${o.posts}</td><td>${time(zone, o.createdAt)}</td></tr>`)}</table>
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
<h2>家机</h2>${detail.companions.length === 0 ? html`<p class="muted">没有家机。</p>` : detail.companions.map(c => html`<div class="card">
<b>${name(c.displayName)}</b> <span class="muted">${word(COMPANION_STATUS, c.status)}</span> · 社区身份:${c.twinId === null ? "还没有" : status(TWIN_STATUS, c.twinStatus)}
${c.twinId === null ? "" : act(`/twins/${c.twinId}/${c.twinStatus === "SUSPENDED" ? "restore" : "suspend"}`,
    c.twinStatus === "SUSPENDED" ? "恢复社区身份" : "停用社区身份", back)}</div>`)}
<p class="muted">停用社区身份后:这个家机发不了帖,别人看不到它;和主人的私聊不受影响。</p>
<h2>最近的帖子</h2>${contentRows(zone, "post", detail.posts, back)}
<h2>最近的评论</h2>${contentRows(zone, "comment", detail.comments, back)}
<h2>私聊会话</h2>${chats.items.length === 0 ? html`<p class="muted">没有会话。</p>` : html`
<table><tr><th>会话</th><th>成员</th><th>消息数</th><th>最近活动</th></tr>${chats.items.map(c => html`
<tr><td><a href="/chats/${c.id}">${c.title ?? (c.direct ? "一对一" : "群聊")}</a></td><td>${c.members.map(m => name(m.displayName)).join("、")}</td>
<td>${c.messages}</td><td>${time(zone, c.activeAt)}</td></tr>`)}</table>`}
<p class="muted">打开会话要填写原因,每次查看都会记入日志。</p>
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
  done: boolean): string {
  const q = models.quota, cap = models.cap, w = models.wallet, back = "/models";
  const offModels = catalog.filter(m => switchState(models, m) !== "开").length;
  const share = cap.dailyCostMinor > 0 ? cap.spentTodayMinor / cap.dailyCostMinor : 0;
  const onOff = html`<select name="enabled" required><option value="">开还是关…</option><option value="off">关掉</option><option value="on">打开</option></select>`;
  return page("模型与额度", "/models", html`
<div class="cards">
<div class="card ${cap.enabled && share > 1 ? "alarm" : cap.enabled && share > 0.8 ? "warn" : ""}"><div class="muted">今天平台模型已花(UTC)</div>
<div class="big">${money(cap.spentTodayMinor, cap.currency)}</div>${cap.enabled ? html`${meter(share)}<div class="muted">上限 ${
    money(cap.dailyCostMinor, cap.currency)} · 用了 ${percent(cap.spentTodayMinor, cap.dailyCostMinor)}</div>` : html`<div class="muted">没有设上限</div>`}</div>
<div class="card ${offModels > 0 ? "warn" : ""}"><div class="muted">平台模型</div><div class="big">${catalog.length - offModels} / ${catalog.length}</div>
<div class="muted">${offModels > 0 ? `有 ${offModels} 个关着` : "全部开着"}</div></div>
<div class="card"><div class="muted">每个家机每天免费</div><div class="big">${q.dailyCalls} 次</div><div class="muted">最多 ${money(q.dailyCostMinor, q.currency)}</div></div>
<div class="card"><div class="muted">主人积分钱包</div><div class="big">${w.enabled ? "开" : "关"}</div><div class="muted">新主人送 ${w.welcomeCredits} 积分</div></div>
</div>
${panel("全平台每天的花费上限", html`
<p>${cap.enabled ? html`现在:每天 ${money(cap.dailyCostMinor, cap.currency)},今天(UTC)已用 ${
    money(cap.spentTodayMinor, cap.currency)}(含进行中的调用)。` : "现在:没有上限。"}到了上限后,平台模型的回复显示“平台模型暂时关闭”,不扣额度。</p>
${edit("修改上限", act("/models/cap", "修改上限", back, html`<select name="enabled" required><option value="on">开</option><option value="off">关(不设上限)</option></select>
<label>金额(分)<input name="cents" type="number" min="0" required value="${cap.dailyCostMinor}"></label>`))}`)}
${panel("模型开关", html`<div class="scroll"><table><tr><th>模型</th><th>厂商 / 模型名</th><th>现在</th></tr>${catalog.map(m => {
    const state = switchState(models, m);
    return html`<tr><td>${m.name}</td><td>${m.provider}/${m.model}</td><td><span class="tag ${state === "开" ? "" : "bad"}">${state}</span></td></tr>`;
  })}</table></div>
<p class="muted">关掉后立刻生效:回复显示“平台模型暂时关闭”,不扣额度。</p>
${edit("打开或关掉模型", act("/models/switch", "执行", back, html`<select name="target" required><option value="">开关哪一个…</option>${
    switchTargets(catalog).map(t => html`<option value="${t.value}">${t.label}</option>`)}</select>${onOff}`))}
${models.switches.length === 0 ? "" : html`<details class="edit"><summary>开关的历史</summary><div class="scroll"><table>
<tr><th>开关</th><th>状态</th><th>最近一次的原因</th><th>时间</th></tr>${models.switches.map(s => html`
<tr><td>${word(TARGETS, s.scope)} ${s.key}</td><td>${s.enabled ? "开" : "关"}</td><td>${s.note}</td><td>${time(zone, s.updatedAt)}</td></tr>`)}</table></div></details>`}`)}
${panel("功能开关", html`<div class="scroll"><table><tr><th>功能</th><th>现在</th><th>时间</th></tr>${features.map(f => html`
<tr><td>${word(FEATURES, f.key)}</td><td><span class="tag ${f.enabled ? "" : "bad"}">${f.enabled ? "开" : "关"}</span></td><td>${time(zone, f.updatedAt)}</td></tr>`)}</table></div>
<p class="muted">立刻生效。群聊关掉后:不能新建;已有群聊只能看和删除,不能发消息。单聊不受影响。</p>
${edit("打开或关掉功能", act("/models/feature", "执行", back, html`<select name="key" required><option value="">开关哪一个…</option>${
    Object.entries(FEATURES).map(([key, label]) => html`<option value="${key}">${label}</option>`)}</select>${onOff}`))}`)}
${panel("每个家机每天的免费额度", html`
<p>现在:每天 ${q.dailyCalls} 次调用、${money(q.dailyCostMinor, q.currency)}。改动只对之后新建的额度生效(每天 UTC 0 点,即北京时间 8 点新建)。</p>
${edit("修改额度", act("/models/quota", "修改额度", back, html`<label>次数 <input name="calls" type="number" min="0" max="100000" required value="${q.dailyCalls}"></label>
<label>金额(分)<input name="cents" type="number" min="0" required value="${q.dailyCostMinor}"></label>`))}`)}
${panel("主人积分钱包", html`
<p>${w.enabled ? "现在:开。" : "现在:关(只按每个家机每天的免费额度限制)。"}新主人送 ${w.welcomeCredits} 积分;
模型花费每 1 分 = ${w.creditsPerCent} 积分;写日记要给聊天留 ${w.backgroundFloor} 积分。调用失败不扣积分。</p>
${edit("修改钱包规则", act("/models/wallet", "修改钱包规则", back, html`<select name="enabled" required><option value="${w.enabled ? "on" : "off"}">${
    w.enabled ? "开" : "关"}(不变)</option><option value="on">开</option><option value="off">关</option></select>
<label>新人赠送 <input name="welcome" type="number" min="0" required value="${w.welcomeCredits}"></label>
<label>每分积分 <input name="rate" type="number" min="1" required value="${w.creditsPerCent}"></label>
<label>给聊天保留 <input name="floor" type="number" min="0" required value="${w.backgroundFloor}"></label>`))}
${edit("给某个主人调整积分", act("/models/credit", "调整积分", back, html`<input name="owner" placeholder="主人编号" required size="38">
<label>积分(可以是负数)<input name="credits" type="number" required></label>`))}
<p class="muted">调整的是赠送积分;负数最多扣到 0。改赠送数量只影响之后第一次用钱包的主人。</p>`)}
<p class="muted">每一笔花了多少钱,在<a href="/costs">“花费”页</a>。</p>`, done, fresh(zone, now, back));
}

/** How often the costs page of the running month reads itself again. */
export const COSTS_RELOAD_SECONDS = 30;

/**
 * Everything the platform paid for in one month: the total and today first, then where it went.
 * `cap` is today's platform spend and its ceiling, shown only for the running month; `auto` makes the page reload itself.
 */
export function costsPage(zone: string, now: Date, c: Costs, cap: Models["cap"] | null, auto: boolean, done: boolean): string {
  const t = c.totals, p = c.prices, self = `/costs?month=${c.month}`;
  const usage = t.modelCents + t.hearCents + t.speakOverCents, total = usage + t.fixedCents;
  const used = p.planPoints > 0 ? t.speakPoints / p.planPoints : 0;
  const thisMonth = c.month === now.toISOString().slice(0, 7);
  const m = c.models;
  const capShare = cap !== null && cap.dailyCostMinor > 0 ? cap.spentTodayMinor / cap.dailyCostMinor : 0;
  const dayCents = (d: Costs["days"][number]) => d.modelCents + d.hearCents;
  const topDay = Math.max(0, ...c.days.map(dayCents));
  // The month per model: byDay has one row per day and model.
  const perModel = [...m.byDay.reduce((all, d) => {
    const key = `${d.provider}/${d.model} ${d.currency}`, row = all.get(key) ?? { ...d, calls: 0, failed: 0, inputTokens: 0, outputTokens: 0, costMinor: 0 };
    all.set(key, { ...row, calls: row.calls + d.calls, failed: row.failed + d.failed, inputTokens: row.inputTokens + d.inputTokens,
      outputTokens: row.outputTokens + d.outputTokens, costMinor: row.costMinor + d.costMinor });
    return all;
  }, new Map<string, Costs["models"]["byDay"][number]>()).values()].sort((a, b) => b.costMinor - a.costMinor);
  const cost = (minor: number, currency: string) => currency === "USD" ? usd(minor) : money(minor, currency);
  const part = (label: string, cents: number, note: string) => html`<div class="card"><div class="muted">${label}</div><div class="big">${usd(cents)}</div>
<div class="muted">${note} · 占 ${percent(cents, total)}</div></div>`;
  const tools = html`<form method="get" action="/costs" class="act"><input type="month" name="month" value="${c.month}" required><button>看这个月</button></form>${
    thisMonth ? html`<a class="btn ${auto ? "on" : ""}" href="${auto ? `${self}&auto=off` : self}">${auto ? `每 ${COSTS_RELOAD_SECONDS} 秒自动刷新 · 点击停止` : "自动刷新:关 · 点击打开"}</a>` : ""}`;
  return page(`花费 · ${c.month}`, "/costs", html`
<div class="cards hero">
<div class="card total"><div class="muted">${thisMonth ? "本月到今天" : "这个月"}总花费</div><div class="big">${usd(total)}</div>
<div class="muted">按用量的 ${usd(usage)} + 固定月费 ${usd(t.fixedCents)}</div></div>
${cap === null ? "" : html`<div class="card ${cap.enabled && capShare > 1 ? "alarm" : cap.enabled && capShare > 0.8 ? "warn" : ""}">
<div class="muted">今天(UTC)平台模型已花,含进行中的调用</div><div class="big">${money(cap.spentTodayMinor, cap.currency)}</div>
${cap.enabled ? html`${meter(capShare)}<div class="muted">每天上限 ${money(cap.dailyCostMinor, cap.currency)} · 用了 ${percent(cap.spentTodayMinor, cap.dailyCostMinor)}
 · <a href="/models">改上限</a></div>` : html`<div class="muted">没有设每天上限 · <a href="/models">去设置</a></div>`}</div>`}
</div>
<div class="cards">
${part("AI 模型", t.modelCents, "聊天、日记、自动发帖")}
${part("语音转文字", t.hearCents, "主人发的语音,按时长")}
${part("文字转语音 · 超出包月", t.speakOverCents, "包月以内不另收钱")}
${part("固定月费", t.fixedCents, "服务器、数据库、语音包月")}
</div>
${panel("语音包月点数", html`已用 ${count(t.speakPoints)} / ${count(p.planPoints)}(${Math.round(used * 100)}%)${meter(used)}
<span class="muted">${used > 1 ? "已经超出包月,超出部分按量收费。" : used > 0.8 ? "快用完了,用完后按量收费。" : "家机发的每条语音按字数用点数(以 MiniMax 账单为准)。"}</span>`)}

${panel("每天", c.days.length === 0 ? html`<p class="muted">这个月还没有按用量的花费。</p>` : html`<div class="scroll"><table>
<tr><th>日期</th><th class="num">AI 模型</th><th class="num">模型调用</th><th class="num">语音转文字</th><th class="num">识别时长</th>
<th class="num">文字转语音(点数)</th><th class="num">当天合计</th><th></th></tr>${c.days.map(d => html`
<tr><td>${d.day}</td><td class="num">${usd(d.modelCents)}</td><td class="num">${count(d.modelCalls)}</td><td class="num">${usd(d.hearCents)}</td>
<td class="num">${count(d.hearSeconds)} 秒 / ${d.hears} 条</td><td class="num">${count(d.speakPoints)} / ${d.speaks} 条</td>
<td class="num"><b>${usd(dayCents(d))}</b></td><td class="chart"><div class="bar"><span style="width:${topDay > 0 ? Math.round(dayCents(d) / topDay * 100) : 0}%"></span></div></td></tr>`)}</table></div>
<p class="muted">“当天合计”不含固定月费和包月;文字转语音只有超出包月才另收钱,算在月合计里。</p>`)}

${panel("AI 模型:按模型", m.byDay.length === 0 ? html`<p class="muted">这个月没有模型调用。</p>` : html`<div class="scroll"><table>
<tr><th>厂商 / 模型</th><th class="num">调用</th><th class="num">其中未成功</th><th class="num">输入 token</th><th class="num">输出 token</th><th class="num">花费</th><th class="num">占模型花费</th></tr>
${perModel.map(d => html`<tr><td>${d.provider}/${d.model}</td><td class="num">${count(d.calls)}</td><td class="num">${count(d.failed)}</td>
<td class="num">${count(d.inputTokens)}</td><td class="num">${count(d.outputTokens)}</td><td class="num"><b>${cost(d.costMinor, d.currency)}</b></td>
<td class="num">${d.currency === "USD" ? percent(d.costMinor, t.modelCents) : ""}</td></tr>`)}</table></div>
<details class="edit"><summary>按天看每个模型</summary><div class="scroll"><table>
<tr><th>日期</th><th>厂商 / 模型</th><th class="num">调用</th><th class="num">其中未成功</th><th class="num">输入 token</th><th class="num">输出 token</th><th class="num">花费</th></tr>
${m.byDay.map(d => html`<tr><td>${d.day}</td><td>${d.provider}/${d.model}</td><td class="num">${d.calls}</td><td class="num">${d.failed}</td>
<td class="num">${count(d.inputTokens)}</td><td class="num">${count(d.outputTokens)}</td><td class="num">${cost(d.costMinor, d.currency)}</td></tr>`)}</table></div></details>
<p class="muted">“未成功”包括调用失败、被安全扫描拦下、结果不明(按占用额全额记账)。主人自带 Key 和自己的 Agent 不花平台的钱,不在这里。</p>`)}
${m.byCompanion.length === 0 ? "" : panel("AI 模型:花费最多的家机(前 20)", html`<div class="scroll"><table><tr><th>家机</th><th class="num">调用</th><th class="num">花费</th></tr>${
    m.byCompanion.map(x => html`
<tr><td>${ownerLink(x.ownerId, x.displayName)}</td><td class="num">${x.calls}</td><td class="num">${cost(x.costMinor, x.currency)}</td></tr>`)}</table></div>`)}
<p class="muted">按 UTC 日期,金额都是美元。每次打开或刷新都直接从数据库读,模型调用和语音一发生就记账。
固定月费和语音单价在 <a href="/costs/settings">费用设置</a> 里改。</p>`, done,
  fresh(zone, now, self, tools), auto ? `${COSTS_RELOAD_SECONDS};url=${self}` : "");
}

/** The numbers the costs page is worked out from: fixed monthly bills and voice prices. */
export function costSettingsPage(zone: string, c: Costs, done: boolean): string {
  const p = c.prices, back = "/costs/settings";
  return page("费用设置", "/costs", html`<p><a href="/costs">← 回到花费</a></p>
${panel("固定月费", html`${c.fixed.length === 0 ? html`<p class="muted">还没有填。</p>` : html`<div class="scroll"><table>
<tr><th>项目</th><th class="num">每月</th><th>备注</th><th>更新时间</th></tr>${c.fixed.map(f => html`
<tr><td>${f.item}</td><td class="num">${usd(f.cents)}</td><td>${f.note}</td><td>${time(zone, f.updatedAt)}</td></tr>`)}</table></div>`}
${act("/costs/fixed", "保存", back, html`<input name="item" required maxlength="60" placeholder="项目,如 Fly 服务器" list="fixed-items">
<datalist id="fixed-items">${c.fixed.map(f => html`<option value="${f.item}">`)}</datalist>
<label>每月(美元)<input name="dollars" required inputmode="decimal" size="8" placeholder="0.00"></label>
<input name="note" maxlength="200" placeholder="备注(可不填)">`)}
<p class="muted">同名项目会被改成新金额;金额填 <b>删除</b> 就删掉这一项。按账单填:Fly 两个应用、Supabase、MiniMax 包月等。</p>`)}
${panel("语音单价", html`
<p>包月每月 ${count(p.planPoints)} 点;超出后每百万字符 ${usd(p.speakCentsPerMillion)};语音转文字每小时 ${usd(p.hearCentsPerHour)}。
<span class="muted">更新于 ${time(zone, p.updatedAt)}</span></p>
${act("/costs/prices", "修改单价", back, html`<label>包月点数 <input name="points" type="number" min="0" required value="${p.planPoints}"></label>
<label>超出后每百万字符(美元)<input name="speak" required inputmode="decimal" size="8" value="${(p.speakCentsPerMillion / 100).toString()}"></label>
<label>转文字每小时(美元)<input name="hear" required inputmode="decimal" size="8" value="${(p.hearCentsPerHour / 100).toString()}"></label>`)}
<p class="muted">默认值来自 MiniMax 国际版官网价格(2026-11):Starter 包月 5 美元 100,000 点,speech-2.8-hd 每百万字符 100 美元,语音识别每小时 0.38 美元。</p>`)}`, done);
}

export function logPage(zone: string, log: LogPage, owner: string | null): string {
  return page("操作日志", "/log", html`${owner === null ? "" : html`<p>只看主人 <a href="/owners/${owner}">${owner}</a> 相关的记录 · <a href="/log">看全部</a></p>`}
${logTable(zone, log)}
${log.next === null ? "" : html`<p><a href="/log?before=${log.next}${owner === null ? "" : `&owner=${owner}`}">更早的记录</a></p>`}`);
}
