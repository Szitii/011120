import { test } from "node:test";
import assert from "node:assert/strict";
import { createChatClient } from "../src/chat/client.ts";
import { quotaMessage, type Wallet } from "../src/wallet/wallet.ts";

const balance = {
  enabled: true, state: "ACTIVE", available: 0, freeCredits: 0, paidCredits: 0,
  reserved: 0, creditsPerCent: 10, priceVersion: "credits/10-per-cent", version: 1,
} satisfies Wallet;

test("wallet is requested using the authenticated read-only route", async () => {
  const client = createChatClient(async <T>(method: string, path: string, body?: unknown) => {
    assert.deepEqual([method, path, body], ["GET", "/v0/wallet", undefined]);
    return balance as T;
  });
  assert.deepEqual(await client.wallet!(), balance);
});

test("quota copy distinguishes a confirmed zero balance, outstanding reservations and a frozen wallet", () => {
  assert.match(quotaMessage(), /额度限制/);
  assert.match(quotaMessage({ enabled: false }), /免费回复/);
  assert.match(quotaMessage(balance), /没有可用的平台积分/);
  assert.match(quotaMessage({ ...balance, reserved: 10 }), /正在结算/);
  assert.match(quotaMessage({ ...balance, available: 200, state: "FROZEN" }), /已冻结/);
  assert.match(quotaMessage({ ...balance, available: 200 }), /额度限制/);
});
