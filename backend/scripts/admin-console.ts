/**
 * Starts the admin console on the admin server in the tailnet (Dockerfile.admin starts it behind
 * `tailscale serve`; docs/manual/ADMIN_CONSOLE.md):
 *     ADMIN_OPERATORS='{"<tailscale login>": "postgresql://<their operator login>:...", ...}'
 * Each person on the list uses their own operator login. It listens on 127.0.0.1 only.
 *
 * Every login must be a member of companion_admin.
 */
import pg from "pg";
import { PgAdminDb } from "../src/admin/db.ts";
import { createAdminServer } from "../src/admin/server.ts";
import { ChatCatalog } from "../src/chat/models.ts";

const port = Number(process.env.ADMIN_PORT ?? 8790);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("ADMIN_PORT must be a port from 1024 to 65535.");

const pools: pg.Pool[] = [];
/** Connects as one operator login and says who the database thinks it is. */
async function connect(connectionString: string) {
  const pool = new pg.Pool({ connectionString, max: 2, application_name: "companion-social-admin" });
  pools.push(pool);
  const { who } = (await pool.query<{ who: string }>("select session_user as who")).rows[0]!;
  return { db: new PgAdminDb(pool), who };
}
const chat = ChatCatalog.load(), catalog = chat.models;
// Each model company once, and the console's own copy of its key (only used to read the balance);
// right after it the company's backup key, when the catalog names one.
const vendors = [...new Map(catalog.map(m => [m.provider, chat.provider(m)] as const)).entries()].flatMap(([key, provider]) =>
  [{ keyEnv: provider.apiKeyEnv, backup: false }, ...(provider.backupApiKeyEnv === undefined ? [] : [{ keyEnv: provider.backupApiKeyEnv, backup: true }])]
    .map(({ keyEnv, backup }) => ({ key, keyEnv, backup, apiKey: process.env[keyEnv]?.trim() || undefined })));
// The 系统 page: a read-only Fly token (fly tokens create readonly) and the apps to show.
const fly = process.env.FLY_READ_TOKEN ? { token: process.env.FLY_READ_TOKEN,
  apps: (process.env.ADMIN_FLY_APPS ?? "companion-social-api,companion-social-admin").split(",").map(a => a.trim()).filter(Boolean) } : undefined;

if (!process.env.ADMIN_OPERATORS) throw new Error("Set ADMIN_OPERATORS: each Tailscale login with their own operator database URL.");
const listed = JSON.parse(process.env.ADMIN_OPERATORS) as Record<string, unknown>;
const operators = new Map<string, PgAdminDb>();
for (const [login, url] of Object.entries(listed)) {
  if (typeof url !== "string") throw new Error(`ADMIN_OPERATORS: the database URL for ${login} must be a string.`);
  const { db, who } = await connect(url);
  operators.set(login.toLowerCase(), db);
  console.log(`管理员:${login} → 数据库账号 ${who}`);
}
const hostname = process.env.ADMIN_HOSTNAME ?? "companion-admin";
const server = createAdminServer({ tailnet: { hostname, operators }, catalog, vendors, ...(fly ? { fly } : {}) });
server.listen(port, "127.0.0.1", () => console.log(`管理后台已启动,在 Tailscale 网络里打开 http://${hostname}/`));
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => { server.close(); void Promise.all(pools.map(pool => pool.end())).then(() => process.exit(0)); });
}
