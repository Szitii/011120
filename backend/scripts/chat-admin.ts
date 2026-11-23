/**
 * Platform administrator: switch platform models off or on, and set the free daily quota.
 * Connects with DATABASE_URL as an operator: a database login that is a member of companion_admin
 * (or the database administrator). App users and the API server cannot call these functions.
 * Every change is written to the admin log with the reason and the login that made it.
 *
 *   npm run chat:admin -- status
 *   npm run chat:admin -- off all "reason"              every platform model
 *   npm run chat:admin -- off provider openai "reason"  one provider
 *   npm run chat:admin -- off model anthropic/claude-opus-5-5 "reason"
 *   npm run chat:admin -- on  all|provider X|model X "reason"
 *   npm run chat:admin -- quota <calls per day> <US cents per day> "reason"   (each Companion, from new budgets on)
 */
import pg from "pg";
import { ChatCatalog } from "../src/chat/models.ts";

const [command, ...rest] = process.argv.slice(2);
const usage = "usage: status | off|on all [reason] | off|on provider <id> [reason] | off|on model <provider/model> [reason] | quota <calls> <cents> [reason]";
// The log requires a reason; a switch flipped in a hurry still goes through, and says so.
const reason = (words: string[]) => words.join(" ").trim() || "No reason given (command line)";
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
    await client.query("select companion_admin.model_switch_set($1, $2, $3, $4)",
      [scope!.toUpperCase(), key, command === "on", reason(more)]);
  } else if (command === "quota") {
    const [calls, cents] = rest.slice(0, 2).map(Number);
    if (!Number.isInteger(calls) || !Number.isInteger(cents)) throw new Error(usage);
    await client.query("select companion_admin.chat_quota_set($1, $2, $3)", [calls, cents, reason(rest.slice(2))]);
  } else if (command !== "status") {
    throw new Error(usage);
  }
  const now = (await client.query<{ r: { switches: unknown[]; quota: unknown } }>("select companion_admin.models() as r")).rows[0]!.r;
  console.log("Switches (anything not listed is on):");
  console.table(now.switches);
  console.log("Free daily quota per Companion:", now.quota);
} finally {
  await client.end();
}
