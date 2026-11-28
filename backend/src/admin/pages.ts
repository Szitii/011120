/**
 * The admin console's pages, as plain HTML with no script. Everything that came from a user or the
 * database goes through `html`, which escapes it; only values built by `html` itself are trusted.
 */

import type { ChatClaim } from "../chat/port.ts";
import { agentMessages, decisionPrompt, diaryPrompt, memoryPrompt, postPrompt, replyPrompt } from "../chat/prompt.ts";
import { PROMPT_BLOCKS, PROMPT_TEXT_MAX, promptTextRefusal, usablePromptTexts, type PromptBlock, type PromptTexts } from "../chat/prompt-texts.ts";
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
  COMPANION_WEB: "家机联网搜索（只有平台的 DeepSeek Flash 能搜；模型自己决定搜不搜，搜了的回复会贵一些，先开一小段时间看花费）",
  COMPANION_REACH: "家机主动找主人：主人打开了“主动找你”的家机会自己发消息，主人让它到点提醒的会按时提醒（关掉后两样都停，已设的提醒留着）",
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
  NONE: "不处理", REMOVED: "移除内容", TWIN_SUSPENDED: "停用家机的社区账号", OWNER_SUSPENDED: "封禁主人",
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
  PROMPT: "提示词", FEEDBACK: "反馈", TEMPLATE: "人设模板", SKILL: "技能",
};
const ACTIONS: Readonly<Record<string, string>> = {
  REMOVE_POST: "移除帖子", REMOVE_COMMENT: "移除评论", RESTORE_POST: "恢复帖子", RESTORE_COMMENT: "恢复评论",
  SUSPEND_TWIN: "停用家机", RESTORE_TWIN: "恢复家机", SUSPEND_OWNER: "封禁主人", RESTORE_OWNER: "解封主人",
  RESOLVE_REPORT: "处理举报", MODEL_SWITCH: "模型开关", CHAT_QUOTA: "每日额度", READ_CHAT: "查看私聊",
  FIXED_COST: "固定月费", VOICE_PRICES: "语音单价", PROMPT_SET: "修改提示词",
  FEEDBACK_REPLY: "回复反馈", FEEDBACK_CLOSE: "关闭反馈", FEEDBACK_REOPEN: "重新打开反馈",
  TEMPLATE_SET: "保存人设模板", TEMPLATE_DELETE: "删除人设模板", SKILL_SET: "保存技能", SKILL_DELETE: "删除技能",
  SHARED_SKILL_APPROVE: "通过投稿技能", SHARED_SKILL_REJECT: "退回投稿技能", SHARED_SKILL_REMOVE: "下架投稿技能", SHARED_SKILL_KEEP: "保留被举报的技能",
};
const MESSAGE_STATUS: Readonly<Record<string, string>> = {
  PENDING: "(正在回复)", FAILED: "(回复失败)", BLOCKED: "(被安全扫描拦下)", PASSED: "(选择不说话)",
};
const ACTION_WORD: Readonly<Record<string, string>> = { WAVE: "(小家动作:挥手)", PAT_HEAD: "(小家动作:摸头)", HUG: "(小家动作:抱抱)", CUDDLE: "(小家动作:贴贴)" };
const word = (table: Readonly<Record<string, string>>, key: string | null) => key === null ? "" : table[key] ?? key;

/** A moment as the operator reads it, in the IANA time zone `zone`. */
const time = (zone: string, value: string | null) => value === null ? "" :
  new Date(value).toLocaleString("zh-CN", { timeZone: zone, hour12: false });
/** Money in a currency's minor unit: "$1.23" for dollars, else "1.23 CNY". */
const money = (minor: number, currency: string) => currency === "USD" ? `$${(minor / 100).toFixed(2)}` : `${(minor / 100).toFixed(2)} ${currency}`;
/** Dollars from cents that may be a fraction: a little that is not nothing shows as "< $0.01". */
const usd = (cents: number) => cents > 0 && cents < 1 ? "< $0.01" : `$${(Math.round(cents) / 100).toFixed(2)}`;
const count = (n: number) => Math.round(n).toLocaleString("en-US");
const name = (value: string | null) => value ?? "(未命名)";

// ---------- shared pieces ----------

