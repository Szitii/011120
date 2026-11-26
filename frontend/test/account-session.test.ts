import assert from "node:assert/strict";
import { test } from "node:test";
import { createClientBootstrap } from "../src/adapters/index.ts";
import { RealApiAdapter, ApiProblemError } from "../src/adapters/real-api.ts";
import { AccountSession, type AuthDriver } from "../src/auth/account-session.ts";

type Session = NonNullable<Awaited<ReturnType<AuthDriver["getSession"]>>["data"]["session"]>;
const account = (name: string, token = name): Session => ({
  access_token: token,
  user: { id: name, email: `${name}@example.test` },
});

function fixture(initial: Session | null = null) {
  let stored = initial;
  let listener: Parameters<AuthDriver["onAuthStateChange"]>[0] | undefined;
  function emit(event: string, value: Session | null) {
    stored = value;
    listener?.(event, value);
  }
  const driver: AuthDriver = {
    onAuthStateChange(callback) {
      listener = callback;
      callback("INITIAL_SESSION", stored);
      return { data: { subscription: { unsubscribe() { listener = undefined; } } } };
    },
    async getSession() { return { data: { session: stored }, error: null }; },
    async signInWithPassword({ email, password }) {
      if (password !== "fixture") return { data: { session: null }, error: Object.assign(new Error("invalid_credentials"), { status: 400 }) };
      emit("SIGNED_IN", account(email.split("@")[0]!));
      return { data: { session: stored }, error: null };
    },
    async refreshSession() { return { data: { session: stored }, error: null }; },
    async signOut() {
      emit("SIGNED_OUT", null);
      return { error: null };
    },
  };
  const session = new AccountSession(driver, error => error instanceof TypeError);
  session.observe();
  return { driver, session, emit };
}

function binding(session: AccountSession) {
  const view = session.snapshot();
  assert.equal(view.kind, "signed-in");
  return view.account;
}

test("real bootstrap requires Supabase with HTTPS and ignores a supplied development bearer", () => {
  const env = {
    EXPO_PUBLIC_API_BASE_URL: "https://api.example.test",
    EXPO_PUBLIC_SUPABASE_URL: "https://auth.example.test",
    EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "publishable",
    EXPO_PUBLIC_OWNER_BEARER_TOKEN: "fixture-only",
  };
  assert.deepEqual(createClientBootstrap(env), {
    dataMode: "real", baseUrl: env.EXPO_PUBLIC_API_BASE_URL,
    supabaseUrl: env.EXPO_PUBLIC_SUPABASE_URL, publishableKey: "publishable",
  });
  assert.throws(() => createClientBootstrap({ ...env, EXPO_PUBLIC_SUPABASE_URL: undefined }), /SUPABASE_URL/);
  assert.throws(() => createClientBootstrap({ ...env, EXPO_PUBLIC_API_BASE_URL: "http://api.example.test" }), /HTTPS/);
  assert.equal(createClientBootstrap({ ...env, EXPO_PUBLIC_DATA_MODE: "dev" }).dataMode, "dev");
});

test("restores a persisted session, keeps the same binding on refresh, and handles expiry", async () => {
  const { session, emit } = fixture(account("alice"));
  const original = binding(session);
  assert.equal(await original.tokens.getToken(), "alice");
  emit("TOKEN_REFRESHED", account("alice", "rotated"));
  assert.equal(binding(session), original);
  assert.equal(await original.tokens.getToken(), "rotated");
  original.tokens.rejectToken("alice");
  assert.equal(binding(session), original);

  emit("SIGNED_OUT", null);
  assert.deepEqual(session.snapshot(), { kind: "signed-out", message: "登录已过期，请重新登录。" });
  assert.equal(original.tokens.signal.aborted, true);
});

