/**
 * Platform administrator: switch platform models off or on, and set the free daily quota.
 * Connects with DATABASE_URL as a database administrator (the functions have no grants, so the
 * API server and app users cannot call them). Every switch change is logged.
 *
 *   npm run chat:admin -- status
 *   npm run chat:admin -- off all "reason"              every platform model
 *   npm run chat:admin -- off provider openai "reason"  one provider
 *   npm run chat:admin -- off model anthropic/claude-opus-5-5 "reason"
 *   npm run chat:admin -- on  all|provider X|model X "reason"
 *   npm run chat:admin -- quota <calls per day> <US cents per day>   (each Companion, from new budgets on)
 */
import pg from "pg";
import { ChatCatalog } from "../src/chat/models.ts";

const [command, ...rest] = process.argv.slice(2);
const usage = "usage: status | off|on all [note] | off|on provider <id> [note] | off|on model <provider/model> [note] | quota <calls> <cents>";
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("Set DATABASE_URL to the database, as an administrator.");
const client = new pg.Client({ connectionString });
await client.connect();
try {
  if (command === "on" || command === "off") {
    const [scope, ...more] = rest;
    const key = scope === "all" ? "*" : more.shift();
    if (!["all", "provider", "model"].includes(scope ?? "") || !key) throw new Error(usage);
    // Keys must name what the catalog uses, or the switch would silently cover nothing.
    const catalog = ChatCatalog.load();
    const covered = catalog.models.filter(m => scope === "all" || (scope === "provider" ? m.provider === key : `${m.provider}/${m.model}` === key));
    if (covered.length === 0) {
      throw new Error(`${key} matches no catalog model. Providers: ${[...new Set(catalog.models.map(m => m.provider))].join(", ")}; ` +
        `models: ${catalog.models.map(m => `${m.provider}/${m.model}`).join(", ")}`);
    }
    console.log(`Switching ${command}: ${covered.map(m => m.id).join(", ")}`);
    await client.query("select companion_private.admin_set_model_switch($1, $2, $3, $4)",
      [scope!.toUpperCase(), key, command === "on", more.join(" ") || null]);
  } else if (command === "quota") {
    const [calls, cents] = rest.map(Number);
    if (!Number.isInteger(calls) || !Number.isInteger(cents)) throw new Error(usage);
    await client.query("select companion_private.admin_set_chat_quota($1, $2)", [calls, cents]);
  } else if (command !== "status") {
    throw new Error(usage);
  }
  const switches = await client.query("select scope, key, enabled, note, updated_at from companion_private.model_switches order by scope, key");
  const quota = await client.query("select daily_calls, daily_cost_minor, currency from companion_private.chat_quota");
  console.log("Switches (anything not listed is on):");
  console.table(switches.rows);
  console.log("Free daily quota per Companion:", quota.rows[0]);
} finally {
  await client.end();
}
