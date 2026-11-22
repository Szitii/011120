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