test("drops late HTTP responses and never uses the new account token on the old client", async t => {
  const { session } = fixture(account("alice"));
  const original = binding(session);
  const api = new RealApiAdapter({ baseUrl: "https://api.example.test", session: original.tokens });
  const started = Promise.withResolvers<void>();
  const delayed = Promise.withResolvers<Response>();
  const fetchMock = t.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => {
    assert.equal(new Headers(options.headers).get("Authorization"), "Bearer alice");
    assert.equal(options.signal, original.tokens.signal);
    started.resolve();
    return delayed.promise;
  });

  const request = api.worldItems();
  await started.promise;
  const logout = session.signOut();
  assert.equal(session.snapshot().kind, "signing-out");
  assert.equal(original.tokens.signal.aborted, true);
  await logout;
  await session.signIn("bob@example.test", "wrong");
  assert.equal(session.snapshot().kind, "signed-out");
  await session.signIn(" bob@example.test ", "fixture");
  assert.equal(await binding(session).tokens.getToken(), "bob");
  assert.notEqual(binding(session).generation, original.generation);

  delayed.resolve(Response.json({ items: ["alice data"] }));
  await assert.rejects(request, /session changed/);
  await assert.rejects(api.worldItems(), /session changed/);
  assert.equal(fetchMock.mock.callCount(), 1);
});

test("refreshes concurrent rejections once and retries with the original command key", async t => {
  const { session, emit, driver } = fixture(account("alice"));
  const refresh = t.mock.method(driver, "refreshSession", async () => {
    const rotated = account("alice", "new-token");
    emit("TOKEN_REFRESHED", rotated);
    return { data: { session: rotated }, error: null };
  });
  const requests: { token: string | null; key: string | null }[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => {
    const headers = new Headers(options.headers);
    requests.push({ token: headers.get("Authorization"), key: headers.get("Idempotency-Key") });
    return headers.get("Authorization") === "Bearer alice"
      ? Response.json({ code: "INVALID_TOKEN" }, { status: 401 })
      : Response.json({});
  });
  const api = new RealApiAdapter({ baseUrl: "https://api.example.test", session: binding(session).tokens });
  await Promise.all(["request-a", "request-b"].map(key =>
    api.community.publish({ kind: "OWNER", id: "owner" }, "message", key)));
  assert.equal(refresh.mock.callCount(), 1);
  for (const key of ["request-a", "request-b"]) {
    assert.deepEqual(requests.filter(r => r.key === key).map(r => r.token), ["Bearer alice", "Bearer new-token"]);
  }
});

test("retains the session on upstream unavailability and clears it after a second auth rejection", async t => {
  const { session, driver } = fixture(account("alice"));
  let response = () => Response.json({ code: "SERVICE_UNAVAILABLE" }, { status: 503 });
  t.mock.method(globalThis, "fetch", async () => response());
  const refresh = t.mock.method(driver, "refreshSession");
  const api = new RealApiAdapter({ baseUrl: "https://api.example.test", session: binding(session).tokens });
  await assert.rejects(api.ownerCompanions(), { status: 503 });
  assert.equal(session.snapshot().kind, "signed-in");
  assert.equal(refresh.mock.callCount(), 0);

  response = () => Response.json({ code: "INVALID_TOKEN" }, { status: 401 });
  await assert.rejects(api.ownerCompanions(), (e: unknown) => e instanceof ApiProblemError && e.status === 401);
  assert.equal(refresh.mock.callCount(), 1);
  assert.deepEqual(session.snapshot(), { kind: "signed-out", message: "登录已过期，请重新登录。" });
});

test("keeps the old account hidden if local removal fails and permits switching after retry", async () => {
  const { session, driver, emit } = fixture(account("alice"));
  driver.signOut = async () => { throw new Error("storage unavailable"); };
  await session.signOut();
  assert.equal(session.snapshot().kind, "logout-error");
  await session.signIn("bob@example.test", "fixture");
  assert.equal(session.snapshot().kind, "logout-error");

  driver.signOut = async () => {
    emit("SIGNED_OUT", null);
    return { error: new TypeError("offline") };
  };
  await session.signOut();
  assert.equal(session.snapshot().kind, "signed-out");
  await session.signIn("bob@example.test", "fixture");
  assert.equal(binding(session).email, "bob@example.test");
});

