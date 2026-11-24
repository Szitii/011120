import assert from "node:assert/strict";
import test from "node:test";
import {
  extendedImportAvailability, validateExternal, validateApiKey,
  type ApiKeySetup, type ExternalSetup,
} from "../src/onboarding/connection-client.ts";

test("provider connection distinguishes invalid configuration from a valid backend payload", () => {
  const form: ApiKeySetup = { provider: "deepseek", baseUrl: "", apiKey: "test-key", model: "deepseek-chat", consent: true };
  assert.equal(validateApiKey({ ...form, apiKey: "bad key" }).status, "INVALID");
  assert.equal(validateApiKey({ ...form, consent: false }).status, "INVALID");
  assert.equal(validateApiKey({ ...form, provider: "custom", baseUrl: "http://example.com/v1" }).status, "INVALID");
  assert.equal(validateApiKey(form).status, "READY");
  assert.equal(extendedImportAvailability().status, "UNAVAILABLE");
});

test("external connection accepts an optional token and rejects embedded credentials", () => {
  const form: ExternalSetup = { name: "小家", endpoint: "https://example.com/chat", bearerToken: "", consent: true };
  assert.equal(validateExternal({ ...form, endpoint: "https://user:password@example.com/chat" }).status, "INVALID");
  assert.equal(validateExternal({ ...form, endpoint: "https://example.com/chat?key=secret" }).status, "INVALID");
  assert.equal(validateExternal({ ...form, bearerToken: "Bearer example" }).status, "INVALID");
  assert.equal(validateExternal(form).status, "READY");
});
