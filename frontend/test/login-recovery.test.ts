import assert from "node:assert/strict";
import { test } from "node:test";
import { RealApiAdapter, safeClientMessage } from "../src/adapters/real-api.ts";
import { InvalidIdentityContextError, validateIdentityContext } from "../src/adapters/identity-context.ts";
import { InvalidCommunityPayloadError } from "../src/community/client.ts";
import { RequestTimeoutError, withRequestDeadline } from "../src/state/request-deadline.ts";

const owner = { kind: "OWNER", id: "owner-1", presentation: { displayName: "测试昵称" } } as const;
const context = { viewer: { ownerId: owner.id }, activeSubject: owner, relationship: "SELF", viewMode: "OWNER", capabilities: {} } as const;
const api = new RealApiAdapter({ baseUrl: "https://api.example.test", bearerToken: "fixture" });

test("identity ingress refuses a missing viewer, missing presentation, or mismatched subject", () => {
  assert.deepEqual(validateIdentityContext(context), context);
  assert.throws(() => validateIdentityContext(null), InvalidIdentityContextError);
  assert.throws(() => validateIdentityContext({ ...context, viewer: null }), InvalidIdentityContextError);
  assert.throws(() => validateIdentityContext({ ...context, activeSubject: { ...owner, presentation: null } }), InvalidIdentityContextError);
  assert.throws(() => validateIdentityContext(context, { kind: "COMPANION", id: "other" }), InvalidIdentityContextError);
});

test("identity and community errors can recover to real response shapes on retry", async t => {
  let reply: unknown = {};
  t.mock.method(globalThis, "fetch", async () => Response.json(reply));
  const error = await api.identityContext().catch(reason => reason);
  assert.deepEqual(safeClientMessage(error), { title: "身份资料不完整，暂时无法进入社区。", retry: true });
  reply = context;
  assert.equal((await api.identityContext()).activeSubject.presentation.displayName, "测试昵称");
  reply = { items: [{ id: "broken" }], nextCursor: null };
  await assert.rejects(api.community.feed(owner), InvalidCommunityPayloadError);
  reply = { items: [], nextCursor: null };
  assert.deepEqual(await api.community.feed(owner), reply);
});

test("a deadline interrupts the operation and aborts its transport signal", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let signal: AbortSignal | undefined;
  const timed = withRequestDeadline(signalForRequest => {
    signal = signalForRequest;
    return new Promise<never>(() => undefined);
  }, 10);
  await Promise.resolve();
  t.mock.timers.tick(10);
  await assert.rejects(timed, RequestTimeoutError);
  assert.equal(signal?.aborted, true);
});
