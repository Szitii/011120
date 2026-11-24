/**
 * Starts the admin console. Two ways (docs/manual/ADMIN_CONSOLE.md):
 *
 *  * On your own machine:
 *      ADMIN_DATABASE_URL=postgresql://<your operator login>:<password>@<host>/<database> npm run admin
 *    It listens on 127.0.0.1 and prints a link that carries the access token; a new one every start.
 *
 *  * On the admin server in the tailnet (Dockerfile.admin starts it behind `tailscale serve`):
 *      ADMIN_OPERATORS='{"<tailscale login>": "postgresql://<their operator login>:...", ...}'
 *    Each person on the list uses their own operator login. It listens on 127.0.0.1 only.
 *
 * Every login must be a member of companion_admin.
 */
import { randomBytes } from "node:crypto";
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
const catalog = ChatCatalog.load().models;

let server;
if (process.env.ADMIN_OPERATORS) {
  const listed = JSON.parse(process.env.ADMIN_OPERATORS) as Record<string, unknown>;
  const operators = new Map<string, PgAdminDb>();
  for (const [login, url] of Object.entries(listed)) {
    if (typeof url !== "string") throw new Error(`ADMIN_OPERATORS: the database URL for ${login} must be a string.`);
    const { db, who } = await connect(url);
    operators.set(login.toLowerCase(), db);
    console.log(`管理员:${login} → 数据库账号 ${who}`);
  }
  const hostname = process.env.ADMIN_HOSTNAME ?? "companion-admin";
  server = createAdminServer({ tailnet: { hostname, operators }, catalog });
  server.listen(port, "127.0.0.1", () => console.log(`管理后台已启动,在 Tailscale 网络里打开 http://${hostname}/`));
} else {
  const connectionString = process.env.ADMIN_DATABASE_URL;
  if (!connectionString) throw new Error("Set ADMIN_DATABASE_URL to the database, as your own operator login (a member of companion_admin).");
  const { db, who } = await connect(connectionString);
  const token = randomBytes(32).toString("hex");
  server = createAdminServer({ db, token, catalog });
  server.listen(port, "127.0.0.1", () => {
    console.log(`管理后台已启动。数据库账号:${who}(日志里的“操作人”就是它)`);
    console.log(`在这台电脑的浏览器里打开:http://127.0.0.1:${port}/?token=${token}`);
    console.log("按 Ctrl+C 关闭。每次启动链接都会换。");
  });
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => { server.close(); void Promise.all(pools.map(pool => pool.end())).then(() => process.exit(0)); });
}