const STYLE = `
:root{color-scheme:light dark;--bg:#f5f5f7;--card:#fff;--fill:#f2f2f7;--fill2:#e8e8ed;--text:#1d1d1f;--sub:#6e6e73;--faint:#86868b;
--line:rgba(0,0,0,.08);--blue:#0071e3;--blue-soft:rgba(0,113,227,.1);--red:#e30000;--red-soft:rgba(255,59,48,.12);--green:#1a9e47;
--green-soft:rgba(52,199,89,.14);--orange:#c25e00;--orange-soft:rgba(255,149,0,.14);--ink:#1d1d1f;--shadow:0 1px 2px rgba(0,0,0,.04),0 4px 16px rgba(0,0,0,.04);
--side:rgba(246,246,248,.82)}
@media (prefers-color-scheme:dark){:root{--bg:#000;--card:#1c1c1e;--fill:#2c2c2e;--fill2:#3a3a3c;--text:#f5f5f7;--sub:#a1a1a6;--faint:#8e8e93;
--line:rgba(255,255,255,.1);--blue:#2997ff;--blue-soft:rgba(41,151,255,.16);--red:#ff6961;--red-soft:rgba(255,69,58,.18);--green:#30d158;
--green-soft:rgba(48,209,88,.16);--orange:#ffb340;--orange-soft:rgba(255,159,10,.16);--ink:#f5f5f7;--shadow:none;--side:rgba(28,28,30,.82)}}
*{box-sizing:border-box}
body{font:15px/1.55 -apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue","PingFang SC","Microsoft YaHei",sans-serif;margin:0;color:var(--text);
background:var(--bg);-webkit-font-smoothing:antialiased;letter-spacing:-.01em}
a{color:var(--blue);text-decoration:none}a:hover{text-decoration:underline}
:focus-visible{outline:3px solid var(--blue);outline-offset:2px;border-radius:6px}
.shell{display:flex;min-height:100vh}
aside{width:232px;flex:none;position:sticky;top:0;height:100vh;overflow-y:auto;padding:20px 12px;background:var(--side);
-webkit-backdrop-filter:saturate(180%) blur(20px);backdrop-filter:saturate(180%) blur(20px);border-right:1px solid var(--line)}
aside .brand{display:block;font-size:17px;font-weight:600;color:var(--text);padding:4px 10px 14px;text-decoration:none}
nav p{margin:14px 10px 4px;font-size:12px;font-weight:600;color:var(--faint)}
nav a{display:flex;align-items:center;gap:10px;color:var(--text);font-size:14px;padding:6px 10px;border-radius:8px;margin:1px 0}
nav a:hover{background:var(--fill2);text-decoration:none}
nav a.on{background:var(--blue);color:#fff;font-weight:500}
nav a svg{width:22px;height:22px;flex:none;padding:4px;border-radius:6px;color:#fff;fill:none;stroke:currentColor;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round}
nav a.on svg{background:rgba(255,255,255,.22)!important}
nav .badge{margin-left:auto;min-width:20px;padding:0 6px;border-radius:980px;background:#ff3b30;color:#fff;font-size:12px;font-weight:600;line-height:20px;text-align:center}
nav a.on .badge{background:#fff;color:var(--blue)}form.read{margin:0;flex-wrap:nowrap}form.read input{min-width:120px;flex:1}
main{flex:1;min-width:0;max-width:1240px;margin:0 auto;padding:26px 32px 64px}
@media (max-width:860px){.shell{display:block}
aside{position:sticky;z-index:5;width:auto;height:auto;padding:8px 12px;border-right:0;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:8px}
aside .brand{padding:4px 6px;font-size:15px;white-space:nowrap}nav{display:flex;gap:2px;overflow-x:auto;scrollbar-width:none}nav p{display:none}
nav a{white-space:nowrap;padding:6px 10px}nav a svg{display:none}main{padding:20px 16px 60px}}
.head{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:12px 16px;margin:0 0 16px}
h1{font-size:24px;line-height:1.2;font-weight:700;letter-spacing:-.02em;margin:0}
h2{font-size:15px;font-weight:600;letter-spacing:-.01em;margin:0 0 10px}main>h2{font-size:17px;margin:26px 0 10px}
h2 .links{font-weight:400;font-size:13px;margin-left:8px}
p{margin:10px 0}
.tools{display:flex;flex-wrap:wrap;align-items:center;gap:8px;color:var(--sub);font-size:13px}.tools form,.tools form.act{margin:0;gap:8px}.tools input[type=month]{padding:5px 10px}
.btn,button{display:inline-flex;align-items:center;justify-content:center;gap:4px;font:inherit;font-size:14px;font-weight:500;line-height:20px;padding:6px 16px;
border:0;border-radius:980px;background:var(--fill2);color:var(--text);cursor:pointer;text-decoration:none;white-space:nowrap;transition:filter .15s,background .15s}
.btn:hover,button:hover{filter:brightness(.95);text-decoration:none}.btn:active,button:active{filter:brightness(.88)}
form.act button,.primary{background:var(--blue);color:#fff}form.act button.danger,button.danger{background:var(--red);color:#fff}
.btn.on{background:var(--blue-soft);color:var(--blue)}.tools form.act button{background:var(--fill2);color:var(--text)}
section.panel{background:var(--card);border-radius:12px;padding:16px 18px;margin:14px 0;box-shadow:var(--shadow)}
.card{background:var(--card);border-radius:12px;padding:14px 16px;margin:12px 0;box-shadow:var(--shadow)}
.panel .card{background:var(--fill);box-shadow:none}
.scroll{overflow-x:auto;margin:0 -4px;padding:0 4px}table{border-collapse:collapse;width:100%}
th,td{border-bottom:1px solid var(--line);padding:6px 10px;text-align:left;vertical-align:top;font-size:14px}
th{color:var(--sub);font-weight:500;font-size:12px;white-space:nowrap;border-bottom-color:var(--line)}
tr:last-child td{border-bottom:0}tr:hover td{background:var(--fill)}
main>table,main>.scroll>table{background:var(--card);border-radius:12px;overflow:hidden;box-shadow:var(--shadow)}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}td:first-child{white-space:nowrap}
blockquote{margin:10px 0;padding:12px 16px;background:var(--fill);border-radius:12px;white-space:pre-wrap;word-break:break-word}
form.act{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin:14px 0 4px}
input,select,textarea{font:inherit;font-size:14px;color:var(--text);padding:7px 12px;border:1px solid transparent;border-radius:10px;background:var(--fill);
transition:box-shadow .15s,border-color .15s}
input:focus,select:focus,textarea:focus{outline:0;border-color:var(--blue);box-shadow:0 0 0 4px var(--blue-soft);background:var(--card)}
input[type=checkbox]{width:18px;height:18px;accent-color:var(--blue);vertical-align:-3px;margin:0 4px 0 0}
form.act label{display:inline-flex;align-items:center;gap:6px;color:var(--sub);font-size:14px}
input[name=reason]{flex:1;min-width:220px}input[name=q]{flex:1;min-width:240px;padding:9px 14px}
form.sw{display:inline-flex;align-items:center;gap:12px;margin:0;vertical-align:middle}
button.switch,button.switch:hover{position:relative;width:51px;height:31px;padding:0;border:0;border-radius:16px;background:var(--fill2);flex:none;
transition:background .25s;filter:none}
button.switch::after{content:"";position:absolute;top:2px;left:2px;width:27px;height:27px;border-radius:50%;background:#fff;
box-shadow:0 3px 8px rgba(0,0,0,.15),0 1px 1px rgba(0,0,0,.16);transition:left .25s}
button.switch.on,button.switch.on:hover{background:#34c759}button.switch.on::after{left:22px}
textarea{line-height:1.6;width:100%;padding:12px 14px;resize:vertical}
pre.fixed{color:var(--sub)}
.own{background:var(--orange-soft);border-radius:14px;padding:14px 16px;margin:12px 0}.own.off{background:var(--red-soft)}
.own>b{margin-right:8px}
details.edit{margin-top:14px;padding-top:12px;border-top:1px solid var(--line)}details.fixed{margin:8px 0}details.fixed>summary{color:var(--sub);font-weight:400;font-size:13px}
dl.detail{margin:0;display:grid;grid-template-columns:max-content 1fr;gap:4px 12px}dl.detail dt{color:var(--sub);font-size:13px}dl.detail dd{margin:0}
details>summary{cursor:pointer;color:var(--blue);width:max-content;list-style:none;font-weight:500}details>summary::-webkit-details-marker{display:none}
details>summary::before{content:"";display:inline-block;width:6px;height:6px;margin:0 9px 2px 2px;border:solid currentColor;border-width:0 2px 2px 0;
transform:rotate(-45deg);transition:transform .2s}details[open]>summary::before{transform:rotate(45deg)}
.muted{color:var(--sub)}p.muted,div.muted{font-size:13px}
.tag{display:inline-block;padding:1px 9px;border-radius:980px;background:var(--fill2);color:var(--sub);font-size:12px;font-weight:500;line-height:20px}
.tag.bad{background:var(--red-soft);color:var(--red)}.tag.good{background:var(--green-soft);color:var(--green)}.tag{white-space:nowrap}.bad{color:var(--red)}
.ok{background:var(--green-soft);color:var(--green);padding:10px 16px;border-radius:12px;font-weight:500}
.toast{position:fixed;z-index:20;top:16px;left:50%;transform:translateX(-50%);margin:0;background:var(--card);color:var(--text);
box-shadow:0 8px 32px rgba(0,0,0,.18);border-radius:980px;padding:10px 20px;animation:toast 4.5s ease forwards;pointer-events:none}
.toast::before{content:"✓";display:inline-grid;place-items:center;width:20px;height:20px;margin-right:8px;border-radius:50%;background:#34c759;color:#fff;font-size:12px}
@keyframes toast{0%{opacity:0;top:4px}8%,80%{opacity:1;top:16px}100%{opacity:0;visibility:hidden}}
.err{background:var(--red-soft);color:var(--red);padding:12px 16px;border-radius:12px}pre{white-space:pre-wrap;word-break:break-word;margin:6px 0;font:inherit}
.thread{display:flex;flex-direction:column;gap:12px}
.msg{display:flex;flex-direction:column;align-items:flex-start;max-width:78%}.msg b{font-size:12px;font-weight:500;color:var(--sub);margin:0 12px 2px}
.msg pre{margin:0;padding:9px 14px;border-radius:18px;background:var(--fill2);line-height:1.45}
.msg .muted{font-size:11px;margin:2px 12px 0}.msg.me{align-self:flex-end;align-items:flex-end}.msg.me pre{background:var(--blue);color:#fff}
.msg.me pre .muted{color:rgba(255,255,255,.8)}
.kv2{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(360px,100%),1fr));gap:0 48px;align-items:start}table.kv{width:100%;table-layout:fixed}table.kv td:first-child{width:38%}table.kv td.num{width:22%}.kv2 table.kv:first-child tr:last-child td{border-bottom:1px solid var(--line)}table.kv td.num{padding-left:32px}table.kv td.muted{font-size:13px;padding-left:20px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:14px;margin:0 0 20px}.cards .card{margin:0}
.spend{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(300px,100%),1fr));gap:20px 40px;margin:0 0 20px}.spend .big{font-size:44px;letter-spacing:-.03em}
.spend .today{border-left:1px solid rgba(255,255,255,.15);padding-left:32px}.mid{font-size:26px;font-weight:600;margin:4px 0;font-variant-numeric:tabular-nums}
.spend .today.near .mid{color:#ffb340}.spend .today.over .mid{color:#ff6961}.mid .muted{font-size:15px;font-weight:400}.total summary{color:#64d2ff}.total details.edit{border-color:rgba(255,255,255,.15)}
.total input{background:rgba(255,255,255,.12);color:#fff}.total form.act label{color:rgba(255,255,255,.75)}
.card>.muted:first-child{font-size:13px;font-weight:500}
.big{font-size:30px;font-weight:600;line-height:1.2;letter-spacing:-.02em;margin:4px 0;font-variant-numeric:tabular-nums}.hero .big{font-size:44px;letter-spacing:-.03em}
.total{background:linear-gradient(160deg,#1d1d1f,#3a3a3c);color:#fff}.total .muted{color:rgba(255,255,255,.65)}
.warn{box-shadow:inset 0 0 0 2px var(--orange-soft),var(--shadow)}.warn .big{color:var(--orange)}
.alarm{box-shadow:inset 0 0 0 2px var(--red-soft),var(--shadow)}.alarm .big{color:var(--red)}
.bar{height:8px;background:var(--fill2);border-radius:4px;overflow:hidden;margin:10px 0}
.bar span{display:block;height:100%;background:var(--blue);border-radius:4px}.bar span.over{background:var(--red)}.bar span.near{background:#ff9500}
.seg{display:inline-flex;padding:2px;background:var(--fill2);border-radius:9px;gap:0}
.seg .btn{border-radius:7px;background:transparent;padding:4px 14px;font-size:13px}.seg .btn.on{background:var(--card);color:var(--text);
box-shadow:0 1px 3px rgba(0,0,0,.12)}.seg .btn:hover{filter:none;background:var(--fill)}.seg .btn.on:hover{background:var(--card)}
svg.chart{width:100%;height:auto;display:block;color:var(--ink)}svg.chart text{font-size:12px;fill:var(--faint)}svg.chart text.end{fill:var(--text);font-size:13px}
svg.chart .grid{stroke:var(--line);stroke-dasharray:4 3}svg.chart .frame{fill:none;stroke:var(--faint)}svg.chart rect.hit{fill:transparent}svg.chart rect.hit:hover{fill:var(--line)}
.legend{display:flex;flex-wrap:wrap;gap:16px;font-size:13px;color:var(--sub);margin:0 0 8px}
.legend i,.vhead i{display:inline-block;width:10px;height:10px;border-radius:50%;vertical-align:0;margin-right:6px}.legend i{border-radius:1px}
.links a{margin-right:16px}.vendors{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px;margin:6px 0 14px}.vendors .card{margin:0}.vendor .big{font-size:22px;margin:2px 0 4px}
.vhead,.mhead{display:flex;justify-content:space-between;gap:8px}table.lines{table-layout:fixed}table.lines td{padding:4px 0;border-bottom:1px solid var(--line)}
table.lines td:first-child{white-space:normal;word-break:break-word}table.lines td.num{width:88px}table.lines .muted{display:block;font-size:12px}
table.lines tr:hover td{background:none}
.sub{margin-top:14px;padding-top:12px;border-top:1px solid var(--line)}svg.spark{width:100%;height:36px;display:block;margin:4px 0}
.facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:4px 24px;margin:4px 0 8px}.facts div{font-size:13px;color:var(--sub)}
.facts div b{display:block;font-size:15px;font-weight:500;color:var(--text)}
.two{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(380px,100%),1fr));gap:16px;align-items:start;margin-top:20px}.two section.panel{margin:0 0 16px;min-width:0}
.item+.item{margin-top:14px;padding-top:14px;border-top:1px solid var(--line)}td details.edit{margin-top:6px;padding-top:0;border:0}td details.edit summary{font-size:13px}
form.reply{margin:14px 0 4px}form.reply textarea{min-height:64px}form.reply .row{display:flex;justify-content:flex-end;align-items:center;gap:14px;margin-top:8px}
form.reply label{color:var(--sub);font-size:14px}form.reply button{background:var(--blue);color:#fff}form.quick{margin:6px 0 0;justify-content:flex-end}form.act button.plain{background:transparent;color:var(--sub);padding:4px 0;font-weight:400;font-size:13px}
.report-head{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-bottom:8px}
.report-head form.quick{margin:0 0 0 auto}details.fb{padding:0}details.fb>summary{display:flex;gap:10px;align-items:center;width:auto;padding:12px 16px;color:var(--text);font-weight:400}
details.fb>summary .peek{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--sub)}details.fb>summary .muted{font-size:13px;white-space:nowrap}
details.fb>:not(summary){margin-left:16px;margin-right:16px}details.fb[open]{padding-bottom:14px}details.fb[open]>summary{border-bottom:1px solid var(--line);margin-bottom:12px}
.report-head b{font-size:17px}
.empty{text-align:center;padding:48px 16px;color:var(--sub);background:var(--card);border-radius:18px;box-shadow:var(--shadow)}
@media (max-width:860px){h1{font-size:26px}.cards{grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.cards.hero{grid-template-columns:1fr}
.card{padding:14px 16px}.big{font-size:24px}.hero .big{font-size:36px}section.panel{padding:18px 16px}.msg{max-width:90%}
.spend .big{font-size:36px}.spend .today{border-left:0;padding-left:0;border-top:1px solid rgba(255,255,255,.15);padding-top:16px}}
@media (prefers-reduced-motion:reduce){*{transition:none!important}.toast{animation-duration:6s}}`;

