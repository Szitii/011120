/**
 * Writes diary entries in the background for Companions whose Owner turned on autoWrite.
 *
 * Every round asks the database which diaries are due (public.diary_due: opted in, interval
 * passed, something new happened, no attempt running, the last failure over an hour old), then
 * writes them one by one as their Owner, through the same ChatReplies.writeDiary as the app's
 * POST /diary. The database's per-Companion writing lock makes concurrent writers (another server,
 * or the app at the same moment) write one entry. Rounds never overlap on one server.
 */
import type { SqlExecutor } from "../persistence/postgres/types.ts";
import type { ChatPort } from "./port.ts";
import type { ChatReplies } from "./replies.ts";

export interface DiaryDue { companionId: string; subject: string }

export interface DiarySchedulerOptions {
  /** Runs as the API server itself (PgOwnerExecutor with no subject). */
  server: SqlExecutor;
  /** The Owner's chat port for one auth subject. */
  portFor: (subject: string) => ChatPort;
  replies: Pick<ChatReplies, "writeDiary">;
  /** false: the server has no platform model, so only Companions on the Owner's own key or agent. */
  platform: boolean;
  /** Diaries per round. */
  batch?: number;
  log?: (message: string) => void;
}

export class DiaryScheduler {
  readonly #options: DiarySchedulerOptions;
  #running = false;

  constructor(options: DiarySchedulerOptions) {
    this.#options = options;
  }

  /** One round; returns how many diaries were attempted. Never throws. */
  async round(): Promise<number> {
    if (this.#running) return 0;
    this.#running = true;
    const { server, portFor, replies, platform, batch = 10, log = console.error } = this.#options;
    let attempted = 0;
    try {
      const result = await server.query<{ payload: DiaryDue[] }>("select public.diary_due($1,$2) as payload", [batch, platform]);
      for (const due of result.rows[0]?.payload ?? []) {
        attempted += 1;
        try {
          await replies.writeDiary(due.companionId, portFor(due.subject));
        } catch (error) {
          log(`Background diary for ${due.companionId} failed: ${error instanceof Error ? error.message : "unknown error"}`);
        }
      }
    } catch (error) {
      log(`Background diary round failed: ${error instanceof Error ? error.message : "unknown error"}`);
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