test("voice requests retry with the refreshed owner token and decode binary responses", async t => {
  const { session, emit, driver } = fixture(account("alice"));
  t.mock.method(driver, "refreshSession", async () => {
    const rotated = account("alice", "voice-token");
    emit("TOKEN_REFRESHED", rotated);
    return { data: { session: rotated }, error: null };
  });
  const urls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    const headers = new Headers(options.headers);
    urls.push(url);
    assert.equal(headers.get("Accept"), "audio/*");
    if (headers.get("Authorization") === "Bearer alice") return Response.json({ code: "INVALID_TOKEN" }, { status: 401 });
    assert.equal(headers.get("Authorization"), "Bearer voice-token");
    return new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "audio/wav" } });
  });
  const api = new RealApiAdapter({ baseUrl: "https://api.example.test", session: binding(session).tokens });
  const clip = await api.chat.messageAudio!("chat/id", "message/id");
  assert.equal(clip.mime, "audio/wav");
  assert.deepEqual(new Uint8Array(clip.bytes), new Uint8Array([1, 2, 3]));
  assert.deepEqual(urls, Array(2).fill("https://api.example.test/v0/chats/chat%2Fid/messages/message%2Fid/audio"));
  await api.chat.voiceSample!("voice/id");
  assert.equal(urls.at(-1), "https://api.example.test/v0/voices/voice%2Fid/sample");
});

test("an in-flight voice response is discarded after sign-out", async t => {
  const { session } = fixture(account("alice"));
  const api = new RealApiAdapter({ baseUrl: "https://api.example.test", session: binding(session).tokens });
  const started = Promise.withResolvers<void>();
  const delayed = Promise.withResolvers<Response>();
  t.mock.method(globalThis, "fetch", async () => {
    started.resolve();
    return delayed.promise;
  });
  const request = api.chat.voiceSample!("voice");
  await started.promise;
  await session.signOut();
  delayed.resolve(new Response(new Uint8Array([1]), { headers: { "Content-Type": "audio/mpeg" } }));
  await assert.rejects(request, /session changed/);
});

test("registration validates credentials and leaves the normal login session signed out", async () => {
  const { session, driver } = fixture();
  const submitted: { email: string; password: string }[] = [];
  driver.signUp = async credentials => {
    submitted.push(credentials);
    return { data: { user: { id: "new-user" } }, error: null };
  };

  assert.equal((await session.signUp("invalid", "fixture")).ok, false);
  assert.equal((await session.signUp("new@example.test", "short")).ok, false);
  assert.equal((await session.signUp(" new@example.test ", "fixture")).ok, true);
  assert.deepEqual(submitted, [{ email: "new@example.test", password: "fixture" }]);
  assert.equal(session.snapshot().kind, "signed-out");
  assert.equal((await driver.getSession()).data.session, null);
});

test("registration and recovery do not disclose whether an email exists", async () => {
  const { session, driver } = fixture();
  driver.signUp = async () => ({ data: { user: { id: "fixture-user" } }, error: null });
  const registration = await session.signUp("known@example.test", "fixture");
  driver.signUp = async () => ({ data: { user: null }, error: { code: "user_already_exists", status: 422 } });
  assert.deepEqual(await session.signUp("known@example.test", "fixture"), registration);

  driver.resetPasswordForEmail = async email => {
    assert.equal(email, "known@example.test");
    return { data: {}, error: null };
  };
  const recovery = await session.resetPasswordForEmail(" known@example.test ");
  driver.resetPasswordForEmail = async () => ({ data: null, error: { code: "user_not_found", status: 404 } });
  assert.deepEqual(await session.resetPasswordForEmail("unknown@example.test"), recovery);
  assert.equal(session.snapshot().kind, "signed-out");
});

