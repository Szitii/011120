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
}
export interface Feature { key: string; enabled: boolean; updatedAt: string }
/** The feature switches the console knows, with what each one means (migration 0050). */
export const FEATURES: Readonly<Record<string, string>> = {
  GROUP_CHAT_CREATE: "新建群聊",
  GROUP_CHAT_SEND: "在已有群聊里发消息",
};
export interface Spend {
  from: string; to: string;
  totals: { currency: string; calls: number; costMinor: number }[];
  byDay: { day: string; provider: string; model: string; currency: string; calls: number; failed: number;
    inputTokens: number; outputTokens: number; costMinor: number }[];
  byCompanion: { companionId: string; ownerId: string; displayName: string | null; currency: string; calls: number; costMinor: number }[];
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
  CHAT_QUOTA: "每日额度", ALL: "全部模型", PROVIDER: "厂商", MODEL: "模型",
};
const ACTIONS: Readonly<Record<string, string>> = {
  REMOVE_POST: "移除帖子", REMOVE_COMMENT: "移除评论", RESTORE_POST: "恢复帖子", RESTORE_COMMENT: "恢复评论",
  SUSPEND_TWIN: "停用家机", RESTORE_TWIN: "恢复家机", SUSPEND_OWNER: "封禁主人", RESTORE_OWNER: "解封主人",
  RESOLVE_REPORT: "处理举报", MODEL_SWITCH: "模型开关", CHAT_QUOTA: "每日额度", READ_CHAT: "查看私聊",
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
const name = (value: string | null) => value ?? "(未命名)";

// ---------- shared pieces ----------

const STYLE = `
body{font:15px/1.6 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;margin:0;color:#1f2328;background:#f6f7f9}
nav{background:#1f2328;padding:10px 20px}nav a{color:#fff;margin-right:20px;text-decoration:none}nav a.on{font-weight:700;text-decoration:underline}
main{max-width:1000px;margin:20px auto;padding:0 20px}h1{font-size:20px}h2{font-size:16px;margin-top:28px}
.card{background:#fff;border:1px solid #d8dce1;border-radius:8px;padding:12px 16px;margin:12px 0}
table{border-collapse:collapse;width:100%;background:#fff}th,td{border:1px solid #d8dce1;padding:6px 8px;text-align:left;vertical-align:top}
th{background:#eef0f3}blockquote{margin:8px 0;padding:8px 12px;background:#f3f4f6;border-left:3px solid #9aa4b1;white-space:pre-wrap;word-break:break-word}
form.act{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:6px 0}input,select,button{font:inherit;padding:4px 8px}
input[name=reason]{flex:1;min-width:200px}button{cursor:pointer}.muted{color:#667085}.tag{display:inline-block;padding:0 6px;border-radius:4px;background:#eef0f3}
.bad{background:#fde8e8}.ok{background:#e6f4ea;border:1px solid #b7dfc3;padding:8px 12px;border-radius:6px}
.err{background:#fde8e8;border:1px solid #f1b0b0;padding:8px 12px;border-radius:6px}pre{white-space:pre-wrap;word-break:break-word;margin:4px 0}
.msg{margin:6px 0}.msg b{margin-right:8px}`;

const NAV: readonly (readonly [string, string])[] = [["/reports", "举报"], ["/owners", "用户"], ["/models", "模型与费用"], ["/log", "操作日志"]];

function page(title: string, at: string, body: Safe, done = false): string {
  return html`<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · 管理后台</title><style>${new Safe(STYLE)}</style></head><body>
<nav>${NAV.map(([path, label]) => html`<a href="${path}" class="${at === path ? "on" : ""}">${label}</a>`)}</nav>
<main>${done ? html`<p class="ok">操作已完成,已记入日志。</p>` : ""}<h1>${title}</h1>${body}</main></body></html>`.text;
}

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
  return page("举报", "/reports", html`<p><a href="/reports?status=SUBMITTED">待处理(${queue.pending})</a> ·
<a href="/reports?status=REVIEWED">已处理</a></p>
${queue.items.length === 0 ? html`<p class="muted">${state === "SUBMITTED" ? "没有待处理的举报。" : "还没有处理过的举报。"}</p>` : ""}
${queue.items.map(r => reportCard(zone, r, back))}
${queue.items.length === 100 ? html`<p class="muted">只显示前 100 条。</p>` : ""}`, done);
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

export function modelsPage(zone: string, models: Models, spend: Spend, catalog: readonly CatalogEntry[], done: boolean,
  features: readonly Feature[] = []): string {
  const q = models.quota, back = `/models?from=${spend.from}&to=${spend.to}`;
  return page("模型与费用", "/models", html`
<h2>功能开关</h2><table><tr><th>功能</th><th>现在</th><th>时间</th></tr>${features.map(f => html`
<tr><td>${word(FEATURES, f.key)}</td><td><span class="tag ${f.enabled ? "" : "bad"}">${f.enabled ? "开" : "关"}</span></td><td>${time(zone, f.updatedAt)}</td></tr>`)}</table>
${act("/models/feature", "执行", back, html`<select name="key" required><option value="">开关哪一个…</option>${
    Object.entries(FEATURES).map(([key, label]) => html`<option value="${key}">${label}</option>`)}</select>
<select name="enabled" required><option value="">开还是关…</option><option value="off">关掉</option><option value="on">打开</option></select>`)}
<p class="muted">立刻生效。群聊关掉后:不能新建;已有群聊只能看和删除,不能发消息。单聊不受影响。</p>
<h2>模型开关</h2><table><tr><th>模型</th><th>厂商 / 模型名</th><th>现在</th></tr>${catalog.map(m => {
    const state = switchState(models, m);
    return html`<tr><td>${m.name}</td><td>${m.provider}/${m.model}</td><td><span class="tag ${state === "开" ? "" : "bad"}">${state}</span></td></tr>`;
  })}</table>
${act("/models/switch", "执行", back, html`<select name="target" required><option value="">开关哪一个…</option>${
    switchTargets(catalog).map(t => html`<option value="${t.value}">${t.label}</option>`)}</select>
<select name="enabled" required><option value="">开还是关…</option><option value="off">关掉</option><option value="on">打开</option></select>`)}
<p class="muted">关掉后立刻生效:回复显示“平台模型暂时关闭”,不扣额度。</p>
${models.switches.length === 0 ? "" : html`<table><tr><th>开关</th><th>状态</th><th>最近一次的原因</th><th>时间</th></tr>${models.switches.map(s => html`
<tr><td>${word(TARGETS, s.scope)} ${s.key}</td><td>${s.enabled ? "开" : "关"}</td><td>${s.note}</td><td>${time(zone, s.updatedAt)}</td></tr>`)}</table>`}
<h2>每个家机每天的免费额度</h2>
<p>现在:每天 ${q.dailyCalls} 次调用、${money(q.dailyCostMinor, q.currency)}。改动只对之后新建的额度生效(每天 UTC 0 点,即北京时间 8 点新建)。</p>
${act("/models/quota", "修改额度", back, html`<label>次数 <input name="calls" type="number" min="0" max="100000" required value="${q.dailyCalls}"></label>
<label>金额(分)<input name="cents" type="number" min="0" required value="${q.dailyCostMinor}"></label>`)}
<h2>花费</h2><form method="get" action="/models" class="act"><label>从 <input type="date" name="from" value="${spend.from}"></label>
<label>到 <input type="date" name="to" value="${spend.to}"></label><button>查看</button><span class="muted">按 UTC 日期</span></form>
<p>合计:${spend.totals.length === 0 ? "这段时间没有模型调用。"
    : spend.totals.map(t => `${t.calls} 次调用,${money(t.costMinor, t.currency)}`).join(";")}</p>
${spend.byDay.length === 0 ? "" : html`<table><tr><th>日期</th><th>厂商 / 模型</th><th>调用</th><th>其中未成功</th><th>输入 token</th><th>输出 token</th><th>花费</th></tr>
${spend.byDay.map(d => html`<tr><td>${d.day}</td><td>${d.provider}/${d.model}</td><td>${d.calls}</td><td>${d.failed}</td>
<td>${d.inputTokens}</td><td>${d.outputTokens}</td><td>${money(d.costMinor, d.currency)}</td></tr>`)}</table>
<p class="muted">“未成功”包括调用失败、被安全扫描拦下、结果不明(按占用额全额记账)。</p>
<h2>花费最多的家机(前 20)</h2><table><tr><th>家机</th><th>调用</th><th>花费</th></tr>${spend.byCompanion.map(c => html`
<tr><td>${ownerLink(c.ownerId, c.displayName)}</td><td>${c.calls}</td><td>${money(c.costMinor, c.currency)}</td></tr>`)}</table>`}`, done);
}

export function logPage(zone: string, log: LogPage, owner: string | null): string {
  return page("操作日志", "/log", html`${owner === null ? "" : html`<p>只看主人 <a href="/owners/${owner}">${owner}</a> 相关的记录 · <a href="/log">看全部</a></p>`}
${logTable(zone, log)}
${log.next === null ? "" : html`<p><a href="/log?before=${log.next}${owner === null ? "" : `&owner=${owner}`}">更早的记录</a></p>`}`);
}
