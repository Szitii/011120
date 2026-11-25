import assert from "node:assert/strict";
import test from "node:test";
import {
  connectionMessage, extendedImportAvailability, validateExternal, validateApiKey,
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

test("connection feedback uses only a valid upstream HTTP status and explains complete endpoints", () => {
  assert.match(connectionMessage({ result: "ERROR", httpStatus: 405 }, "external"), /HTTP 405.*完整的 HTTPS 接口地址/);
  assert.match(connectionMessage({ result: "AUTH_FAILED", httpStatus: 401 }, "key"), /密钥.*HTTP 401/);
  assert.doesNotMatch(connectionMessage({ result: "UNREACHABLE" }, "external"), /HTTP/);
  assert.doesNotMatch(connectionMessage({ result: "ERROR", httpStatus: 999 }, "key"), /HTTP/);
  assert.equal(connectionMessage({ result: "CONNECTED" }, "key"), "已连接并保存。");
});

test("external connection accepts an optional token and rejects embedded credentials", () => {
  const form: ExternalSetup = { name: "小家", endpoint: "https://example.com/chat", bearerToken: "", consent: true };
  assert.equal(validateExternal({ ...form, endpoint: "https://user:password@example.com/chat" }).status, "INVALID");
  assert.equal(validateExternal({ ...form, endpoint: "https://example.com/chat?key=secret" }).status, "INVALID");
  assert.equal(validateExternal({ ...form, bearerToken: "Bearer example" }).status, "INVALID");
  assert.equal(validateExternal(form).status, "READY");
});
