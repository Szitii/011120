import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatReminder } from "../../contracts/chat.ts";
import { createChatClient } from "../src/chat/client.ts";
import { chatReminderLabel, formatReminderTime } from "../src/chat/reminders.ts";

const reminder: ChatReminder = {
  id: "reminder",
  dueAt: "2026-11-27T13:00:00.000Z",
  note: "去拿快递",
  status: "WAITING",
};

test("only server-confirmed reminders show a reminder label", () => {
  assert.equal(chatReminderLabel({ status: "SENT" }), undefined);
  assert.equal(chatReminderLabel({ status: "SENT", reach: "GREETING" }), undefined);
  assert.equal(chatReminderLabel({ status: "SENT", reach: "REMINDER" }), "到点提醒");
  assert.equal(chatReminderLabel({ status: "FAILED", reach: "REMINDER", reminder }), undefined);
  assert.match(chatReminderLabel({ status: "SENT", reminder }) ?? "", /^已设提醒 .*去拿快递$/);
  assert.match(chatReminderLabel({ status: "SENT", reminder: { ...reminder, status: "CANCELLED" } }) ?? "", /^提醒已取消/);
  assert.match(chatReminderLabel({ status: "SENT", reminder: { ...reminder, status: "MISSED" } }) ?? "", /^提醒已错过/);
  assert.equal(formatReminderTime("invalid"), undefined);
});

test("reminder reads and cancellations stay scoped to the companion and use the existing endpoints", async () => {
  const calls: unknown[][] = [];
  const client = createChatClient(async <T>(...args: unknown[]) => {
    calls.push(args);
    return (args[0] === "GET" ? { items: [reminder] } : { deleted: true }) as T;
  });
  assert.deepEqual(await client.listReminders!("companion/id"), { items: [reminder] });
  assert.deepEqual(await client.cancelReminder!("companion/id", "reminder/id"), { deleted: true });
  assert.deepEqual(calls, [
    ["GET", "/v0/companions/companion%2Fid/reminders"],
    ["DELETE", "/v0/companions/companion%2Fid/reminders/reminder%2Fid"],
  ]);
});
