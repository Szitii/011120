import pg from "pg";
import type { SqlExecutor, SqlResult } from "./types.ts";

export class PgPoolExecutor implements SqlExecutor {
  readonly #pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.#pool = pool;
  }

  async query<Row extends Record<string, unknown>>(text: string, values: readonly unknown[]): Promise<SqlResult<Row>> {
    const result = await this.#pool.query<Row>(text, [...values]);
    return { rows: result.rows };
  }
}

/**
 * Runs every statement as PostgreSQL role `companion_api` (everything `authenticated` has, plus the
 * RPCs that trust this server's own checks) with `request.jwt.claim.sub` bound to one Owner auth
 * subject, inside its own transaction. This is the only Owner-scoping path to the database.
 */
export class PgOwnerExecutor implements SqlExecutor {
  readonly #pool: pg.Pool;
  readonly #subject: string;

  constructor(pool: pg.Pool, subject: string) {
    this.#pool = pool;
    this.#subject = subject;
  }

  async query<Row extends Record<string, unknown>>(text: string, values: readonly unknown[]): Promise<SqlResult<Row>> {
    const client = await this.#pool.connect();
    // A connection whose rollback failed is in an unknown state: destroy it instead of reusing it.
    let broken = false;
    try {
      await client.query("begin");
      await client.query("set local role companion_api");
      await client.query("select set_config('request.jwt.claim.sub',$1,true)", [this.#subject]);
      const result = await client.query<Row>(text, [...values]);
      await client.query("commit");
      return { rows: result.rows };
    } catch (error) {
      await client.query("rollback").catch(() => { broken = true; });
      throw error;
    } finally {
      client.release(broken);
    }
  }
}

export function createPgPool(connectionString: string): pg.Pool {
  if (connectionString.trim() === "") throw new Error("PostgreSQL connection string is required.");
  // A full pool answers 503 after 5 s instead of making requests wait forever.
  const pool = new pg.Pool({ connectionString, max: 10, connectionTimeoutMillis: 5_000, application_name: "companion-social" });
  // An idle connection the database drops emits "error"; without a listener that kills the process.
  pool.on("error", (error) => console.error(`PostgreSQL idle connection error: ${error.message}`));
  return pool;
}
