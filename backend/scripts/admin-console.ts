/**
 * Starts the admin console on this machine.
 *
 *   ADMIN_DATABASE_URL=postgresql://<your operator login>:<password>@<host>/<database> npm run admin
 *
 * The login must be a member of companion_admin (see docs/manual/ADMIN_CONSOLE.md). The console
 * listens on 127.0.0.1 only and prints a link that carries the access token; a new one every start.
 */
import { randomBytes } from "node:crypto";
import pg from "pg";
import { PgAdminDb } from "../src/admin/db.ts";
import { createAdminServer } from "../src/admin/server.ts";
import { ChatCatalog } from "../src/chat/models.ts";

const connectionString = process.env.ADMIN_DATABASE_URL;
if (!connectionString) throw new Error("Set ADMIN_DATABASE_URL to the database, as your own operator login (a member of companion_admin).");
const port = Number(process.env.ADMIN_PORT ?? 8790);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("ADMIN_PORT must be a port from 1024 to 65535.");

const pool = new pg.Pool({ connectionString, max: 2, application_name: "companion-social-admin" });
const { who } = (await pool.query<{ who: string }>("select session_user as who")).rows[0]!;
const token = randomBytes(32).toString("hex");
const server = createAdminServer({ db: new PgAdminDb(pool), token, catalog: ChatCatalog.load().models });
server.listen(port, "127.0.0.1", () => {
  console.log(`管理后台已启动。数据库账号:${who}(日志里的“操作人”就是它)`);
  console.log(`在这台电脑的浏览器里打开:http://127.0.0.1:${port}/?token=${token}`);
  console.log("按 Ctrl+C 关闭。每次启动链接都会换。");
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => { server.close(); void pool.end().then(() => process.exit(0)); });
}
