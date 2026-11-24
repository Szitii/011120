import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type pg from "pg";
import { createPgPool, PgOwnerExecutor, PgPoolExecutor } from "../src/persistence/postgres/client.ts";

const SUBJECT = "00000000-0000-0000-0000-0000000000a1";

// Records every statement and whether it went to the pool or to the checked-out client: Owner scoping
// only holds when the whole sequence runs on one connection. Statements listed in `failing` throw.
const fakePool = (failing: readonly string[] = []) => {
  const statements: { via: "pool" | "client"; text: string; values?: unknown[] }[] = [];
  let released = 0;
  const query = (via: "pool" | "client") => async (text: string, values?: unknown[]) => {
    statements.push(values === undefined ? { via, text } : { via, text, values });
    if (failing.includes(text)) throw new Error(`${text} failed`);
    return { rows: [{ ok: true }] };
  };
  const pool = {
    query: query("pool"),
    connect: async () => ({ query: query("client"), release: () => { released += 1; } }),
  };
  return { pool: pool as unknown as pg.Pool, statements, released: () => released };
};

describe("PostgreSQL pool executors", () => {
  it("passes one parameterized statement straight to the pool", async () => {
    const { pool, statements } = fakePool();
    const result = await new PgPoolExecutor(pool).query("select $1", [1]);
    assert.deepEqual(result.rows, [{ ok: true }]);
    assert.deepEqual(statements, [{ via: "pool", text: "select $1", values: [1] }]);
  });

  it("binds the authenticated role and the Owner subject on one client inside one transaction", async () => {
    const { pool, statements, released } = fakePool();
    const result = await new PgOwnerExecutor(pool, SUBJECT).query("select * from public.list_owner_companions()", []);
    assert.deepEqual(result.rows, [{ ok: true }]);
    assert.deepEqual(statements, [
      { via: "client", text: "begin" },
      { via: "client", text: "set local role companion_api" },
      { via: "client", text: "select set_config('request.jwt.claim.sub',$1,true)", values: [SUBJECT] },
      { via: "client", text: "select * from public.list_owner_companions()", values: [] },
      { via: "client", text: "commit" },
    ]);
    assert.equal(released(), 1);
  });

  it("runs the server's own jobs as companion_api without an Owner subject", async () => {
    const { pool, statements } = fakePool();
    await new PgOwnerExecutor(pool, null).query("select public.diary_due($1,$2)", [10, true]);
    assert.deepEqual(statements.map(statement => statement.text),
      ["begin", "set local role companion_api", "select public.diary_due($1,$2)", "commit"]);
  });

  it("rolls back, releases the client and rethrows when a statement fails", async () => {
    const { pool, statements, released } = fakePool(["select 1"]);
    await assert.rejects(new PgOwnerExecutor(pool, SUBJECT).query("select 1", []), /select 1 failed/);
    assert.deepEqual(statements.at(-1), { via: "client", text: "rollback" });
    assert.ok(!statements.some((statement) => statement.text === "commit"));
    assert.equal(released(), 1);
  });

  it("keeps the original error and still releases the client when the rollback fails too", async () => {
    const { pool, released } = fakePool(["set local role companion_api", "rollback"]);
    await assert.rejects(
      new PgOwnerExecutor(pool, SUBJECT).query("select 1", []),
      /set local role companion_api failed/,
    );
    assert.equal(released(), 1);
  });

  it("refuses an empty connection string and opens no connection eagerly", async () => {
    assert.throws(() => createPgPool(" "), /connection string is required/);
    const pool = createPgPool("postgresql://postgres@127.0.0.1:1/unused");
    assert.equal(pool.totalCount, 0);
    await pool.end();
  });
});
