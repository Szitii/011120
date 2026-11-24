import assert from "node:assert/strict";
import test from "node:test";
import { createDiaryClient } from "../src/diary/client.ts";

test("diary requests use owner routes, opaque cursors, and a bodyless generation request", async () => {
  const calls: unknown[][] = [];
  const client = createDiaryClient(async <T>(...request: unknown[]) => {
    calls.push(request);
    return {} as T;
  });
  const settings = { frequency: "RARE", revision: 4 } as const;
  await client.list("companion/1", "time|entry+1");
  await client.writeIfDue("companion/1");
  await client.remove("companion/1", "entry/1");
  await client.getSettings("companion/1");
  await client.saveSettings("companion/1", settings);
  assert.deepEqual(calls, [
    ["GET", "/v0/companions/companion%2F1/diary?cursor=time%7Centry%2B1"],
    ["POST", "/v0/companions/companion%2F1/diary"],
    ["DELETE", "/v0/companions/companion%2F1/diary/entry%2F1"],
    ["GET", "/v0/companions/companion%2F1/diary-settings"],
    ["PUT", "/v0/companions/companion%2F1/diary-settings", settings],
  ]);
});

test("saving background diary keeps the existing frequency and sends the revision with an explicit switch value", async () => {
  const calls: unknown[][] = [];
  const client = createDiaryClient(async <T>(...request: unknown[]) => {
    calls.push(request);
    return { frequency: "DAILY", autoWrite: false, revision: 8 } as T;
  });
  const values = { frequency: "DAILY", autoWrite: false, revision: 7 } as const;
  const settings = await client.saveSettings("home", values);
  assert.deepEqual(calls, [["PUT", "/v0/companions/home/diary-settings", values]]);
  assert.equal(settings.autoWrite, false);
  assert.equal(settings.revision, 8);
});
