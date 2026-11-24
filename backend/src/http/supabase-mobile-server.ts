import { fileURLToPath } from "node:url";
import path from "node:path";
import type pg from "pg";
import { chatFromEnvironment } from "../chat/setup.ts";
import { createPgPool } from "../persistence/postgres/client.ts";
import { AgentKeyResolver } from "../agent/heartbeat.ts";
import { createMobileHttpServer } from "./mobile-server.ts";
import { SupabaseOwnerSessionResolver } from "./supabase-owner-session.ts";

export const createSupabaseMobileHttpServer = (input: {
  pool: pg.Pool;
  supabaseUrl: string;
  publishableKey: string;
  chat?: Parameters<typeof createMobileHttpServer>[2];
}) => createMobileHttpServer(new AgentKeyResolver(input.pool, new SupabaseOwnerSessionResolver(input)), "supabase-auth", input.chat);

async function main() {
  const {
    DATABASE_URL: connectionString,
    SUPABASE_URL: supabaseUrl,
    SUPABASE_PUBLISHABLE_KEY: publishableKey,
    MOBILE_API_HOST: host = "127.0.0.1",
    MOBILE_API_PORT: rawPort = "8787",
  } = process.env;
  if (!connectionString || !supabaseUrl || !publishableKey) {
    throw new Error("Set DATABASE_URL, SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY.");
  }
  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("MOBILE_API_PORT must be a valid TCP port.");
  }
  const pool = createPgPool(connectionString);
  const server = createSupabaseMobileHttpServer({ pool, supabaseUrl, publishableKey, chat: chatFromEnvironment("supabase-auth") });
  const shutdown = () => server.close(() => { void pool.end(); });
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  console.log(`Supabase-authenticated mobile API listening on ${host}:${port}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Mobile API could not start.");
    process.exitCode = 1;
  });
}