/** The sidebar: grouped like a phone's settings, each with a small line icon. */
const NAV: readonly (readonly [string, readonly (readonly [string, string, string, string])[]])[] = [
  ["处理", [["/reports", "举报", "#ff3b30", "M5 21V4h11l-2 4 2 4H5"], ["/feedback", "反馈", "#34c759", "M4 5h16v11H9l-5 4z"], ["/owners", "用户与聊天", "#0a84ff", "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21c0-4 4-6 8-6s8 2 8 6"]]],
  ["数据", [["/stats", "运营数据", "#30b0c7", "M5 20V11M12 20V4M19 20v-6"], ["/costs", "花费", "#34c759", "M3 6h18v13H3zM3 10h18M7 15h4"],
    ["/system", "系统", "#8e8e93", "M4 4h16v7H4zM4 13h16v7H4zM8 7.5h.01M8 16.5h.01"]]],
  ["设置", [["/models", "模型与额度", "#5e5ce6", "M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4"],
    ["/prompts", "提示词", "#ff9500", "M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6"],
    ["/kit", "模板与技能", "#af52de", "M4 5h7v7H4zM13 5h7v7h-7zM4 14h7v5H4zM13 14h7v5h-7z"]]],
  ["记录", [["/log", "操作日志", "#636366", "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2"]]],
];

/** Where the sidebar shows how many reports and feedback threads wait; the server fills them in (withPending). */
const PENDING: Readonly<Record<string, string>> = { "/reports": "<!--pending:reports-->", "/feedback": "<!--pending:feedback-->" };
const badge = (n: number) => n > 0 ? `<span class="badge" aria-label="${n} 条待处理">${Math.min(n, 99)}</span>` : "";
/** A page with the number of reports waiting next to 举报, and of feedback waiting for an answer next to 反馈 (nothing when none). */
export const withPending = (page: string, reports: number, feedback: number) =>
  page.replace(PENDING["/reports"]!, badge(reports)).replace(PENDING["/feedback"]!, badge(feedback));

/** `tools` goes to the right of the title. */
function page(title: string, at: string, body: Safe, done = false, tools: Safe | "" = ""): string {
  return html`<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · 管理后台</title><style>${new Safe(STYLE)}</style></head><body><div class="shell">
<aside><a class="brand" href="/reports">管理后台</a><nav>${NAV.map(([group, items]) => html`<p>${group}</p>${items.map(([path, label, color, icon]) =>
    html`<a href="${path}" class="${at === path ? "on" : ""}"${at === path ? html` aria-current="page"` : ""}><svg viewBox="0 0 24 24" style="background:${color}" aria-hidden="true"><path d="${icon}"/></svg>${label}${
    new Safe(PENDING[path] ?? "")}</a>`)}`)}</nav></aside>
<main>${done ? html`<p class="ok toast" role="status">操作已完成,已记入日志。</p>` : ""}<div class="head"><h1>${title}</h1>${tools}</div>${body}</main></div></body></html>`.text;
}

/** A titled white block of the page. */
const panel = (title: string | Safe, body: Safe) => html`<section class="panel"><h2>${title}</h2>${body}</section>`;
/** A change form folded away under a link, so the page reads as the current state first. */
const edit = (label: string, form: Safe) => html`<details class="edit"><summary>${label}</summary>${form}</details>`;
/** What goes to the right of a page's title. */
const bar = (tools: Safe) => html`<div class="tools">${tools}</div>`;
/** A bar filled to `share` (0..1+): blue, amber from 80 %, red past 100 %. */
const meter = (share: number) =>
  html`<div class="bar"><span class="${share > 1 ? "over" : share > 0.8 ? "near" : ""}" style="width:${Math.min(100, Math.round(share * 100))}%"></span></div>`;
const percent = (part: number, whole: number) => whole > 0 ? `${Math.round(part / whole * 100)}%` : "—";

export function errorPage(title: string, message: string, back: string): string {
  return page(title, "", html`<p class="err">${message}</p><p><a href="${back}">返回</a></p>`);
}

const hidden = (name: string, value: string | number) => html`<input type="hidden" name="${name}" value="${String(value)}">`;
/** A form that changes something: the operator must give a reason; a dangerous change also needs the box ticked. */
function act(path: string, label: string, back: string, fields: Safe | "" = "", danger = false): Safe {
  return html`<form class="act" method="post" action="${path}"><input type="hidden" name="back" value="${back}">${fields}
<input name="reason" required maxlength="500" placeholder="原因(必填,会记入日志)">
${danger ? html`<label><input type="checkbox" name="confirm" value="yes" required> 确认</label>` : hidden("confirm", "yes")}<button class="${danger ? "danger" : ""}">${label}</button></form>`;
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
const ownerLink = (id: string, label: string | null) => html`<a href="/owners/${id}">${name(label)}</a>`;
const status = (table: Readonly<Record<string, string>>, value: string | null) =>
  html`<span class="tag ${value === "ACTIVE" ? "" : "bad"}">${word(table, value)}</span>`;

/** What a log row's detail keys mean; other keys are shown as they are. */
const DETAIL_WORDS: Readonly<Record<string, string>> = { before: "改前", body: "内容", enabled: "开关", reason: "原因" };
/** A value as a person reads it: text keeps its lines; a group of values goes one per line. */
const detailValue = (value: unknown): string => typeof value === "string" ? value
  : value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.entries(value).map(([k, v]) => `${DETAIL_WORDS[k] ?? k}: ${typeof v === "object" && v !== null ? JSON.stringify(v) : String(v)}`).join("\n")
    : JSON.stringify(value);
/** A log row's detail, one labelled line (or block of text) per key. */
const detailView = (detail: Record<string, unknown>) =>
  html`<dl class="detail">${Object.entries(detail).map(([k, v]) => html`<dt>${DETAIL_WORDS[k] ?? k}</dt><dd><pre>${detailValue(v)}</pre></dd>`)}</dl>`;

function logTable(zone: string, log: LogPage): Safe {
  if (log.items.length === 0) return html`<p class="muted">没有记录。</p>`;
  return html`<table><tr><th>时间</th><th>操作人</th><th>操作</th><th>对象</th><th>原因</th><th>详情</th></tr>${log.items.map(l => html`
<tr><td>${time(zone, l.createdAt)}</td><td>${l.operator}</td><td>${word(ACTIONS, l.action)}</td>
<td>${l.ownerId === null ? html`${word(TARGETS, l.targetType)} ${l.targetId}`
    : html`<a href="/owners/${l.ownerId}">${word(TARGETS, l.targetType)}</a> <span class="muted">${l.targetId}</span>`}</td>
<td>${l.reason}</td><td>${Object.keys(l.detail).length === 0 ? "" : html`<details><summary>查看</summary>${detailView(l.detail)}</details>`}</td></tr>`)}</table>`;
}

// ---------- pages ----------

function reportCard(zone: string, r: Report, back: string): Safe {
  const options = ["NONE", ...(r.targetType === "ACTOR" ? [] : ["REMOVED"]), ...(r.target.kind === "AI" ? ["TWIN_SUSPENDED"] : []), "OWNER_SUSPENDED"];
  const who = (a: Actor) => html`${ownerLink(a.ownerId, a.displayName)} <span class="muted">${a.kind === "AI" ? "家机" : "真人"}</span>`;
  return html`<div class="card">
<div class="report-head"><b>${word(REASONS, r.reason)}</b><span class="tag">${word(TARGETS, r.targetType)}</span><span class="muted">${time(zone, r.createdAt)}</span>
${r.others > 0 ? html`<span class="tag bad">同一对象还有 ${r.others} 条待处理举报,会一起结案</span>` : ""}</div>
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
${queue.items.length === 0 ? html`<p class="empty">${state === "SUBMITTED" ? "没有待处理的举报。" : "还没有处理过的举报。"}</p>` : ""}
${queue.items.map(r => reportCard(zone, r, back))}
${queue.items.length === 100 ? html`<p class="muted">只显示前 100 条。</p>` : ""}`, done, html`<div class="tools">
<span class="seg"><a class="btn ${state === "SUBMITTED" ? "on" : ""}" href="/reports?status=SUBMITTED">待处理(${queue.pending})</a>
<a class="btn ${state === "REVIEWED" ? "on" : ""}" href="/reports?status=REVIEWED">已处理</a></span></div>`);
}

// ---------- 反馈 ----------

/** companion_admin.feedback (migration 0068): threads with one status, waiting ones first. */
export interface FeedbackThread {
  id: string; status: "OPEN" | "CLOSED"; waiting: boolean; appVersion: string | null; platform: string | null; createdAt: string; updatedAt: string;
  owner: { id: string; email: string | null; displayName: string | null; status: string } | null;
  messages: { id: string; author: "OWNER" | "TEAM"; operator: string | null; body: string; createdAt: string }[];
}
export interface FeedbackQueue { waiting: number; items: FeedbackThread[] }
const PLATFORMS: Readonly<Record<string, string>> = { IOS: "iPhone", ANDROID: "安卓", WEB: "网页" };

/** A form that needs no typed reason: what it does is the reason, and the log keeps the text. */
const quick = (path: string, label: string, back: string, reason: string, fields: Safe | "" = "", primary = true) =>
  html`<form class="act quick" method="post" action="${path}">${hidden("back", back)}${hidden("reason", reason)}${hidden("confirm", "yes")}${fields}
<button class="${primary ? "" : "plain"}">${label}</button></form>`;

function feedbackCard(zone: string, f: FeedbackThread, back: string, open: boolean): Safe {
  const who = f.owner === null ? html`<span class="muted">(账号已删除)</span>` : html`${f.owner.email ?? name(f.owner.displayName)}`;
  const last = f.messages.at(-1);
  return html`<details class="card fb" id="f-${f.id}"${open ? " open" : ""}><summary><b>${who}</b>${f.waiting && f.status === "OPEN" ? html`<span class="tag bad">等回复</span>` : ""}
<span class="peek">${last === undefined ? "" : `${last.author === "TEAM" ? "我们:" : ""}${Array.from(last.body).slice(0, 60).join("")}`}</span><span class="muted">${time(zone, f.updatedAt)}</span></summary>
<div class="report-head"><span class="muted">${[f.platform === null ? "" : word(PLATFORMS, f.platform),
    f.appVersion === null ? "" : `版本 ${f.appVersion}`, `开始于 ${time(zone, f.createdAt)}`].filter(x => x !== "").join(" · ")}</span>
${f.owner === null ? "" : html`<a href="/owners/${f.owner.id}">看这个用户</a>`}
${f.status === "OPEN" ? quick(`/feedback/${f.id}/close`, "关闭", back, "关闭反馈", "", false)
    : quick(`/feedback/${f.id}/reopen`, "重新打开", back, "重新打开反馈", "", false)}</div>
<div class="thread">${f.messages.map(m => html`<div class="msg${m.author === "TEAM" ? " me" : ""}"><b>${m.author === "TEAM" ? `我们(${m.operator})` : "用户"}</b>
<pre>${m.body}</pre><span class="muted">${time(zone, m.createdAt)}</span></div>`)}</div>
<form class="reply" method="post" action="/feedback/${f.id}/reply">${hidden("back", `${back}&open=${f.id}`)}${hidden("reason", "回复反馈")}${hidden("confirm", "yes")}
<textarea name="body" required maxlength="2000" rows="2" placeholder="回复用户(对方在 App 里能看到)" aria-label="回复内容"></textarea>
<div class="row"><label><input type="checkbox" name="close" value="yes"> 回复后关闭</label><button>回复</button></div></form></details>`;
}

