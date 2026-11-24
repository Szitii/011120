import assert from "node:assert/strict";
import test from "node:test";
import {
  extendedImportAvailability, testAndConnectExternal, testAndEnableApiKey,
  type ApiKeySetup, type ExternalSetup,
} from "../src/onboarding/connection-client.ts";

test("provider connection distinguishes invalid configuration from backend unavailability", () => {
  const form: ApiKeySetup = { provider: "deepseek", baseUrl: "", apiKey: "test-key", model: "deepseek-chat", consent: true };
  assert.equal(testAndEnableApiKey({ ...form, apiKey: "bad key" }).status, "INVALID");
  assert.equal(testAndEnableApiKey({ ...form, consent: false }).status, "INVALID");
  assert.equal(testAndEnableApiKey({ ...form, provider: "custom", baseUrl: "http://example.com/v1" }).status, "INVALID");
  assert.equal(testAndEnableApiKey(form).status, "UNAVAILABLE");
  assert.equal(extendedImportAvailability().status, "UNAVAILABLE");
});

test("external connection accepts an optional token and rejects embedded credentials", () => {
  const form: ExternalSetup = { name: "小家", endpoint: "https://example.com/chat", bearerToken: "", consent: true };
  assert.equal(testAndConnectExternal({ ...form, endpoint: "https://user:password@example.com/chat" }).status, "INVALID");
  assert.equal(testAndConnectExternal({ ...form, endpoint: "https://example.com/chat?key=secret" }).status, "INVALID");
  assert.equal(testAndConnectExternal({ ...form, bearerToken: "Bearer example" }).status, "INVALID");
  assert.equal(testAndConnectExternal(form).status, "UNAVAILABLE");
});
