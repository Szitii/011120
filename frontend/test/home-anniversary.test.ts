import test from "node:test";
import assert from "node:assert/strict";
import { daysTogether } from "../src/home/anniversary.ts";
import { homeStorageKey } from "../src/home/keys.ts";

test("anniversaries count local calendar days and accept dates before registration", () => {
  const now = new Date("2026-03-09T04:30:00Z");
  assert.equal(daysTogether({ startDate: "2026-03-07", timeZone: "America/New_York" }, now), 3);
  assert.equal(daysTogether({ startDate: "2026-03-09", timeZone: "Asia/Shanghai" }, now), 1);
  assert.ok(daysTogether({ startDate: "1999-01-01", timeZone: "Asia/Shanghai" }, now)! > 9000);
  assert.equal(daysTogether({ startDate: "2026-02-30", timeZone: "Asia/Shanghai" }, now), undefined);
  assert.equal(daysTogether({ startDate: "2026-03-10", timeZone: "Asia/Shanghai" }, now), undefined);
});

test("album and anniversary keys isolate both owner and companion", () => {
  const scope = { ownerId: "owner:1", companionId: "companion/1" };
  const key = homeStorageKey(scope, "album:index");
  assert.equal(key, "cw:v1:owner:owner%3A1:home:companion%2F1:album:index");
  assert.notEqual(key, homeStorageKey({ ...scope, ownerId: "owner:2" }, "album:index"));
  assert.notEqual(key, homeStorageKey({ ...scope, companionId: "companion/2" }, "album:index"));
  assert.notEqual(key, homeStorageKey(scope, "anniversary"));
});
