import assert from "node:assert/strict";
import { it } from "node:test";
import { DiaryScheduler } from "../src/chat/diary-scheduler.ts";
import type { ChatPort } from "../src/chat/port.ts";
import type { SqlExecutor } from "../src/persistence/postgres/types.ts";

const due = [{ companionId: "c1", subject: "s1" }, { companionId: "c2", subject: "s2" }];

function setup(rows: unknown[] | Error, fail: string[] = []) {
  const queries: unknown[][] = []; const written: [string, string][] = []; const logs: string[] = [];
  let release: () => void = () => undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const server: SqlExecutor = {
    query: async <Row extends Record<string, unknown>>(text: string, values: readonly unknown[]) => {
      queries.push([text, ...values]);
      if (rows instanceof Error) throw rows;
      return { rows: rows as Row[] };
    },
  };
  const scheduler = new DiaryScheduler({
    server,
    portFor: subject => ({ subject }) as unknown as ChatPort,
    replies: {
      writeDiary: async (companionId, port) => {
        written.push([companionId, (port as unknown as { subject: string }).subject]);
        await gate;
        if (fail.includes(companionId)) throw new Error("model down");
        return { status: "WRITTEN", entry: null, nextAt: null, failure: null };
      },
    },
    platform: false,
    batch: 5,
    log: message => logs.push(message),
  });
  return { scheduler, queries, written, logs, release };
}

it("writes every due diary as its Owner, one at a time, and keeps going after a failure", async () => {
  const { scheduler, queries, written, logs, release } = setup([{ payload: due }], ["c1"]);
  const round = scheduler.round();
  assert.equal(await scheduler.round(), 0, "rounds never overlap");
  release();
  assert.equal(await round, 2);
  assert.deepEqual(queries, [["select public.diary_due($1,$2) as payload", 5, false]]);
  assert.deepEqual(written, [["c1", "s1"], ["c2", "s2"]]);
  assert.deepEqual(logs, ["Background diary for c1 failed: model down"]);
});

it("survives a database that cannot be asked, and an empty answer", async () => {
  const broken = setup(new Error("connection refused"));
  assert.equal(await broken.scheduler.round(), 0);
  assert.deepEqual(broken.logs, ["Background diary round failed: connection refused"]);
  const empty = setup([]);
  assert.equal(await empty.scheduler.round(), 0);
  assert.deepEqual(empty.logs, []);
});

it("runs rounds on a timer until stopped", async () => {
  const { scheduler, queries, release } = setup([{ payload: [] }]);
  release();
  const stop = scheduler.start(5);
  await new Promise(resolve => setTimeout(resolve, 30));
  stop();
  const seen = queries.length;
  assert.ok(seen >= 1);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(queries.length, seen, "no round after stop");
});
