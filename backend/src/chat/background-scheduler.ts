/**
 * Background writing for Companions whose Owner asked for it: diary entries (autoWrite),
 * community posts (the agent settings' autoEnabled), and messages in the one-to-one chat that
 * answer nobody (writing first when the Owner was away, and reminders).
 *
 * Every round asks the database which Companions are due (public.diary_due, public.agent_auto_due
 * or public.chat_reach_due: opted in, interval passed, nothing running, and so on), then writes
 * them one by one as their Owner, through the same code the app's own request would use. The
 * database's per-Companion lock makes concurrent writers (another server, or the app at the same
 * moment) write once. Rounds never overlap on one server.
 */
import type { SqlExecutor } from "../persistence/postgres/types.ts";
import type { ChatPort } from "./port.ts";

export interface Due { companionId: string; subject: string }

export interface BackgroundSchedulerOptions {
  /** Runs as the API server itself (PgOwnerExecutor with no subject). */
  server: SqlExecutor;
  /** The Owner's chat port for one auth subject. */
  portFor: (subject: string) => ChatPort;
  /** The database function that lists who is due: (limit, platform) -> [{companionId, subject}]. */
  due: "diary_due" | "agent_auto_due" | "chat_reach_due";
  /** Writes one, as its Owner (ChatReplies.writeDiary, writePost or reachOut). */
  write: (companionId: string, port: ChatPort) => Promise<unknown>;
  /** For the log: "diary" or "community post". */
  what: string;
  /** false: the server has no platform model, so only Companions on the Owner's own key or agent. */
  platform: boolean;
  /** Companions per round. */
  batch?: number;
  log?: (message: string) => void;
}

export class BackgroundScheduler {
  readonly #options: BackgroundSchedulerOptions;
  #running = false;

  constructor(options: BackgroundSchedulerOptions) {
    this.#options = options;
  }

  /** One round; returns how many were attempted. Never throws. */
  async round(): Promise<number> {
    if (this.#running) return 0;
    this.#running = true;
    const { server, portFor, due, write, what, platform, batch = 10, log = console.error } = this.#options;
    let attempted = 0;
    try {
      const result = await server.query<{ payload: Due[] }>(`select public.${due}($1,$2) as payload`, [batch, platform]);
      for (const one of result.rows[0]?.payload ?? []) {
        attempted += 1;
        try {
          await write(one.companionId, portFor(one.subject));
        } catch (error) {
          log(`Background ${what} for ${one.companionId} failed: ${error instanceof Error ? error.message : "unknown error"}`);
        }
      }
    } catch (error) {
      log(`Background ${what} round failed: ${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      this.#running = false;
    }
    return attempted;
  }

  /** Runs a round every `everyMs`; returns a function that stops it. */
  start(everyMs: number): () => void {
    const timer = setInterval(() => { void this.round(); }, everyMs);
    timer.unref();
    return () => clearInterval(timer);
  }
}
