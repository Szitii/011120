export interface SqlResult<Row extends Record<string, unknown>> { readonly rows: readonly Row[]; }
export interface SqlExecutor {
  query<Row extends Record<string, unknown>>(text: string, values: readonly unknown[]): Promise<SqlResult<Row>>;
}

export type PersistenceErrorCode =
  "NOT_FOUND" | "INVALID_INPUT" | "CONFLICT" | "FORBIDDEN" | "INVALID_STATE" | "DATABASE_UNAVAILABLE" | "DATABASE_ERROR";

export class PostgresPersistenceError extends Error {
  readonly code: PersistenceErrorCode;
  readonly sqlState?: string;

  constructor(code: PersistenceErrorCode, message: string, sqlState?: string) {
    super(message);
    this.name = "PostgresPersistenceError";
    this.code = code;
    if (sqlState !== undefined) this.sqlState = sqlState;
  }
}

// SQLSTATE -> error code. Invalid values (bad cast, range check, missing field) are all INVALID_INPUT.
const SQLSTATES: Readonly<Record<string, PersistenceErrorCode>> = {
  P0001: "NOT_FOUND", "23505": "CONFLICT", "42501": "FORBIDDEN", "55000": "INVALID_STATE",
  "22023": "INVALID_INPUT", "22P02": "INVALID_INPUT", "22007": "INVALID_INPUT", "22008": "INVALID_INPUT",
  "23502": "INVALID_INPUT", "23514": "INVALID_INPUT",
};

/**
 * The one translation from a pg error to PostgresPersistenceError. An error without a SQLSTATE
 * (connection refused, pool timeout, connection dropped) and classes 08/53/57 (connection,
 * resources, shutdown) mean the database is unavailable, so the client may retry.
 */
export function persistenceError(error: unknown): PostgresPersistenceError {
  if (error instanceof PostgresPersistenceError) return error;
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
  const state = typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : undefined;
  const mapped = state === undefined || /^(?:08|53|57)/.test(state)
    ? "DATABASE_UNAVAILABLE"
    : SQLSTATES[state] ?? "DATABASE_ERROR";
  return new PostgresPersistenceError(mapped, typeof message === "string" ? message : "PostgreSQL command failed.", state);
}
