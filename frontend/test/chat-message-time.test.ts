import assert from "node:assert/strict";
import { test } from "node:test";
import { chatTimeDivider } from "../src/chat/message-time.ts";

const local = (day: number, hour: number, minute: number, second = 0) =>
  new Date(2026, 10, day, hour, minute, second).toISOString();
const today = new Date(local(27, 12, 0));

test("chat time dividers use the next older message even across a page boundary", () => {
  assert.equal(chatTimeDivider(local(27, 10, 5), local(27, 10, 0, 1), today), undefined);
  assert.equal(chatTimeDivider(local(27, 10, 5), local(27, 10, 0), today), "10:05");
  assert.equal(chatTimeDivider(local(27, 10, 0), undefined, today), "10:00");
});

test("chat time dividers show a separator across local midnight even within five minutes", () => {
  assert.equal(chatTimeDivider(local(27, 0, 1), local(26, 23, 59), today), "00:01");
  assert.equal(chatTimeDivider(local(26, 23, 59), undefined, today), "11月26日 23:59");
  assert.equal(chatTimeDivider("invalid", undefined, today), undefined);
});
