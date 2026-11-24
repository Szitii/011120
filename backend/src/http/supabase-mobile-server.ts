import { fileURLToPath } from "node:url";
import path from "node:path";
import type pg from "pg";
import { chatFromEnvironment } from "../chat/setup.ts";
import { AgentKeyResolver } from "../agent/heartbeat.ts";
import { BackgroundScheduler } from "../chat/background-scheduler.ts";
import type { ChatPort } from "../chat/port.ts";
import { PostgresChatAdapter } from "../chat/postgres.ts";
import { createPgPool, PgOwnerExecutor } from "../persistence/postgres/client.ts";
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
    // How often background diaries are checked; 0 turns them off.
    DIARY_SCHEDULER_MINUTES: diaryMinutes = "5",
    // How often Companions that post on their own are checked; 0 turns that off.
    AUTO_POST_SCHEDULER_MINUTES: postMinutes = "5",
  } = process.env;
  if (!connectionString || !supabaseUrl || !publishableKey) {
    throw new Error("Set DATABASE_URL, SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY.");
  }
  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("MOBILE_API_PORT must be a valid TCP port.");
  }
  const pool = createPgPool(connectionString);
  const chat = chatFromEnvironment("supabase-auth");
  const server = createSupabaseMobileHttpServer({ pool, supabaseUrl, publishableKey, chat });
  // Diaries and community posts written in the background, each on its own timer.
  const background = (due: "diary_due" | "agent_auto_due", what: string, minutes: string,
    write: (companionId: string, port: ChatPort) => Promise<unknown>) => {
    const every = Number(minutes);
    if (chat.background === undefined || !Number.isFinite(every) || every <= 0) return () => undefined;
    return new BackgroundScheduler({ server: new PgOwnerExecutor(pool, null),
      portFor: subject => new PostgresChatAdapter(new PgOwnerExecutor(pool, subject)),
      due, what, write, platform: chat.background.platform,
    }).start(every * 60_000);
  };
  const stopDiaries = background("diary_due", "diary", diaryMinutes, (id, port) => chat.replies.writeDiary(id, port));
  const stopPosts = background("agent_auto_due", "community post", postMinutes, (id, port) => chat.replies.writePost(id, port));
  const shutdown = () => { stopDiaries(); stopPosts(); server.close(() => { void pool.end(); }); };
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
