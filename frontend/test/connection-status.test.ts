import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchWithConnectionStatus, hasConnectionIssue, subscribeToConnectionStatus } from "../src/state/connection-status.ts";

test("connection status requires clustered transport errors and clears on any HTTP response", async (t) => {
  const endpoint = "https://fixture.example.test";
  const transportError = new TypeError("Failed to fetch");
  let error: Error | undefined = transportError;
  t.mock.method(globalThis, "fetch", async () => {
    if (error) throw error;
    return new Response(null, { status: 503 });
  });
  let now = 10_000;
  t.mock.method(Date, "now", () => now);

  const updates: boolean[] = [];
  const unsubscribe = subscribeToConnectionStatus(() => updates.push(hasConnectionIssue()));
  try {
    await assert.rejects(fetchWithConnectionStatus(endpoint, {}), transportError);
    now += 16_000;
    await assert.rejects(fetchWithConnectionStatus(endpoint, {}), transportError);
    assert.equal(hasConnectionIssue(), false);

    const abort = new AbortController();
    abort.abort();
    await assert.rejects(fetchWithConnectionStatus(endpoint, { signal: abort.signal }), transportError);
    assert.equal(hasConnectionIssue(), false);

    now += 100;
    await assert.rejects(fetchWithConnectionStatus(endpoint, {}), transportError);
    assert.equal(hasConnectionIssue(), true);
    error = undefined;
    assert.equal((await fetchWithConnectionStatus(endpoint, {})).status, 503);
    assert.deepEqual(updates, [true, false]);
  } finally {
    unsubscribe();
  }
});