/** One line per thread, newest activity first; a click opens it. `open` is the thread just answered. */
export function feedbackPage(zone: string, queue: FeedbackQueue, state: "OPEN" | "CLOSED", done: boolean, open: string | null = null): string {
  const back = `/feedback?status=${state}`;
  return page("反馈", "/feedback", html`
${queue.items.length === 0 ? html`<p class="empty">${state === "OPEN" ? "没有待处理的反馈。" : "还没有关闭的反馈。"}</p>` : ""}
${queue.items.map(f => feedbackCard(zone, f, back, f.id === open || queue.items.length === 1))}
${queue.items.length === 100 ? html`<p class="muted">只显示前 100 条。</p>` : ""}
<p class="muted">用户在 App 的「意见反馈」里写的。你的回复用户在 App 里能看到(不显示是谁回的);用户再回一句,关闭的反馈会自动重新打开。</p>`, done, html`<div class="tools">
<span class="seg"><a class="btn ${state === "OPEN" ? "on" : ""}" href="/feedback?status=OPEN">待处理(${queue.waiting})</a>
<a class="btn ${state === "CLOSED" ? "on" : ""}" href="/feedback?status=CLOSED">已关闭</a></span></div>`);
}

export function ownersPage(zone: string, list: OwnerList, search: string): string {
  return page("用户与聊天", "/owners", html`<form method="get" action="/owners" class="act">
<input name="q" type="search" value="${search}" placeholder="搜索邮箱、名字,或完整的主人编号"><button>搜索</button></form>
${list.more ? html`<p class="muted">结果超过 100 个,只显示最新的 100 个。请用搜索缩小范围。</p>` : ""}
<div class="scroll"><table><tr><th>邮箱</th><th>名字</th><th>状态</th><th class="num">家机</th><th class="num">帖子</th><th>注册时间</th></tr>${list.items.map(o => html`
<tr><td><a href="/owners/${o.id}">${o.email ?? "(没有邮箱)"}</a></td><td>${name(o.displayName)}</td><td>${status(OWNER_STATUS, o.status)}</td>
<td class="num">${o.companions}</td><td class="num">${o.posts}</td><td>${time(zone, o.createdAt)}</td></tr>`)}</table></div>
${list.items.length === 0 ? html`<p class="muted">没有找到。</p>` : ""}`);
}

/** Recent posts or comments, one line each; removing is folded away. */
function contentRows(zone: string, kind: "post" | "comment", items: Content[], back: string): Safe {
  if (items.length === 0) return html`<p class="muted">没有。</p>`;
  return html`${items.map(c => html`<div class="item"><div class="muted">${name(c.author.displayName)}(${c.author.kind === "AI" ? "家机" : "真人"})
 · ${time(zone, c.createdAt)} · ${word(SOURCES, c.source)}${c.removedByAdmin ? html` · <span class="tag bad">已被管理员移除</span>`
    : c.deletedAt === null ? "" : html` · <span class="tag">作者已删除</span>`}</div>
<blockquote>${c.body}</blockquote>
${c.removedByAdmin ? act(`/content/${kind}/${c.id}/restore`, "恢复", back)
    : c.deletedAt === null ? edit("移除", act(`/content/${kind}/${c.id}/remove`, "移除", back, "", true)) : ""}</div>`)}`;
}

/** Where a Companion stands in the community: its account there posts, comments and can be found by others. */
const communityAccount = (c: OwnerDetail["companions"][number]) => c.twinId === null ? html`<span class="muted">还没有</span>` : status(TWIN_STATUS, c.twinStatus);

