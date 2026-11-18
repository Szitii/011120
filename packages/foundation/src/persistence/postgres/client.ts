import pg from "pg";
import type { SqlExecutor, SqlResult } from "./types.ts";

export class PgPoolExecutor implements SqlExecutor {
  readonly #pool:pg.Pool; constructor(pool: pg.Pool) {this.#pool=pool;}
  async query<Row extends Record<string, unknown>>(text: string, values: readonly unknown[]): Promise<SqlResult<Row>> {
    const result = await this.#pool.query<Row>(text, [...values]);
    return { rows: result.rows, rowCount: result.rowCount };
  }
}

export function createPgPool(connectionString: string): pg.Pool {
  if (connectionString.trim() === "") throw new Error("PostgreSQL connection string is required.");
  return new pg.Pool({ connectionString, max: 10, application_name: "companion-social" });
}
