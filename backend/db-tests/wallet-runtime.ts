import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createMobileDevHttpServer } from "../src/dev/mobile-http-server.ts";
import { createPgPool, PgOwnerExecutor } from "../src/persistence/postgres/index.ts";
import { PostgresChatAdapter } from "../src/chat/postgres.ts";
import type { ChatClaim } from "../src/chat/port.ts";
import type { Chat, Wallet } from "../../contracts/chat.ts";

// The platform daily spend cap and the Owner wallet (migration 0051), through the real ledger.
const connectionString = process.env.DATABASE_URL;
if (!connectionString || process.env.COMPANION_SOCIAL_DEV_DATABASE !== "1") throw Error("Disposable seeded development database required.");
const pool = createPgPool(connectionString);
const A = { owner: "00000000-0000-0000-0000-0000000001a1", subject: "00000000-0000-0000-0000-0000000000a1", companion: "00000000-0000-0000-0000-0000000002a1" };
const server = createMobileDevHttpServer({ pool, ownerId: A.owner, ownerSubject: A.subject, bearerToken: "wallet-0" });
const port = new PostgresChatAdapter(new PgOwnerExecutor(pool, A.subject));
const keyHash = () => createHash("sha256").update(randomUUID()).digest("hex");
let groups = 0;
const passed = (name: string) => { groups += 1; console.log(`Wallet integration ${groups}: ${name}`); };
type Enabled = Extract<Wallet, { enabled: true }>;