export function ownerPage(zone: string, detail: OwnerDetail, chats: ChatList, log: LogPage, done: boolean): string {
  const o = detail.owner, back = `/owners/${o.id}`, suspended = o.status === "SUSPENDED";
  return page(o.email ?? name(o.displayName), "/owners", html`<p><a href="/owners">← 用户与聊天</a></p>
<div class="card"><div class="facts"><div>名字<b>${name(o.displayName)}</b></div><div>注册<b>${time(zone, o.createdAt)}</b></div>
<div>状态<b>${status(OWNER_STATUS, o.status)}</b></div><div>家机<b>${detail.companions.length} 个</b></div></div>
<div class="muted">主人编号:${o.id}</div>
${o.status === "DELETED" ? "" : html`${edit("加减积分", html`${act("/models/credit", "调整积分", back, html`${hidden("owner", o.id)}
<label>积分(可以是负数)<input name="credits" type="number" required></label>`)}<p class="muted">调整的是赠送积分;负数最多扣到 0。积分钱包关着时不起作用。</p>`)}
${suspended ? edit("解封", act(`/owners/${o.id}/restore`, "解封", back))
    : edit("封禁", html`${act(`/owners/${o.id}/suspend`, "封禁", back, "", true)}<p class="muted">封禁后,这个人的所有请求立刻被拒绝,他和他的家机在社区里对别人不可见。</p>`)}`}</div>
<div class="two">
${panel("家机", detail.companions.length === 0 ? html`<p class="muted">没有家机。</p>` : html`<table><tr><th>名字</th><th>状态</th><th>社区账号</th></tr>${detail.companions.map(c => html`
<tr><td><b>${name(c.displayName)}</b></td><td>${word(COMPANION_STATUS, c.status)}</td><td>${communityAccount(c)}${c.twinId === null ? ""
    : c.twinStatus === "SUSPENDED" ? edit("恢复", act(`/twins/${c.twinId}/restore`, "恢复社区账号", back))
    : edit("停用", act(`/twins/${c.twinId}/suspend`, "停用社区账号", back, "", true))}</td></tr>`)}</table>
<p class="muted">社区账号 = 家机在社区里发帖、评论、被别人看到用的账号。停用后它发不了帖,别人看不到它;和主人的私聊照常。</p>`)}
${panel("私聊", chats.items.length === 0 ? html`<p class="muted">没有会话。</p>` : html`<table><tr><th>会话</th><th class="num">消息</th><th>最近活动</th></tr>${chats.items.map(c => html`
<tr><td>${c.title ?? (c.direct ? "一对一" : "群聊")} <span class="muted">${c.members.map(m => name(m.displayName)).join("、")}</span>
${edit("查看", html`<form class="act read" method="post" action="/chats/${c.id}">${hidden("back", `/chats/${c.id}`)}
<input name="reason" required maxlength="500" placeholder="原因(必填,记入日志)" aria-label="查看这个会话的原因"><button>查看</button></form>`)}</td>
<td class="num">${c.messages}</td><td>${time(zone, c.activeAt)}</td></tr>`)}</table>`)}
</div>
<div class="two">${panel("最近的帖子", contentRows(zone, "post", detail.posts, back))}${panel("最近的评论", contentRows(zone, "comment", detail.comments, back))}</div>
${panel("操作记录", html`${logTable(zone, log)}${log.next === null ? "" : html`<p><a href="/log?owner=${o.id}&before=${log.next}">更早的记录</a></p>`}`)}`, done);
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
<p><a href="/owners/${chat.chat.ownerId}">← 回到这个用户</a> · 成员:${chat.chat.members.map(m => name(m.displayName)).join("、")}</p>
<p class="muted">本次查看已记入日志,原因:${reason}</p>
${chat.next === null ? html`<p class="muted">已经是最早的消息。</p>` : html`<form method="post" action="/chats/${chat.chat.id}">
<input type="hidden" name="back" value="/chats/${chat.chat.id}"><input type="hidden" name="reason" value="${reason}">
<input type="hidden" name="at" value="${chat.next.at}">
<input type="hidden" name="id" value="${chat.next.id}"><button>更早的消息</button></form>`}
<div class="card thread">${chat.items.length === 0 ? html`<span class="muted">没有消息。</span>` : [...chat.items].reverse().map(m => html`
<div class="msg${m.companionId === null ? " me" : ""}"><b>${speaker(m.companionId)}</b>
<pre>${m.body ?? html`<span class="muted">${m.action ? word(ACTION_WORD, m.action)
  : `${word(MESSAGE_STATUS, m.status)}${m.failure === null ? "" : ` ${m.failure}`}`}</span>`}</pre><span class="muted">${time(zone, m.createdAt)}</span></div>`)}</div>`);
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

export function modelsPage(zone: string, models: Models, catalog: readonly CatalogEntry[], features: readonly Feature[],
  done: boolean, vendors: readonly VendorStatus[] = []): string {
  const q = models.quota, w = models.wallet, back = "/models";
  const vendorsUsed = new Set(catalog.map(m => m.provider)).size;
  const ownOn = (scope: string, key: string) => !models.switches.some(s => s.scope === scope && s.key === key && !s.enabled);
  const gift = w.welcomeCredits > 0 ? w.welcomeCredits : 1000;
  return page("模型与额度", "/models", html`
${vendors.length === 0 ? "" : panel("模型厂商", html`<div class="scroll"><table><tr><th>厂商</th><th>线上服务器的 Key</th><th>余额(实时)</th><th></th></tr>
${vendors.map(v => html`<tr><td>${vendorName(v.key)}</td>
<td>${v.serverKey === null ? html`<span class="tag bad">没有</span> <span class="muted">${v.keyEnv}</span>` : "why" in v.serverKey
    ? html`<span class="muted">看不到:${v.serverKey.why}</span>` : html`<span class="tag">已设置</span> <span class="muted">更新于 ${time(zone, v.serverKey.at)}</span>`}</td>
<td>${v.balance === null ? html`<span class="muted">${v.balanceNote}</span>` : balanceText(v.balance)}</td><td class="links">${billingLink(v.key)}</td></tr>`)}</table></div>
<p class="muted">后台只看得到 Key 有没有、何时换过,看不到也改不了 Key 本身。要加或换 Key,找 Claude 弹输入框直接存进服务器。</p>`)}
${panel("模型开关", html`<div class="scroll"><table><tr><th>开关</th><th>厂商 / 模型名</th><th>现在</th></tr>${switchTargets(catalog).filter(t =>
    // With one company, its switch does exactly what the switch for everything does: shown only if someone turned it off.
    !t.value.startsWith("PROVIDER:") || vendorsUsed > 1 || !ownOn("PROVIDER", t.value.slice(9))).map(t => {
    const cut = t.value.indexOf(":"), scope = t.value.slice(0, cut), key = t.value.slice(cut + 1), on = ownOn(scope, key);
    const entry = scope === "MODEL" ? catalog.find(m => `${m.provider}/${m.model}` === key) : undefined;
    const state = entry === undefined ? (on ? "开" : "关") : switchState(models, entry);
    const text = entry?.name ?? (scope === "ALL" ? html`<b>全部平台模型</b>` : `${vendorName(key)}的全部模型`);
    return html`<tr><td>${toggle("/models/switch", on, t.label, back, hidden("target", t.value), text)}</td><td>${scope === "ALL" ? "" : key}</td><td><span class="tag ${state === "开" ? "" : "bad"}">${state}</span></td></tr>`;
  })}</table></div>
<p class="muted">点一下就生效,并记进操作日志。关掉后:回复显示“平台模型暂时关闭”,不扣额度。上面的开关关着时,下面的模型也停,“现在”一栏写的是实际能不能用。</p>
`)}
${panel("功能开关", html`<div class="scroll"><table><tr><th>功能</th><th>改于</th></tr>${features.map(f => html`
<tr><td>${toggle("/models/feature", f.enabled, word(FEATURES, f.key), back, hidden("key", f.key), word(FEATURES, f.key))}</td><td>${time(zone, f.updatedAt)}</td></tr>`)}</table></div>
<p class="muted">点一下就生效。群聊关掉后:不能新建;已有群聊只能看和删除,不能发消息。单聊不受影响。</p>`)}
${panel("每个家机每天的免费额度", html`
<p>${w.enabled ? html`<span class="tag">积分钱包开着,现在不限</span> 钱包关掉后:` : ""}每天 ${q.dailyCalls} 次调用、${money(q.dailyCostMinor, q.currency)}</p>
${edit("改", act("/models/quota", "保存", back, html`<label>次数 <input name="calls" type="number" min="0" max="100000" required value="${q.dailyCalls}"></label>
<label>金额(美元)<input name="dollars" required inputmode="decimal" size="6" value="${(q.dailyCostMinor / 100).toString()}"></label>
<span class="muted">明天北京时间 8 点起生效</span>`))}`)}
${panel("新人送积分", html`
<div>${toggle("/models/welcome", w.welcomeCredits > 0, "新人送积分", back, hidden("welcome", gift),
    w.welcomeCredits > 0 ? `开:每个新主人第一次用钱包时送 ${count(w.welcomeCredits)} 积分(只送一次)` : "关:新主人不送积分")}${
    w.enabled ? "" : html` <span class="muted">积分钱包关着时,不管这里开不开都不送。</span>`}</div>
${w.welcomeCredits > 0 ? edit("改送多少", act("/models/welcome", "保存", back, html`${hidden("enabled", "on")}
<label>送多少积分 <input name="welcome" type="number" min="1" max="100000000" required value="${w.welcomeCredits}"></label>`)) : ""}
<p class="muted">关掉期间注册的主人,之后再打开时,会在他下一次用钱包时补送一次。${w.welcomeCredits > 0 ? "" : `打开时送 ${count(gift)} 积分,打开后可以改。`}</p>`)}
${panel("主人积分钱包", html`
<div>${toggle("/models/wallet", w.enabled, "主人积分钱包", back, html`${hidden("welcome", w.welcomeCredits)}${hidden("rate", w.creditsPerCent)}${hidden("floor", w.backgroundFloor)}`,
    w.enabled ? "开(主人用积分付钱,不再受每个家机每天的免费额度限制)" : "关(只按每个家机每天的免费额度限制)")}</div>
<p>模型花费每 1 分 = ${w.creditsPerCent} 积分;写日记要给聊天留 ${w.backgroundFloor} 积分。调用失败不扣积分。</p>
${edit("修改钱包规则", act("/models/wallet", "修改钱包规则", back, html`${hidden("enabled", w.enabled ? "on" : "off")}${hidden("welcome", w.welcomeCredits)}
<label>每分积分 <input name="rate" type="number" min="1" required value="${w.creditsPerCent}"></label>
<label>给聊天保留 <input name="floor" type="number" min="0" required value="${w.backgroundFloor}"></label>`))}
<p class="muted">给某个主人加减积分:在<a href="/owners">用户与聊天</a>里打开他。</p>`)}
<p class="muted">每一笔花了多少钱、全平台每天的花费上限,在<a href="/costs">“花费”页</a>。</p>`, done);
}

// ---------- charts: inline SVG, no script; the hover text of a day is the SVG <title> ----------

interface Series { readonly name: string; readonly color: string; readonly values: readonly number[] }
/** The reference categorical palette, in its fixed order: a series gets its slot by what it is, never by rank. */
const SLOTS = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"] as const;
/** The total's line: the text colour, so it reads in light and dark. */
const INK = "currentColor";
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
  const named = series.length <= 4, W = 1000, H = 180, L = 64, R = named ? 110 : 16, T = 12, B = 28;
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
${[0.25, 0.5, 0.75].map(f => html`<line class="grid" x1="${L}" x2="${W - R}" y1="${y(max * f)}" y2="${y(max * f)}"/>`)}
${labels.map((_, i) => i % every === 0 && i > 0 && i < labels.length - 1 ? html`<line class="grid" x1="${x(i)}" x2="${x(i)}" y1="${T}" y2="${H - B}"/>` : "")}
<rect class="frame" x="${L}" y="${T}" width="${W - R - L}" height="${H - T - B}"/>
${[0, 0.25, 0.5, 0.75, 1].map(f => html`<text x="${L - 8}" y="${y(max * f) + 4}" text-anchor="end">${format(max * f)}</text>`)}
${labels.map((d, i) => i % every === 0 || i === labels.length - 1 ? html`<text x="${x(i)}" y="${H - 8}" text-anchor="middle">${label(d)}</text>` : "")}
${series.map(s => html`<polyline fill="none" stroke="${s.color}" stroke-width="2.5" stroke-linejoin="miter" points="${s.values.map((v, i) => `${x(i)},${y(v)}`).join(" ")}"/>
${labels.length <= 31 ? s.values.map((v, i) => html`<rect x="${r1(x(i) - 3.5)}" y="${r1(y(v) - 3.5)}" width="7" height="7" fill="${s.color}"/>`) : ""}`)}
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
/** The App's first month: nothing was used before it, so there is no month before it to pick. */
const FIRST_MONTH = "2026-11";
/** ← last month · next month →, only between the first month and this one. */
function monthNav(path: string, month: string, now: Date): Safe {
  const shift = (n: number) => { const d = new Date(`${month}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 7); };
  const prev = shift(-1), next = shift(1), hasPrev = month > FIRST_MONTH, hasNext = next <= now.toISOString().slice(0, 7);
  return !hasPrev && !hasNext ? html`` : html`<span class="seg">${hasPrev ? html`<a class="btn" href="${path}?month=${prev}">← ${prev}</a>` : ""}${
    hasNext ? html`<a class="btn" href="${path}?month=${next}">${next} →</a>` : ""}</span>`;
}
const costsTabs = (year: boolean, month: string) => html`<span class="seg"><a class="btn ${year ? "" : "on"}" href="/costs?month=${month}">按月</a><a class="btn ${
  year ? "on" : ""}" href="/costs?year=${month.slice(0, 4)}">按年</a></span>`;

/** The Fly estimate under its card: a month at today's machine sizes, from Fly's list prices. Not in any total. */
const FLY_ESTIMATE_NOTE = "按现在的机器配置和 Fly 单价算,不含流量和免费额度;以 Fly 账单为准。";
function flyEstimate(h: Hosts): Safe {
  return h.ok ? html`<div class="sub"><div>估算:按现在的配置,一整月约 <b>${usd(flyMonthCents(h))}</b> <span class="tag">估算</span></div>
<div class="muted">${FLY_ESTIMATE_NOTE}不计入总花费。</div></div>` : html`<div class="sub muted">估算不出:${h.why}</div>`;
}

