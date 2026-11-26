/**
 * The cost page (migration 0058), through the real database: the API books voice usage as the
 * Owner it served, an operator reads one month and changes the fixed bills and the voice prices.
 */
import assert from "node:assert/strict";
import pg from "pg";
import { createPgPool, PgOwnerExecutor } from "../src/persistence/postgres/index.ts";
import { PostgresChatAdapter } from "../src/chat/postgres.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString || process.env.COMPANION_SOCIAL_DEV_DATABASE !== "1") throw Error("Disposable seeded development database required.");
const pool = createPgPool(connectionString);
const A = { owner: "00000000-0000-0000-0000-0000000001a1", subject: "00000000-0000-0000-0000-0000000000a1" };
const port = new PostgresChatAdapter(new PgOwnerExecutor(pool, A.subject));
const LOGIN = "admin_test_costs", PASSWORD = "admin-test-only";
let groups = 0;
const passed = (name: string) => { groups += 1; console.log(`Costs integration ${groups}: ${name}`); };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

await pool.query(`do $$ begin create role ${LOGIN} login password '${PASSWORD}' in role companion_admin;
  exception when duplicate_object then null; end $$`);
const url = new URL(connectionString);
url.username = LOGIN; url.password = PASSWORD;
const operator = new pg.Client({ connectionString: url.toString() });
await operator.connect();
const admin = async (fn: string, ...args: unknown[]): Promise<Json> =>
  (await operator.query(`select companion_admin.${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as r`, args)).rows[0]!.r;
const pricesBefore = (await pool.query("select * from companion_private.voice_prices")).rows[0];
const month = new Date().toISOString().slice(0, 7);

try {
  // ---- the API books what each speech call used, as the Owner it served ----
  const before = (await pool.query("select count(*)::int n from companion_private.voice_usage")).rows[0]!.n as number;
  await port.voiceUsed("SPEAK", 120_000);
  await port.voiceUsed("HEAR", 1_800_000);
  await port.voiceUsed("HEAR", -5);
  const rows = (await pool.query("select owner_id, kind, amount from companion_private.voice_usage order by id desc limit 3")).rows;
  assert.deepEqual(rows.reverse(), [{ owner_id: A.owner, kind: "SPEAK", amount: 120000 }, { owner_id: A.owner, kind: "HEAR", amount: 1800000 },
    { owner_id: A.owner, kind: "HEAR", amount: 0 }]);
  assert.equal((await pool.query("select count(*)::int n from companion_private.voice_usage")).rows[0]!.n, before + 3);
  await assert.rejects(pool.query("select public.voice_usage_add('SPEAK', 1)"), "nobody but the API's Owner session books");
  passed("the API books speech by characters and recognition by length, for its Owner");

  // ---- the month: per day, totals, over the plan, fixed bills ----
  await operator.query("select 1"); // the login works
  await assert.rejects(operator.query("select * from companion_private.voice_usage"), "the operator reads through the functions only");
  const costs = await admin("costs", `${month}-15`);
  assert.deepEqual([costs.month, costs.from], [month, `${month}-01`]);
  const today = costs.days.find((d: Json) => d.day === new Date().toISOString().slice(0, 10));
  assert.ok(today, "today is listed");
  assert.ok(today.speakPoints >= 120000 && today.hearSeconds >= 1800 && today.hears >= 2);
  assert.ok(Number(today.hearCents) >= 19, "half an hour of recognition at 38 cents an hour");
  assert.ok(Number(costs.totals.speakOverCents) >= 200, "20,000 points over a 100,000 plan at 100 USD a million");
  assert.equal(costs.prices.planPoints, 100000);
  assert.deepEqual(costs.fixed.map((f: Json) => [f.item, Number(f.cents)]), [["MiniMax 语音包月(Starter)", 500]]);
  assert.equal(Number(costs.totals.fixedCents), 500);
  assert.ok(Array.isArray(costs.models.byDay), "the AI model spend comes along");
  const empty = await admin("costs", "2001-02-03");
  assert.deepEqual([empty.month, empty.to, empty.days, Number(empty.totals.modelCents)], ["2001-02", "2001-02-28", [], 0]);
  passed("one month: each day, the totals, what went over the plan and the fixed bills");

  // ---- fixed bills and prices change with a reason, into the log ----
  await admin("fixed_cost_set", "Fly 服务器", 1250, "两个应用", "账单");
  await admin("fixed_cost_set", "Fly 服务器", 1300, "", "涨价");
  let fixed = (await admin("costs", `${month}-01`)).fixed;
  assert.deepEqual(fixed.map((f: Json) => [f.item, Number(f.cents), f.note]), [["Fly 服务器", 1300, null], ["MiniMax 语音包月(Starter)", 500, null]]);
  await admin("fixed_cost_set", "Fly 服务器", null, "", "不用了");
  fixed = (await admin("costs", `${month}-01`)).fixed;
  assert.equal(fixed.length, 1);
  await assert.rejects(admin("fixed_cost_set", "Nope", null, "", "x"), /fixed cost not found/);
  await assert.rejects(admin("fixed_cost_set", "  ", 100, "", "x"), (e: { code?: string }) => e.code === "23514");
  await assert.rejects(admin("fixed_cost_set", "Fly", 100, "", " "), /reason/);
  await admin("voice_prices_set", 300000, 6000, 38, "换 Standard");
  assert.deepEqual((await admin("costs", `${month}-01`)).prices.planPoints, 300000);
  await assert.rejects(admin("voice_prices_set", -1, 6000, 38, "x"), (e: { code?: string }) => e.code === "23514");
  const log = (await pool.query(`select operator, action, target_id, reason, detail from companion_private.admin_log
    where action in ('FIXED_COST', 'VOICE_PRICES') and operator = $1 order by id`, [LOGIN])).rows;
  assert.deepEqual(log.map(l => [l.action, l.target_id, l.reason]), [["FIXED_COST", "Fly 服务器", "账单"], ["FIXED_COST", "Fly 服务器", "涨价"],
    ["FIXED_COST", "Fly 服务器", "不用了"], ["VOICE_PRICES", "prices", "换 Standard"]]);
  assert.equal(log[1]!.detail.before, 1250);
  assert.equal(log[3]!.detail.before.planPoints, 100000);
  passed("fixed bills and voice prices change only with a reason, and the log keeps what they were");
} finally {
  await pool.query("delete from companion_private.voice_usage where owner_id = $1", [A.owner]).catch(() => undefined);
  await pool.query("delete from companion_private.fixed_costs where item <> 'MiniMax 语音包月(Starter)'").catch(() => undefined);
  await pool.query("update companion_private.voice_prices set plan_points = $1, speak_cents_per_million = $2, hear_cents_per_hour = $3",
    [pricesBefore.plan_points, pricesBefore.speak_cents_per_million, pricesBefore.hear_cents_per_hour]).catch(() => undefined);
  await operator.end().catch(() => undefined);
  await pool.query(`drop owned by ${LOGIN}`).catch(() => undefined);
  await pool.query(`drop role if exists ${LOGIN}`).catch(() => undefined);
  await pool.end();
}
console.log(`Costs integration: ${groups} groups passed.`);
