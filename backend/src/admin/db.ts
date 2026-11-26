/**
 * The admin console's only way into the database: the functions in schema companion_admin
 * (migration 0042). The console connects as an operator's own login, a member of companion_admin,
 * which can call these functions and nothing else.
 */
import type pg from "pg";

export type AdminFunction = "reports" | "report_resolve" | "owners" | "owner_detail" | "owner_suspend" | "twin_suspend"
  | "content_remove" | "content_restore" | "chats" | "chat_read" | "models" | "model_switch_set" | "chat_quota_set"
  | "spend" | "log" | "features" | "feature_set" | "spend_cap_set" | "wallet_policy_set" | "wallet_adjust"
  | "costs" | "fixed_cost_set" | "voice_prices_set" | "activity" | "system" | "prompts" | "prompt_set"
  | "feedback" | "feedback_reply" | "feedback_close";

export interface AdminDb {
  /** Calls one console function and returns its JSON (undefined for the ones that return nothing). */
  call<T>(fn: AdminFunction, ...args: unknown[]): Promise<T>;
}

/** The database said no, for a reason the operator can act on. The message is shown as it is. */
export class AdminRefusal extends Error {}

const KNOWN: readonly (readonly [RegExp, string])[] = [
  [/^a reason of 1 to 500 characters is required$/, "请填写原因(1 到 500 个字)。"],
  [/^already suspended$/, "已经是停用 / 封禁状态,没有重复执行。"],
  [/^not suspended$/, "现在并没有被停用 / 封禁。"],
  [/^report already reviewed by (.+)$/, "这条举报已经被 $1 处理过了,这次没有执行。"],
  [/^report not found$/, "没有找到这条举报。"],
  [/^content not found or already deleted$/, "内容不存在,或者已经被删除。如果是作者自己删的,请用“不处理”结案。"],
  [/^content is not removed by an administrator$/, "这条内容不是管理员移除的(可能作者已经自己删除),不能恢复。"],
  [/^the original text is not in the log$/, "日志里找不到原文,不能恢复。"],
  [/^a reported account has no content to remove$/, "被举报的是账号本身,没有内容可以移除。"],
  [/^the reported account is a person, not a Companion$/, "被举报的是真人账号,不是家机。"],
  [/^social twin not found$/, "没有找到这个家机的社区账号。"],
  [/^owner not found$/, "没有找到这个主人。"],
  [/^owner is deleted$/, "这个主人账号已经删除。"],
  [/^chat not found$/, "没有找到这个会话,可能主人已经删除了。"],
  [/^unknown feature$/, "没有这个功能开关。"],
  [/^fixed cost not found$/, "没有这个固定月费项目。"],
  [/^credits must be a non-zero whole number$/, "积分要填不为 0 的整数。"],
  [/^already the built-in wording$/, "这一段现在用的已经是内置文字。"],
  [/^feedback not found$/, "没有找到这条反馈,可能用户已经删除了账号。"],
  [/^feedback already in that state$/, "这条反馈已经是这个状态了。"],
  [/^invalid feedback$/, "回复不能是空的,最多 2000 个字。"],
  [/^permission denied/, "这个数据库账号没有管理权限(需要属于 companion_admin)。"],
];
// SQLSTATEs that mean "refused, nothing happened": what the console functions raise on purpose
// (22023, 55000, P0001), values the database will not take (23514 check, 22007/22008 dates,
// 22P02 ids) and missing privileges (42501). Anything else is a fault, not a refusal.
const REFUSED = new Set(["22023", "55000", "P0001", "23514", "22007", "22008", "22P02", "42501"]);

/** Turns a database error into words for the operator, or returns it unchanged when it is not a refusal. */
export function explain(error: unknown): unknown {
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (typeof code !== "string" || typeof message !== "string" || !REFUSED.has(code)) return error;
  for (const [pattern, text] of KNOWN) {
    if (pattern.test(message)) return new AdminRefusal(message.replace(pattern, text));
  }
  return new AdminRefusal(`没有执行:${message}`);
}

export class PgAdminDb implements AdminDb {
  readonly #pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.#pool = pool;
  }

  async call<T>(fn: AdminFunction, ...args: unknown[]): Promise<T> {
    const places = args.map((_, i) => `$${i + 1}`).join(", ");
    try {
      const result = await this.#pool.query<{ r: T }>(`select companion_admin.${fn}(${places}) as r`, args);
      return result.rows[0]!.r;
    } catch (error) {
      throw explain(error);
    }
  }
}
