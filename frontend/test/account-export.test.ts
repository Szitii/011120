import { test } from "node:test";
import assert from "node:assert/strict";
import { RealApiAdapter } from "../src/adapters/real-api.ts";

test("account export uses the authenticated endpoint and preserves the JSON text and limit code", async t => {
  const example = '{"format":"011120-export/1","owner":{}}';
  let response = new Response(example, { headers: { "Content-Type": "application/json" } });
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    assert.equal(new URL(url).pathname, "/v0/export");
    assert.equal(new Headers(options.headers).get("Authorization"), "Bearer fixture");
    return response;
  });
  const api = new RealApiAdapter({ baseUrl: "https://api.example.test", bearerToken: "fixture" });
  assert.equal(await api.exportAccount(), example);
  response = Response.json({ code: "EXPORT_LIMIT" }, { status: 429 });
  await assert.rejects(api.exportAccount(), { code: "EXPORT_LIMIT", status: 429 });
});