test("self-service requests cannot race each other or a sign-in", async () => {
  const { session, driver } = fixture();
  const requested = Promise.withResolvers<Awaited<ReturnType<NonNullable<AuthDriver["signUp"]>>>>();
  driver.signUp = () => requested.promise;
  let recoveries = 0;
  driver.resetPasswordForEmail = async () => {
    recoveries++;
    return { data: null, error: { message: "fixture upstream detail", status: 429 } };
  };

  const registration = session.signUp("alice@example.test", "fixture");
  assert.equal((await session.resetPasswordForEmail("alice@example.test")).ok, false);
  assert.equal((await session.signUp("bob@example.test", "fixture")).ok, false);
  await session.signIn("bob@example.test", "fixture");
  assert.equal(session.snapshot().kind, "signed-out");
  assert.equal(recoveries, 0);

  requested.resolve({ data: { user: { id: "alice" } }, error: null });
  assert.equal((await registration).ok, true);
  assert.deepEqual(await session.resetPasswordForEmail("alice@example.test"), {
    ok: false, message: "邮件发送过于频繁，请稍后再试。",
  });
  await session.signIn("bob@example.test", "fixture");
  assert.equal(await binding(session).tokens.getToken(), "bob");
});

test("self-service operations do not start while another account is signed in", async () => {
  const { session, driver } = fixture(account("bob"));
  driver.signUp = async () => assert.fail("registration must not contact auth while signed in");
  driver.resetPasswordForEmail = async () => assert.fail("recovery must not contact auth while signed in");
  assert.equal((await session.signUp("alice@example.test", "fixture")).ok, false);
  assert.equal((await session.resetPasswordForEmail("alice@example.test")).ok, false);
  assert.equal(await binding(session).tokens.getToken(), "bob");
});

test("updatePassword requires an active session, validates length, and calls updateUser", async () => {
  const signedOut = fixture();
  signedOut.driver.updateUser = async () => assert.fail("must not update password when signed out");
  assert.equal((await signedOut.session.updatePassword("new-secret")).ok, false);

  const { session, driver } = fixture(account("alice"));
  const active = binding(session);
  const updates: { password: string }[] = [];
  driver.updateUser = async attributes => {
    updates.push(attributes);
    return { data: { user: { id: "alice", email: "alice@example.test" } }, error: null };
  };

  assert.equal((await active.updatePassword("12345")).ok, false);
  assert.equal(updates.length, 0);

  const okResult = await active.updatePassword("new-secret");
  assert.deepEqual(okResult, { ok: true, message: "密码已更新。" });
  assert.deepEqual(updates, [{ password: "new-secret" }]);

  driver.updateUser = async () => ({
    data: { user: null },
    error: { code: "same_password", status: 422 },
  });
  assert.deepEqual(await active.updatePassword("new-secret"), {
    ok: false,
    message: "新密码不能与原密码相同。",
  });

  await session.signOut();
  assert.deepEqual(await active.updatePassword("another-secret"), {
    ok: false,
    message: "登录已过期，请重新登录。",
  });
});

test("a pending password change stays bound to the original account", async () => {
  const { session, emit, driver } = fixture(account("alice"));
  const old = binding(session);
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  driver.updateUser = async (_attributes, token, signal) => {
    assert.equal(token, "alice");
    assert.equal(signal, old.tokens.signal);
    started.resolve();
    await release.promise;
    assert.equal(signal.aborted, true);
    return { data: { user: { id: "alice" } }, error: null };
  };

  const pending = old.updatePassword("fixture-password");
  await started.promise;
  emit("SIGNED_IN", account("bob"));
  release.resolve();
  assert.equal((await pending).ok, false);
  assert.equal(await binding(session).tokens.getToken(), "bob");
});