const policyBefore = (await pool.query("select * from companion_private.wallet_policy")).rows[0];
const capBefore = (await pool.query("select * from companion_private.platform_spend_cap")).rows[0];
try {
  const base = await new Promise<string>(resolve =>
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
  const wallet = async () => {
    const response = await fetch(`${base}/v0/wallet`, { headers: { Authorization: "Bearer wallet-0" } });
    assert.equal(response.status, 200);
    return await response.json() as Wallet;
  };
  const chatId = (await port.open([A.companion], null, keyHash()) as Chat).id;
  /** A fresh turn to book calls for: the Owner says something, the server claims the reply. */
  const turn = async (): Promise<ChatClaim> => {
    await port.send(chatId, "在吗", [], keyHash());
    return (await port.claim(chatId))!;
  };
  const finish = (t: ChatClaim) => port.finish(t.replyId, t.claimId, "ERROR", null);
  const book = (t: ChatClaim, costMinor: number, purpose: "REPLY" | "DECIDE" = "REPLY") => port.reserve({
    replyId: t.replyId, claimId: t.claimId, purpose, provider: "wallet-test", model: "m-wallet", pricingVersion: "test/1",
    inputTokens: 100, outputTokens: 100, costMinor, traceId: t.replyId,
  });
  const entries = async () => (await pool.query(
    "select kind, delta_free::int as free, delta_paid::int as paid from companion_private.wallet_entries where owner_id = $1 order by id", [A.owner])).rows;
  const setCredits = (free: number, paid: number) => pool.query(
    "update companion_private.wallets set free_credits = $2, paid_credits = $3 where owner_id = $1", [A.owner, free, paid]);

  // ---- off by default: nothing held, nothing created ----
  assert.deepEqual(await wallet(), { enabled: false });
  let t = await turn();
  const free = await book(t, 5);
  assert.equal(free.decision, "RESERVED");
  if (free.decision === "RESERVED") await port.settle(free.transactionId, 100, 100, 3, true);
  await finish(t);
  assert.equal((await pool.query("select count(*)::int n from companion_private.wallets where owner_id = $1", [A.owner])).rows[0]!.n, 0);
  passed("while the wallet is off, calls are booked as before and no wallet exists");

  // ---- on: the welcome gift once, a hold, the real cost charged ----
  await pool.query("update companion_private.wallet_policy set enabled = true, welcome_credits = 1000, credits_per_cent = 10, background_floor = 200");
  const opened = await wallet() as Enabled;
  assert.deepEqual([opened.enabled, opened.state, opened.available, opened.freeCredits, opened.paidCredits, opened.reserved, opened.creditsPerCent],
    [true, "ACTIVE", 1000, 1000, 0, 0, 10]);
  assert.equal((await wallet() as Enabled).available, 1000, "the gift is granted once");
  t = await turn();
  const held = await book(t, 5);
  assert.equal(held.decision, "RESERVED");
  const during = await wallet() as Enabled;
  assert.deepEqual([during.available, during.reserved], [950, 50]);
  if (held.decision === "RESERVED") {
    await port.settle(held.transactionId, 100, 100, 2, true);
    await port.settle(held.transactionId, 100, 100, 2, true); // already settled: nothing more
  }
  const after = await wallet() as Enabled;
  assert.deepEqual([after.available, after.reserved], [980, 0], "2 cents charged at 10 credits per cent");
  await finish(t);
  passed("welcome gift once; a call holds its reservation and is charged its real cost");

  // ---- failed or abandoned calls cost nothing ----
  t = await turn();
  const failing = await book(t, 5);
  if (failing.decision === "RESERVED") await port.settle(failing.transactionId, 100, 100, 5, false);
  const abandoned = await book(t, 4, "DECIDE");
  assert.equal(abandoned.decision, "RESERVED");
  assert.equal((await wallet() as Enabled).available, 940);
  await finish(t); // closes the unsettled call as abandoned
  assert.equal((await wallet() as Enabled).available, 980, "a failed and an abandoned call cost nothing");
  assert.deepEqual((await entries()).map(e => e.kind), ["GRANT", "HOLD", "RELEASE", "HOLD", "RELEASE", "HOLD", "RELEASE"]);
  passed("failed and abandoned calls release every credit");

  // ---- too few credits, frozen, paid credits last, background floor ----
  await setCredits(30, 0);
  t = await turn();
  assert.deepEqual(await book(t, 4), { decision: "QUOTA", reason: "WALLET" });
  await setCredits(30, 20);
  const mixed = await book(t, 4);
  assert.equal(mixed.decision, "RESERVED");
  const mixedWallet = await wallet() as Enabled;
  assert.deepEqual([mixedWallet.freeCredits, mixedWallet.paidCredits], [0, 10], "free credits are spent first");
  if (mixed.decision === "RESERVED") await port.settle(mixed.transactionId, 100, 100, 1, true);
  const refunded = await wallet() as Enabled;
  assert.deepEqual([refunded.freeCredits, refunded.paidCredits], [20, 20], "the unused part goes back to paid credits first");
  await finish(t);
  const check = async (cost: number, background: boolean) =>
    (await pool.query("select companion_private.wallet_check($1, $2, $3) as r", [A.owner, cost, background])).rows[0]!.r;
  await setCredits(250, 0);
  assert.deepEqual([await check(5, false), await check(5, true), await check(6, true)], [null, null, "WALLET"],
    "background work leaves 200 credits for chat");
  await pool.query("update companion_private.wallets set state = 'FROZEN' where owner_id = $1", [A.owner]);
  t = await turn();
  assert.deepEqual(await book(t, 1), { decision: "QUOTA", reason: "FROZEN" });
  await pool.query("update companion_private.wallets set state = 'ACTIVE' where owner_id = $1", [A.owner]);
  await finish(t);
  passed("too few credits and frozen wallets refuse; free credits go first; background keeps a floor");

  // ---- the platform cap ----
  const spent = Number((await pool.query("select companion_private.platform_spent_today() as n")).rows[0]!.n);
  assert.ok(spent > 0, "today's calls count toward the cap");
  await pool.query("update companion_private.platform_spend_cap set enabled = true, daily_cost_minor = $1", [spent + 2]);
  t = await turn();
  assert.deepEqual(await book(t, 3), { decision: "DISABLED", reason: "PLATFORM_LIMIT" });
  const fits = await book(t, 2);
  assert.equal(fits.decision, "RESERVED", "exactly up to the cap is allowed");
  assert.deepEqual(await book(t, 1, "DECIDE"), { decision: "DISABLED", reason: "PLATFORM_LIMIT" }, "a running call counts");
  await pool.query("update companion_private.platform_spend_cap set enabled = false");
  assert.equal((await book(t, 1, "DECIDE")).decision, "RESERVED", "no cap when it is off");
  await finish(t);
  passed("the platform cap counts reserved and settled cost over every Owner, and can be turned off");

  // ---- the wallet on: the free daily budget no longer stops the Companion ----
  const today = async () => (await pool.query(`select max_model_calls::int as calls, (reserved_calls + settled_calls)::int as used
    from public.compute_budgets where owner_id = $1 and companion_id = $2 and period_start <= now() and now() < period_end`, [A.owner, A.companion])).rows[0]!;
  const quotaBefore = (await pool.query("select daily_calls from companion_private.chat_quota")).rows[0]!.daily_calls;
  assert.equal((await today()).calls, 1000000, "today's budget, made under the free limits while the wallet was off, was raised");
  await setCredits(1000, 0);
  await pool.query("update companion_private.chat_quota set daily_calls = 1");
  await pool.query("update public.compute_budgets set max_model_calls = 1 where owner_id = $1 and companion_id = $2 and period_start <= now() and now() < period_end", [A.owner, A.companion]);
  t = await turn();
  const past = await book(t, 1);
  assert.equal(past.decision, "RESERVED", "past the free calls for today, the wallet pays");
  if (past.decision === "RESERVED") await port.settle(past.transactionId, 100, 100, 1, true);
  await finish(t);
  assert.ok((await today()).used > 1);
  await pool.query("update companion_private.wallet_policy set enabled = false");
  await pool.query("update public.compute_budgets set max_model_calls = 1 where owner_id = $1 and companion_id = $2 and period_start <= now() and now() < period_end", [A.owner, A.companion]);
  t = await turn();
  assert.deepEqual(await book(t, 1), { decision: "QUOTA", reason: "BUDGET_EXHAUSTED" }, "with the wallet off, the free daily budget stops it again");
  await finish(t);
  await pool.query("update companion_private.chat_quota set daily_calls = $1", [quotaBefore]);
  await pool.query("update public.compute_budgets set max_model_calls = 1000000 where owner_id = $1 and companion_id = $2 and period_start <= now() and now() < period_end", [A.owner, A.companion]);
  await pool.query("update companion_private.wallet_policy set enabled = true");
  passed("while the wallet is on, the free daily budget does not stop a Companion; off, it does again");

  // ---- operators: cap, policy and credits, each logged ----
  const logged = async (action: string) => (await pool.query(
    "select detail from companion_private.admin_log where action = $1 order by id desc limit 1", [action])).rows[0]?.detail;
  await pool.query("select companion_admin.spend_cap_set(true, 1500, 'launch cap')");
  assert.deepEqual(await logged("SPEND_CAP"), { enabled: true, dailyCostMinor: 1500, before: { enabled: false, dailyCostMinor: spent + 2 } });
  await pool.query("select companion_admin.wallet_policy_set(true, 500, 20, 100, 'new prices')");
  const models = (await pool.query("select companion_admin.models() as m")).rows[0]!.m;
  assert.deepEqual([models.cap.dailyCostMinor, models.cap.enabled, models.wallet.creditsPerCent, models.wallet.welcomeCredits],
    [1500, true, 20, 500]);
  assert.equal((await wallet() as Enabled).priceVersion, "credits/20-per-cent");
  await setCredits(100, 0);
  assert.deepEqual((await pool.query("select companion_admin.wallet_adjust($1, 50, 'beta tester') as r", [A.owner])).rows[0]!.r,
    { freeCredits: 150, paidCredits: 0 });
  assert.deepEqual((await pool.query("select companion_admin.wallet_adjust($1, -1000, 'take back') as r", [A.owner])).rows[0]!.r,
    { freeCredits: 0, paidCredits: 0 }, "never below zero");
  assert.deepEqual(await logged("WALLET_ADJUST"), { credits: -150, before: 150 });
  await assert.rejects(pool.query("select companion_admin.wallet_adjust($1, 0, 'nothing')", [A.owner]), { code: "22023" });
  await assert.rejects(pool.query("select companion_admin.wallet_adjust($1, 5, '')", [A.owner]), { code: "22023" });
  await assert.rejects(pool.query("select companion_admin.wallet_adjust($1, 5, 'nobody')", [randomUUID()]), { code: "P0001" });
  await assert.rejects(pool.query("update companion_private.wallet_entries set delta_free = 0 where owner_id = $1", [A.owner]));
  passed("operators set the cap, the policy and an Owner's credits, each logged; the wallet history cannot be edited");
} finally {
  await pool.query(`update companion_private.wallet_policy set enabled = $1, welcome_credits = $2, credits_per_cent = $3, background_floor = $4`,
    [policyBefore.enabled, policyBefore.welcome_credits, policyBefore.credits_per_cent, policyBefore.background_floor]).catch(() => undefined);
  await pool.query("update companion_private.platform_spend_cap set enabled = $1, daily_cost_minor = $2",
    [capBefore.enabled, capBefore.daily_cost_minor]).catch(() => undefined);
  await new Promise(resolve => server.close(resolve));
  await pool.end();
}
console.log(`Wallet integration passed (${groups} groups).`);