function vendorCard(v: Vendor, total: number, c: Costs, days: readonly string[], fly: Hosts | null, status: VendorStatus | undefined): Safe {
  const p = c.prices, used = p.planPoints > 0 ? c.totals.speakPoints / p.planPoints : 0;
  return html`<div class="card vendor"><div class="vhead"><span><i style="background:${vendorColor(v.key)}"></i><b>${v.name}</b></span>
<span class="muted">占 ${percent(v.cents, total)}</span></div><div class="big">${usd(v.cents)}</div>
${v.lines.length === 0 ? html`<p class="muted">这个月没有花费。${v.key === "supabase" ? "免费版没有月费。" : html`有月费的话,去 <a href="/costs/settings">费用设置</a> 里填。`}</p>`
    : html`<table class="lines">${v.lines.map(l => html`<tr><td>${l.label}${l.fixed ? html` <span class="tag">固定月费</span>` : ""}${
      l.note ? html` <span class="muted">${l.note}</span>` : ""}</td><td class="num">${usd(l.cents)}</td></tr>`)}</table>`}
${v.key === "minimax" ? html`<div class="sub"><div>语音包月点数:已用 ${count(c.totals.speakPoints)} / ${count(p.planPoints)}(${Math.round(used * 100)}%)</div>${meter(used)}
${used > 0.8 ? html`<div class="muted">${used > 1 ? "已经超出包月,超出部分按量收费。" : "快用完了,用完后按量收费。"}</div>` : ""}</div>` : ""}
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
export function costsPage(now: Date, c: Costs, cap: Models["cap"] | null, done: boolean, fly: Hosts | null = null,
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
  const tools = html`${costsTabs(false, c.month)}${monthNav("/costs", c.month, now)}
<a class="btn" href="/costs/export.xlsx?month=${c.month}">导出 xlsx</a>`;
  // A past month with no use at all is before the App started: nothing was paid, not even the fixed bills.
  if (!thisMonth && usedMonths([c]).length === 0) {
    return page(`花费 · ${c.month}`, "/costs", html`<p class="empty">${c.month} 还没有任何用量,也不算固定月费。</p>`, done, bar(tools));
  }
  return page(`花费 · ${c.month}`, "/costs", html`
<div class="card total spend"><div><div class="muted">${thisMonth ? "本月到今天" : "这个月"}总花费</div><div class="big">${usd(total)}</div>
<div class="muted">按用量 ${usd(usage)} + 固定月费 ${usd(t.fixedCents)}</div></div>
${cap === null ? "" : html`<div class="today ${cap.enabled && capShare > 1 ? "over" : cap.enabled && capShare > 0.8 ? "near" : ""}">
<div class="muted">其中今天(UTC)平台模型</div><div class="mid">${money(cap.spentTodayMinor, cap.currency)}${cap.enabled ? html` <span class="muted">/ 上限 ${money(cap.dailyCostMinor, cap.currency)}</span>` : ""}</div>
${cap.enabled ? meter(capShare) : ""}
<div>${toggle("/costs/cap", cap.enabled, "每天花费上限", self, hidden("dollars", ((cap.dailyCostMinor > 0 ? cap.dailyCostMinor : 500) / 100).toString()),
    cap.enabled ? "每天上限开着" : `每天上限关着${cap.dailyCostMinor > 0 ? "" : ",打开时是每天 5 美元"}`)}</div>
${edit("改上限", html`${act("/costs/cap", "保存", self, html`${hidden("enabled", cap.enabled ? "on" : "off")}
<label>每天(美元)<input name="dollars" required inputmode="decimal" size="6" value="${(cap.dailyCostMinor / 100).toString()}"></label>`)}
<p class="muted">到了上限,平台模型当天不再回复,不扣主人额度。</p>`)}</div>`}
</div>
${panel("每天按用量的花费", html`${series.length === 0 ? html`<p class="muted">这个月还没有按用量的花费。</p>` : lineChart(days, series, usd, d => d.slice(5))}
<p class="muted">固定月费不在图里。</p>`)}
<h2>按厂商</h2>
<div class="vendors">${vendors.map(v => vendorCard(v, total, c, days, fly, statuses.find(s => s.key === v.key)))}</div>
${m.byCompanion.length === 0 ? "" : panel("AI 模型:花费最多的家机(前 20)", html`<div class="scroll"><table><tr><th>家机</th><th class="num">调用</th><th class="num">花费</th></tr>${
    m.byCompanion.map(x => html`
<tr><td>${ownerLink(x.ownerId, x.displayName)}</td><td class="num">${x.calls}</td><td class="num">${x.currency === "USD" ? usd(x.costMinor) : money(x.costMinor, x.currency)}</td></tr>`)}</table></div>`)}
<p class="muted">按 UTC 日期。主人自带 Key 和自己的 Agent 不花平台的钱,不在这里。固定月费和语音单价在 <a href="/costs/settings">费用设置</a> 里改。</p>`, done, bar(tools));
}

/** A year of months (oldest first), each company's share, like a ledger. */
export function costsYearPage(now: Date, year: string, months: readonly Costs[]): string {
  const rows = usedMonths(months).map(c => ({ c, vendors: vendorsOf(c) }));
  const keys = [...new Set(rows.flatMap(r => r.vendors.filter(v => v.cents > 0).map(v => v.key)))];
  const cents = (r: (typeof rows)[number], key: string) => r.vendors.find(v => v.key === key)?.cents ?? 0;
  const sum = (r: (typeof rows)[number]) => r.vendors.reduce((n, v) => n + v.cents, 0);
  const total = rows.reduce((n, r) => n + sum(r), 0);
  const series = [...(keys.length > 1 ? [{ name: "合计", color: INK, values: rows.map(sum) }] : []),
    ...keys.map(k => ({ name: vendorName(k), color: k === "supabase" || k === "fly" || k === "other" ? "#9ca3af" : vendorColor(k), values: rows.map(r => cents(r, k)) }))];
  const y = Number(year);
  const tools = html`${costsTabs(true, `${year}-${months.at(-1)?.month.slice(5) ?? "01"}`)}
<span class="seg">${rows.length > 0 && rows.length === months.length ? html`<a class="btn" href="/costs?year=${y - 1}">← ${y - 1}</a>` : ""}${y < now.getUTCFullYear() ? html`<a class="btn" href="/costs?year=${y + 1}">${y + 1} →</a>` : ""}</span>
<a class="btn" href="/costs/export.xlsx?year=${year}">导出 xlsx</a>`;
  return page(`花费 · ${year} 年`, "/costs", html`
<div class="cards hero"><div class="card total"><div class="muted">${year} 年${y === now.getUTCFullYear() ? "到今天" : ""}总花费</div><div class="big">${usd(total)}</div>
<div class="muted">${rows.length} 个月 · 平均每月 ${usd(rows.length > 0 ? total / rows.length : 0)}</div></div></div>
${rows.length === 0 ? html`<p class="muted">${year} 年还没有任何用量。</p>` : html`${panel("每月花费(含固定月费)", lineChart(rows.map(r => r.c.month), series.length > 8 ? series.slice(0, 8) : series, usd, d => `${Number(d.slice(5))}月`))}
${panel("账本", html`<div class="scroll"><table><tr><th>月份</th>${keys.map(k => html`<th class="num">${vendorName(k)}</th>`)}<th class="num">合计</th></tr>
${[...rows].reverse().map(r => html`<tr><td><a href="/costs?month=${r.c.month}">${r.c.month}</a></td>${keys.map(k => html`<td class="num">${usd(cents(r, k))}</td>`)}
<td class="num"><b>${usd(sum(r))}</b></td></tr>`)}
<tr><td><b>全年</b></td>${keys.map(k => html`<td class="num"><b>${usd(rows.reduce((n, r) => n + cents(r, k), 0))}</b></td>`)}<td class="num"><b>${usd(total)}</b></td></tr></table></div>
<p class="muted">点月份看明细。固定月费按现在填的数算,改了以后以前的月份也跟着变。</p>`)}`}`, false, bar(tools));
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
<label>转文字每小时(美元)<input name="hear" required inputmode="decimal" size="8" value="${(p.hearCentsPerHour / 100).toString()}"></label>`)}`)}`, done);
}

// ---------- 运营数据 ----------

export interface ActivityDay {
  day: string; newOwners: number; chatters: number; ownerMessages: number; replies: number; failed: number;
  voiceIn: number; voiceOut: number; posts: number; aiPosts: number; comments: number; creditsSpent: number; creditsBought: number;
}
/** companion_admin.activity (migration 0059): one month, counts only. */
export interface Activity { month: string; from: string; to: string; owners: number; companions: number; chatters: number; days: ActivityDay[] }

