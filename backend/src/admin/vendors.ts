/**
 * The model companies the platform pays, as the console shows them: whether the API server has
 * each one's key, and how much money is left with it, read from the company itself.
 *
 * The console never sets or changes a key: it holds a read-only Fly token. Someone who gets into
 * the console cannot swap the keys the API server uses. What it reads:
 *  * which secrets the API server's Fly app has: names and when they changed, never their values;
 *  * each company's balance, with the console's own copy of that company's key (a secret of the
 *    console's Fly app, under the same name as on the API server). A company without a balance
 *    API is shown with a link to its console instead.
 */
import type { FlyAccess } from "./fly.ts";

/** One company the catalog uses, the environment variable its key lives in, and the console's copy of it. */
export interface VendorKey { readonly key: string; readonly keyEnv: string; readonly apiKey: string | undefined }

export interface Money { currency: string; total: number; granted: number; toppedUp: number }
export type Balance = { ok: true; enough: boolean; money: Money[] } | { ok: false; why: string };
export interface VendorStatus {
  key: string; keyEnv: string;
  /** On the API server: when its key last changed; null when it has none; a reason when that cannot be read. */
  serverKey: { at: string } | null | { why: string };
  /** null: this company has no balance API (or the console has no copy of its key; `why` says which). */
  balance: Balance | null;
  balanceNote: string | null;
}

type Raw = Record<string, unknown>;
const object = (v: unknown): Raw => v !== null && typeof v === "object" ? v as Raw : {};
const amount = (v: unknown) => typeof v === "string" || typeof v === "number" ? Number(v) : NaN;

/** How each company tells what is left. One entry per company that has a balance API. */
const BALANCE: Readonly<Record<string, (apiKey: string, get: typeof fetch) => Promise<Balance>>> = {
  // api-docs.deepseek.com/api/get-user-balance: amounts are strings, per currency (CNY or USD).
  deepseek: async (apiKey, get) => {
    const response = await get("https://api.deepseek.com/user/balance",
      { headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" }, signal: AbortSignal.timeout(5000) });
    if (!response.ok) return { ok: false, why: `DeepSeek 回答 ${response.status}` };
    const body = object(await response.json());
    const money = (Array.isArray(body.balance_infos) ? body.balance_infos : []).map(object).map(b => ({
      currency: typeof b.currency === "string" ? b.currency : "?", total: amount(b.total_balance), granted: amount(b.granted_balance),
      toppedUp: amount(b.topped_up_balance) })).filter(m => Number.isFinite(m.total));
    return { ok: true, enough: body.is_available === true, money };
  },
};

/** The secrets of one Fly app: name → when it last changed. */
async function secretTimes(fly: FlyAccess, app: string): Promise<Map<string, string> | { why: string }> {
  try {
    const response = await (fly.fetch ?? fetch)(`https://api.machines.dev/v1/apps/${encodeURIComponent(app)}/secrets`,
      { headers: { Authorization: `Bearer ${fly.token}` }, signal: AbortSignal.timeout(5000) });
    if (!response.ok) return { why: `Fly 回答 ${response.status}` };
    const list = object(await response.json()).secrets;
    return new Map((Array.isArray(list) ? list : []).map(object).filter(s => typeof s.name === "string")
      .map(s => [s.name as string, typeof s.updated_at === "string" ? s.updated_at : ""]));
  } catch (error) {
    return { why: error instanceof Error ? error.message : String(error) };
  }
}

/** Every company's key and balance, read now. `app` is the API server's Fly app. */
export async function vendorStatus(vendors: readonly VendorKey[], fly: FlyAccess | null, app: string,
  get: typeof fetch = fetch): Promise<VendorStatus[]> {
  const secrets = fly === null ? { why: "后台没有 Fly 只读令牌" } : await secretTimes(fly, app);
  return Promise.all(vendors.map(async v => {
    const check = BALANCE[v.key];
    const serverKey = secrets instanceof Map ? (secrets.has(v.keyEnv) ? { at: secrets.get(v.keyEnv)! } : null) : secrets;
    if (check === undefined) return { key: v.key, keyEnv: v.keyEnv, serverKey, balance: null, balanceNote: "这家没有查余额的接口,去它的控制台看。" };
    if (v.apiKey === undefined) return { key: v.key, keyEnv: v.keyEnv, serverKey, balance: null, balanceNote: `后台没有这家的 Key(${v.keyEnv}),查不了余额。` };
    const balance = await check(v.apiKey, get).catch((error: unknown) =>
      ({ ok: false, why: error instanceof Error ? error.message : String(error) }) satisfies Balance);
    return { key: v.key, keyEnv: v.keyEnv, serverKey, balance, balanceNote: null };
  }));
}
