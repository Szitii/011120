import type pg from "pg";
import type { SqlExecutor } from "./types.ts";

export class TransactionalOwnerExecutor implements SqlExecutor {
  readonly #pool: pg.Pool;
  readonly #subject: string;

  constructor(pool: pg.Pool, subject: string) {
    this.#pool = pool;
    this.#subject = subject;
  }

  async query<Row extends Record<string, unknown>>(
    text: string,
    values: readonly unknown[],
  ): Promise<{ readonly rows: Row[]; readonly rowCount: number | null }> {
    const client = await this.#pool.connect();
    let discardConnection = false;
    try {
      await client.query("begin");
      await client.query("set local role authenticated");
      await client.query(
        "select set_config('request.jwt.claim.sub',$1,true)",
        [this.#subject],
      );
      const result = await client.query<Row>(text, [...values]);
      await client.query("commit");
      return { rows: result.rows, rowCount: result.rowCount };
    } catch (error) {
      try {
        await client.query("rollback");
      } catch {
        discardConnection = true;
      }
      throw error;
    } finally {
      client.release(discardConnection);
    }
  }
}