export function statsPage(now: Date, a: Activity): string {
  const thisMonth = a.month === now.toISOString().slice(0, 7);
  const days = fromFirst(a.days, d => Object.values(d).some(v => typeof v === "number" && v > 0));
  const sum = (k: keyof Omit<ActivityDay, "day">) => days.reduce((n, d) => n + d[k], 0);
  const today = thisMonth ? days.at(-1) : undefined;
  const labels = days.map(d => d.day);
  const line = (name: string, slot: number, k: keyof Omit<ActivityDay, "day">) => ({ name, color: SLOTS[slot]!, values: days.map(d => d[k]) });
  const tools = monthNav("/stats", a.month, now);
  const kpi = (label: string, value: string, note = "") => html`<tr><td>${label}</td><td class="num"><b>${value}</b></td><td class="muted">${note}</td></tr>`;
  return page(`运营数据 · ${a.month}`, "/stats", html`
<section class="panel"><div class="kv2"><table class="kv">
${kpi("主人", count(a.owners))}${kpi("家机", count(a.companions))}${kpi("新注册", count(sum("newOwners")))}
</table><table class="kv">
${kpi(thisMonth ? "本月聊天的人" : "这个月聊天的人", count(a.chatters))}
${today === undefined ? "" : kpi("今天聊天的人", count(today.chatters), `主人 ${count(today.ownerMessages)} · 家机 ${count(today.replies)} 条`)}
${kpi("消息", count(sum("ownerMessages") + sum("replies")), `主人 ${count(sum("ownerMessages"))} · 家机 ${count(sum("replies"))}${sum("failed") > 0 ? ` · 失败 ${count(sum("failed"))}` : ""}`)}
${kpi("积分消耗", count(sum("creditsSpent")))}
</table></div></section>
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
<p class="muted">按 UTC 日期,只有数量,不含内容。主人和家机是现在的数,不含已删除;“聊天的人”= 那天至少发过一条消息的主人;积分消耗 = 钱包开着时模型调用扣的积分。</p>`,
  false, bar(tools));
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

export function systemPage(zone: string, s: SystemInfo, h: Hosts): string {
  const space = s.databaseBytes / DATABASE_LIMIT_BYTES, conns = s.maxConnections > 0 ? s.connections / s.maxConnections : 0;
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
</div>
${panel(html`主机(Fly.io) <span class="muted links">${billingLink("fly")}</span>`, h.ok ? html`<div class="scroll"><table class="hosts"><tr><th>应用</th><th>状态</th><th>配置</th><th class="num">每月约</th><th>最近一次停止</th></tr>
${h.machines.map(m => html`<tr><td><b>${m.app}</b></td>
<td><span class="tag ${m.state === "started" ? "good" : "bad"}">${word(MACHINE_STATE, m.state)}</span></td>
<td>${[m.cpus === null ? "" : `${m.cpus} 核`, m.memoryMb === null ? "" : `${m.memoryMb} MB`, m.region].filter(x => x !== "").join(" · ")}</td>
<td class="num">${machineCents(m) === null ? html`<span class="muted">只收磁盘</span>` : usd(machineCents(m)!)}</td>
<td>${m.lastExit === null ? html`<span class="muted">—</span>` : html`${time(zone, m.lastExit.at)}${
    m.lastExit.oom ? html` <span class="tag bad">内存不够被杀掉</span>` : ""}`}</td></tr>`)}
${h.volumes.map(v => html`<tr><td><b>${v.app}</b> <span class="muted">磁盘 ${v.name}</span></td><td></td><td>${v.sizeGb} GB · ${v.region}</td>
<td class="num">${usd(volumeCents(v))}</td><td></td></tr>`)}</table></div>
<p class="muted">费用是估算:${FLY_ESTIMATE_NOTE}</p>`
    : html`<p class="err">${h.why}</p>`)}
${panel(html`数据库(Supabase 免费版) <span class="muted links">${billingLink("supabase")}</span>`, html`<p>PostgreSQL ${s.version} · 上次重启 ${time(zone, s.startedAt)}</p>
<div class="scroll"><table><tr><th>最大的表</th><th class="num">占用</th><th class="num">大约行数</th></tr>${s.tables.map(t => html`
<tr><td>${t.name}</td><td class="num">${mb(t.bytes)}</td><td class="num">${t.rows === null ? "—" : count(t.rows)}</td></tr>`)}</table></div>
<p class="muted">免费版的限制:数据库 500 MB(满了只能读不能写)、每月流出流量 5 GB、文件存储 1 GB;
连续 7 天没有任何请求,项目会被暂停。流量和文件存储只能在 <a href="https://supabase.com/dashboard">Supabase 控制台</a> 的 Usage 里看。</p>`)}`,
  false);
}

// ---------- 提示词: what a model is told, and the blocks the operators can reword ----------

/** The saved wording of each reworded block, as companion_admin.prompts() returns it. */
export type SavedPrompts = Readonly<Record<string, { body: string; updatedAt: string }>>;

/** One model call as the console shows it: its rules, what goes with them, and which blocks are in the rules (in order). */
interface PromptView {
  readonly title: string; readonly when: string; readonly system: string; readonly user: string | null;
  readonly blocks: readonly string[];
}

/**
 * Every prompt, written by the same code the API server runs, for a made-up Companion: one with a
 * voice that may act, so every block is there. What an Owner fills in is marked (示例).
 */
function promptViews(zone: string, now: Date, texts: PromptTexts): PromptView[] {
  const at = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000).toISOString();
  const companion: ChatClaim["companion"] = {
    companionId: "sample", displayName: "小满",
    identity: { identitySummary: "(示例)主人写的简介", personaTraits: "(示例)主人写的性格", speakingStyle: "(示例)主人写的说话风格" },
    settings: { groupActivity: "NORMAL", companionInteraction: "NORMAL", model: null, voice: "sample", revision: 1 },
  };
  const said = (companionId: string | null, body: string, minutesAgo: number) =>
    ({ companionId, body, action: null, mentions: [], sentAt: at(minutesAgo) });
  const history = [said(null, "(示例)主人昨晚说的话", 600), said("sample", "(示例)小满的回答", 599), said(null, "(示例)主人刚发的消息", 1)];
  const turn: ChatClaim = { chatId: "sample", replyId: "sample", claimId: "sample", replyTo: "OWNER", optional: false, direct: true, canAct: true,
    companion, members: [{ companionId: "sample", displayName: "小满" }], history, timeZone: zone, ownerName: "(示例)称呼",
    canRemind: true, reminders: [{ id: "sample", dueAt: at(-600), note: "(示例)家机答应过的提醒" }] };
  // The same chat a day later, with nobody to answer: the Companion writes first, or delivers a reminder.
  const quiet = history.slice(0, 2);
  const greeting: ChatClaim = { ...turn, replyTo: "SELF", optional: true, history: quiet, canRemind: false, reminders: [], reach: { kind: "GREETING" } };
  const reminder: ChatClaim = { ...greeting, replyTo: "REMINDER", reach: { kind: "REMINDER", note: "(示例)主人让它提醒的事", dueAt: at(0) } };
  const memories = [{ body: "(示例)主人记下的、或自动记忆记下的一件事", createdAt: at(40 * 24 * 60) }];
  const group = { ...turn, direct: false, optional: true, canAct: false, members: [...turn.members, { companionId: "other", displayName: "(示例)另一位家机" }] };
  return [
    { title: "聊天回复", when: "主人发来消息、家机要回复的时候。平台的模型和主人自带 Key 的模型都用这一份。" +
      "记忆多到放不下(约 3000 字)时,更早的记忆里和眼下聊的事有关的几条,会另外附在聊天记录前面。",
      blocks: ["CHAT_STYLE", "CHAT_VOICE", "CHAT_ACTION", "CHAT_REMIND", "CHAT_WEB", "CHAT_TIME"], ...replyPrompt(turn, memories, texts, now, { web: true }) },
    { title: "主动找主人", blocks: ["CHAT_STYLE", "CHAT_VOICE", "CHAT_ACTION", "CHAT_REACH", "CHAT_TIME"],
      when: "主人给这位家机打开了“主动找你”,并且有一阵没来聊天的时候(偶尔:8 小时以上,一天最多 1 次;经常:3 小时以上,一天最多 2 次)。" +
        "主人当地 23 点以后不找,早上从 8 点到 10 点之间的某一刻才开始(每个家机每天不一样,免得大家同时开口);" +
        "上一次主动说的话(或者发的提醒)主人还没回,就不再找;主人超过 7 天没来也不再找。家机可以决定不说。" +
        "这里只改“主动找主人时说什么”这一段,其余几段和“聊天回复”是同一份,在上面改。",
      ...replyPrompt(greeting, memories, texts, now) },
    { title: "到点提醒", blocks: ["CHAT_STYLE", "CHAT_VOICE", "CHAT_ACTION", "CHAT_TIME"],
      when: "主人在私聊里让家机到某个时间提醒自己(家机当时照“什么时候设提醒”那一段写下了提醒),到了时间。这几段和“聊天回复”是同一份,在上面改。" +
        "模型用不了的时候(没额度、被关掉、出错),服务器会用一句固定的话把提醒发出去。",
      ...replyPrompt(reminder, memories, texts, now) },
    { title: "写日记", when: "家机写日记的时候。", blocks: ["DIARY_STYLE"],
      ...diaryPrompt({ status: "WRITE", entryId: "sample", claimId: "sample", companion, messages: history, timeZone: zone, ownerName: turn.ownerName,
        posts: [{ kind: "POST", body: "(示例)小满这几天发过的动态", at: at(300) }] }, memories, texts, now) },
    { title: "发社区动态", when: "家机自己发动态的时候(主人打开了自动发帖)。这里不带记忆和私聊,因为写出来的东西是公开的。", blocks: ["POST_STYLE"],
      ...postPrompt({ status: "WRITE", runId: "sample", claimId: "sample", companion, localTime: "(示例)主人当地的时间",
        own: [{ body: "(示例)小满最近发过的动态", at: at(300) }], others: [{ author: "(示例)别人", body: "(示例)社区里别人的动态", at: at(60) }] }, texts) },
    { title: "自动记忆", when: "自动记忆默认开着(主人可以关):主人在私聊里每说满 50 句(选了“经常”是 10 句),从这段私聊里挑出值得长期记住的事。", blocks: ["MEMORY_WHAT"],
      ...memoryPrompt({ status: "WRITE", claimId: "sample", companion, timeZone: zone,
        known: [{ id: "sample-auto", source: "AUTO", body: "(示例)以前自动记下的一件事", createdAt: at(40 * 24 * 60) },
          { id: "sample-owner", source: "OWNER", body: "(示例)主人亲手写的一件事", createdAt: at(90 * 24 * 60) }],
        messages: [{ companionId: null, body: "(示例)主人说的话", action: null, sentAt: at(5) }] }, texts, now) },
    { title: "主人自己接的 agent(自建家机)", blocks: ["CHAT_VOICE", "CHAT_ACTION", "CHAT_REMIND"], user: null,
      when: "主人接了自己的 agent 的时候。它有自己的人设和记忆,我们只给它这几条规则。语音、动作和提醒三段和“聊天回复”是同一份,在上面改。",
      system: agentMessages(turn, texts, now)[0]!.content },
    { title: "群聊里要不要开口", when: "群聊里先让便宜的模型判断这位家机要不要说话,它只回答“是”或“否”。", blocks: [], ...decisionPrompt(group) },
  ];
}

/** A prompt's rules cut into what is fixed and the blocks that can be reworded, in the order they are written. */
function cutPrompt(system: string, keys: readonly string[], texts: PromptTexts): (string | PromptBlock)[] {
  const parts: (string | PromptBlock)[] = [];
  let from = 0;
  for (const block of PROMPT_BLOCKS.filter(b => keys.includes(b.key))) {
    const text = texts[block.key] ?? block.text, found = system.indexOf(text, from);
    if (found < 0) continue;
    parts.push(system.slice(from, found), block);
    from = found + text.length;
  }
  parts.push(system.slice(from));
  // The line breaks around a block belong to the page's boxes, not to the text.
  return parts.map(part => typeof part === "string" ? part.replace(/^\n|\n$/g, "") : part).filter(part => part !== "");
}

/** One block: what the models are told now, and (where it is edited) the forms to reword it or go back. */
function promptBox(zone: string, block: PromptBlock, saved: SavedPrompts[string] | undefined, forms: boolean): Safe {
  const refused = saved === undefined ? null : promptTextRefusal(block, saved.body);
  const key = html`<input type="hidden" name="key" value="${block.key}">`;
  return html`<div class="own ${refused === null ? "" : "off"}"><b>可以改:${block.title}</b>${saved === undefined ? html`<span class="tag">内置文字</span>`
    : refused === null ? html`<span class="tag">已修改 · ${time(zone, saved.updatedAt)}</span>` : html`<span class="tag bad">改过的文字用不了,现在用的是内置文字</span>`}
<pre>${saved !== undefined && refused === null ? saved.body : block.text}</pre>${!forms ? "" : html`
${refused === null ? "" : html`<p class="err">${refused}</p>`}
<p class="muted">用在:${block.where}。${block.marks.length === 0 ? "" : `必须保留「${block.marks.join("」和「")}」。`}${block.hint ?? ""}</p>
${edit("修改这一段", act("/prompts/set", "保存", "/prompts", html`${key}
<textarea name="body" required maxlength="${PROMPT_TEXT_MAX}" rows="${block.text.split("\n").length + 3}">${saved?.body ?? block.text}</textarea>`))}
${saved === undefined ? "" : edit("恢复内置文字", html`<p class="muted">内置文字是:</p><pre>${block.text}</pre>
${act("/prompts/set", "恢复内置文字", "/prompts", html`${key}<input type="hidden" name="restore" value="yes">`)}`)}`}</div>`;
}

export function promptsPage(zone: string, now: Date, saved: SavedPrompts, done: boolean): string {
  const texts = usablePromptTexts(Object.fromEntries(Object.entries(saved).map(([key, row]) => [key, row.body])));
  const changed = PROMPT_BLOCKS.filter(block => saved[block.key] !== undefined).length;
  // A block is reworded where it is first shown; further down it is only shown.
  const shown = new Set<string>();
  const first = (key: string): boolean => shown.size < shown.add(key).size;
  return page("提示词", "/prompts", html`
<p>这里是服务器每次请模型开口时写给它的说明(提示词),和线上用的是同一份代码生成的;只有管理员看得到,主人看不到。<b>黄色框</b>里的段落可以改,保存后从下一条回复起生效;
<span class="muted">折起来的是固定的部分</span>,点开能看:回答的格式(服务器要照着读)、防止别人的话被当成指令、隐私和“不让主人离不开”的底线,这些要改得改代码。</p>
<p class="muted">示例里的家机、人设、记忆和聊天是编的,只为了让你看到完整的样子;真实调用时,标着(示例)的位置填的是主人自己写的人设、称呼、记忆和真实的聊天记录。
每次修改都记在<a href="/log">操作日志</a>里,带修改前和修改后的文字,想找回以前的版本去那里看。现在有 ${changed} / ${PROMPT_BLOCKS.length} 段改过。</p>
${promptViews(zone, now, texts).map(view => panel(view.title, html`<p class="muted">${view.when}</p>
${cutPrompt(view.system, view.blocks, texts).map(part => typeof part === "string"
    ? html`<details class="fixed"><summary>固定的部分(${part.length} 字)</summary><pre class="fixed">${part}</pre></details>`
    : promptBox(zone, part, saved[part.key], first(part.key)))}
${view.user === null ? "" : html`<details class="edit"><summary>和这段说明一起发给模型的材料(示例)</summary><pre class="fixed">${view.user}</pre></details>`}`))}`,
  done);
}

// ---------- 模板与技能: the characters and skills the platform offers ----------

/** companion_admin.kit (migration 0073). */
export interface Kit {
  templates: { id: string; title: string; summary: string; name: string; description: string; personality: string; example: string;
    position: number; enabled: boolean; updatedAt: string }[];
  skills: { id: string; title: string; summary: string; body: string; position: number; enabled: boolean; updatedAt: string; usedBy: number }[];
  /** What Owners handed in for the shelf (migration 0084): the ones waiting first, then the reported ones, then the rest. */
  shared: { id: string; title: string; summary: string; body: string; status: "PENDING" | "APPROVED" | "REJECTED" | "REMOVED";
    note: string | null; authorId: string; author: string | null; authorStatus: string; createdAt: string; reviewedAt: string | null; usedBy: number;
    reports: { reason: string; details: string; at: string }[] }[];
  ownSkills: number;
}

/** The fields of a template or a skill, filled in with what it has now (nothing: a new one). */
const kitFields = (kind: "template" | "skill", item?: Kit["templates"][number] | Kit["skills"][number]): Safe => {
  const t = kind === "template" ? item as Kit["templates"][number] | undefined : undefined;
  const s = kind === "skill" ? item as Kit["skills"][number] | undefined : undefined;
  return html`${item === undefined ? "" : hidden("id", item.id)}
<label>名称 <input name="title" required maxlength="20" value="${item?.title ?? ""}" placeholder="${kind === "template" ? "如:温柔的倾听者" : "如:英语陪练"}"></label>
<label>一句话介绍 <input name="summary" required maxlength="100" size="40" value="${item?.summary ?? ""}" placeholder="主人在 App 里看到的那句话"></label>
${kind === "template" ? html`<label>默认名字 <input name="name" required maxlength="20" size="10" value="${t?.name ?? ""}" placeholder="主人可以改"></label>
<textarea name="description" required maxlength="600" rows="3" placeholder="简介:TA 是谁(最多 600 字)" aria-label="简介">${t?.description ?? ""}</textarea>
<textarea name="personality" maxlength="600" rows="2" placeholder="性格(可不填,最多 600 字)" aria-label="性格">${t?.personality ?? ""}</textarea>
<textarea name="example" maxlength="1500" rows="4" placeholder="示例对话(可不填,最多 1500 字),一行一句。用 {{char}} 代表家机的名字,主人改了名字它会跟着变。如:主人：今天好累 / {{char}}：辛苦啦" aria-label="示例对话">${t?.example ?? ""}</textarea>`
    : html`<textarea name="body" required maxlength="600" rows="4" placeholder="写给模型的话:什么时候用、怎么做(最多 600 字)。App 里不显示这段,但不要写需要保密的内容。" aria-label="技能内容">${s?.body ?? ""}</textarea>`}
<label>排序 <input name="position" type="number" min="0" max="9999" required size="4" value="${item?.position ?? 0}"></label>
<label><input type="checkbox" name="enabled" value="on"${item === undefined || item.enabled ? html` checked` : ""}> 上架</label>`;
};

const SHARED_STATUS: Readonly<Record<string, string>> = { PENDING: "等待审核", APPROVED: "上架中", REJECTED: "已退回", REMOVED: "已下架" };

/** One skill an Owner handed in, with what can be decided about it now. */
const sharedCard = (zone: string, s: Kit["shared"][number]): Safe => {
  const decide = (decision: string, label: string, danger = false) =>
    act("/kit/shared", label, "/kit", html`${hidden("id", s.id)}${hidden("decision", decision)}${decision === "KEEP" ? hidden("seen", s.reports.at(-1)?.at ?? "") : ""}`, danger);
  return html`<div class="card">
<p><b>${s.title}</b> <span class="tag ${s.status === "APPROVED" ? "good" : s.status === "PENDING" ? "" : "bad"}">${word(SHARED_STATUS, s.status)}</span>
${s.reports.length === 0 ? "" : html`<span class="tag bad">${count(s.reports.length)} 条举报</span>`}
${s.authorStatus === "ACTIVE" ? "" : html`<span class="tag bad">作者账号${s.authorStatus === "SUSPENDED" ? "被封禁" : "已注销"},技能暂不显示</span>`}
<span class="muted">作者 ${ownerLink(s.authorId, s.author)} · 投稿于 ${time(zone, s.createdAt)}${s.reviewedAt === null ? "" : ` · 处理于 ${time(zone, s.reviewedAt)}`} · ${count(s.usedBy)} 个家机打开了</span></p>
<p class="muted">${s.summary}</p><pre>${s.body}</pre>
${s.note === null ? "" : html`<p class="muted">告诉作者的原因:${s.note}</p>`}
${s.reports.length === 0 ? "" : html`<ul>${s.reports.map(r => html`<li>${word(REASONS, r.reason)}${r.details === "" ? "" : `:${r.details}`} <span class="muted">${time(zone, r.at)}</span></li>`)}</ul>`}
${s.status === "PENDING" ? html`${edit("通过", decide("APPROVE", "通过,放上技能广场"))}${edit("退回", decide("REJECT", "退回(原因会给作者看)"))}` : ""}
${s.status === "APPROVED" ? html`${edit("下架", decide("REMOVE", "下架(原因会给作者看)", true))}${s.reports.length === 0 ? "" : edit("不处理举报", decide("KEEP", "保留技能,关闭举报"))}` : ""}
${s.status === "REJECTED" || s.status === "REMOVED" ? edit("重新通过", decide("APPROVE", "通过,放上技能广场")) : ""}</div>`;
};

export function kitPage(zone: string, kit: Kit, done: boolean): string {
  const back = "/kit";
  const shelf = (enabled: boolean) => enabled ? html`<span class="tag good">上架中</span>` : html`<span class="tag bad">已下架</span>`;
  const waiting = kit.shared.filter(s => s.status === "PENDING"), reported = kit.shared.filter(s => s.status !== "PENDING" && s.reports.length > 0);
  const rest = kit.shared.filter(s => s.status !== "PENDING" && s.reports.length === 0);
  return page("模板与技能", "/kit", html`
<p>这里是平台提供给主人的两样东西。<b>人设模板</b>是写好的角色,主人新建家机时挑一个当起点,之后可以随便改。
<b>技能</b>是一段写给模型的话(什么时候、怎么做一件事),主人给自己的家机打开后,每次聊天回复都会带上。App 里主人只看得到技能的名称和一句话介绍。内容不是秘密:它和其他说明一起发给模型,主人接了自己的模型时会发到主人自己的服务上,所以不要写需要保密的东西。</p>
<p class="muted">每个家机最多同时打开 5 个技能(官方的和主人自己写的加在一起)。下架的技能不再发给任何家机,重新上架后原来打开它的家机会恢复。
主人自己写的技能现在一共有 ${count(kit.ownSkills)} 个,只对他们自己的家机生效,这里不显示内容。</p>
${panel("人设模板", html`${kit.templates.length === 0 ? html`<p class="muted">还没有模板。</p>` : kit.templates.map(t => html`<div class="card">
<p><b>${t.title}</b> ${shelf(t.enabled)} <span class="muted">默认名字:${t.name} · 排序 ${t.position} · 更新于 ${time(zone, t.updatedAt)}</span></p>
<p class="muted">${t.summary}</p>
<dl class="detail"><dt>简介</dt><dd><pre>${t.description}</pre></dd>${t.personality === "" ? "" : html`<dt>性格</dt><dd><pre>${t.personality}</pre></dd>`}
${t.example === "" ? "" : html`<dt>示例对话</dt><dd><pre>${t.example}</pre></dd>`}</dl>
${edit("修改", act("/kit/template", "保存", back, kitFields("template", t)))}
${edit("删除", act("/kit/template/delete", "删除这个模板", back, hidden("id", t.id), true))}</div>`)}
${edit("新增一个模板", act("/kit/template", "新增", back, kitFields("template")))}
<p class="muted">模板里的文字会像主人导入的角色卡一样过一遍检查:带密钥、电话邮箱、网址或者“忽略以上指令”这类话的保存不了。已经用模板建好的家机不受之后修改的影响。</p>`)}
${panel("官方技能", html`${kit.skills.length === 0 ? html`<p class="muted">还没有技能。</p>` : kit.skills.map(s => html`<div class="card">
<p><b>${s.title}</b> ${shelf(s.enabled)} <span class="muted">${count(s.usedBy)} 个家机打开了 · 排序 ${s.position} · 更新于 ${time(zone, s.updatedAt)}</span></p>
<p class="muted">${s.summary}</p><pre>${s.body}</pre>
${edit("修改", act("/kit/skill", "保存", back, kitFields("skill", s)))}
${edit("删除", act("/kit/skill/delete", "删除这个技能", back, hidden("id", s.id), true))}</div>`)}
${edit("新增一个技能", act("/kit/skill", "新增", back, kitFields("skill")))}
<p class="muted">改完从下一条回复起生效。技能写在人设后面、平台的规则前面:它不能推翻回答的格式、安全和隐私这些固定的规则。删除一个技能,打开它的家机就没有它了;只是暂时不用请下架。</p>`)}
${panel(html`主人投稿的技能 <span class="muted">${count(waiting.length)} 个等待审核 · ${count(reported.length)} 个被举报</span>`, html`
<p class="muted">主人可以把自己写的技能投稿到技能广场。<b>通过之前别人看不到</b>;通过以后所有主人都能看到全文,并给自己的家机打开。
技能是写给模型的话,会进到别人家机的提示词里,所以请整段读完再通过:有没有让家机套取隐私、引导花钱、冒充平台或推翻规则的话。
这里不能改投稿的文字:不合适就退回,作者改完会重新投稿。退回和下架时填的原因会原样给作者看;下架会让所有打开它的家机立刻关掉它。
“不处理举报”只关掉这一页上显示出来的举报,之后新来的会留着。作者被封禁或注销期间,他的技能不在广场上、也不发给任何家机;解封后自动恢复。</p>
${kit.shared.length === 0 ? html`<p class="muted">还没有人投稿。</p>` : html`${waiting.map(s => sharedCard(zone, s))}${reported.map(s => sharedCard(zone, s))}
${rest.length === 0 ? "" : html`<details class="edit"><summary>已处理的 ${count(rest.length)} 个</summary>${rest.map(s => sharedCard(zone, s))}</details>`}`}`)}`, done);
}

export function logPage(zone: string, log: LogPage, owner: string | null): string {
  return page("操作日志", "/log", html`${owner === null ? "" : html`<p>只看主人 <a href="/owners/${owner}">${owner}</a> 相关的记录 · <a href="/log">看全部</a></p>`}
${logTable(zone, log)}
${log.next === null ? "" : html`<p><a href="/log?before=${log.next}${owner === null ? "" : `&owner=${owner}`}">更早的记录</a></p>`}`);
}
