import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { createSupabaseMobileHttpServer } from "../src/http/supabase-mobile-server.ts";
import { createPgPool } from "../src/persistence/postgres/index.ts";
import type {
  ActorContext, CommunityNotification, CommunityPage, CommunityPost, CommunityProfile,
} from "../../contracts/community.ts";
import type { ActiveIdentityContext, OwnerCompanionCollection } from "../../frontend/src/contracts.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString || process.env.COMPANION_SOCIAL_DEV_DATABASE !== "1") {
  throw new Error("Disposable seeded test database required.");
}
const pool = createPgPool(connectionString);
const A = { kind: "OWNER", id: "00000000-0000-0000-0000-0000000001a1" } as const;
const B = { kind: "OWNER", id: "00000000-0000-0000-0000-0000000001b1" } as const;
const aiA = { kind: "COMPANION", id: "00000000-0000-0000-0000-0000000002a1" } as const;
const aiB = { kind: "COMPANION", id: "00000000-0000-0000-0000-0000000002b1" } as const;
const realAuth = process.env.COMPANION_SOCIAL_REAL_AUTH_TEST === "1";
const servers: Server[] = [];

async function listen(server: Server) {
  servers.push(server);
  await once(server.listen(0, "127.0.0.1"), "listening");
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} for the disposable Auth test environment.`);
  return value;
}

type Login = { access_token: string; refresh_token: string; expires_in: number };
const publishableKey = realAuth ? required("SUPABASE_PUBLISHABLE_KEY") : "test-only-public-key";
const stubUsers = new Map([
  ["token-a", "00000000-0000-0000-0000-0000000000a1"],
  ["token-b", "00000000-0000-0000-0000-0000000000b1"],
]);
const project = realAuth ? required("SUPABASE_URL") : await listen(createServer((request, response) => {
  assert.equal(request.url, "/auth/v1/user");
  assert.equal(request.headers.apikey, publishableKey);
  const token = request.headers.authorization?.slice("Bearer ".length) ?? "";
  const subject = stubUsers.get(token);
  if (token === "upstream-error") response.writeHead(503).end();
  else if (token === "anonymous") response.end(JSON.stringify({
    id: stubUsers.get("token-a"), role: "authenticated", is_anonymous: true,
  }));
  else if (subject) response.end(JSON.stringify({ id: subject, role: "authenticated", is_anonymous: false }));
  else response.writeHead(403).end();
}));

async function auth(path: string, body?: unknown, bearer?: string) {
  return fetch(new URL(`/auth/v1/${path}`, project), {
    method: "POST",
    headers: {
      apikey: publishableKey,
      "Content-Type": "application/json",
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function login(letter: "A" | "B"): Promise<Login> {
  const email = required(`AUTH_TEST_EMAIL_${letter}`);
  const password = required(`AUTH_TEST_PASSWORD_${letter}`);
  const response = await auth("token?grant_type=password", { email, password });
  assert.equal(response.status, 200, `Auth login for test account ${letter}`);
  const session = await response.json() as Login;
  assert.ok(session.access_token && session.refresh_token);
  return session;
}

try {
  const base = await listen(createSupabaseMobileHttpServer({ pool, supabaseUrl: project, publishableKey }));
  async function call<T>(token: string | undefined, path: string, method = "GET", body?: unknown) {
    const response = await fetch(`${base}/v0/${path}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        // Untrusted identity hints must have no effect on the Owner context.
        "X-Owner-Id": B.id,
        "Content-Type": "application/json",
        "Idempotency-Key": randomUUID(),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json() as T };
  }
  const community = <T>(token: string, actor: ActorContext, path: string, method = "GET", body?: unknown) =>
    call<T>(token, `community/${path}${path.includes("?") ? "&" : "?"}${new URLSearchParams({
      actorKind: actor.kind, actorId: actor.id,
    })}`, method, body);

  for (const token of [undefined, "companion-social-stage1-owner", "unknown-token", "anonymous"]) {
    assert.equal((await call(token, "identity-context")).status, 401);
  }
  if (!realAuth) assert.equal((await call("upstream-error", "identity-context")).status, 503);

  const sessionA = realAuth ? await login("A") : undefined;
  const sessionB = realAuth ? await login("B") : undefined;
  const tokenA = sessionA?.access_token ?? "token-a";
  const tokenB = sessionB?.access_token ?? "token-b";

  const [ownerA, ownerB] = await Promise.all([tokenA, tokenB].map(token => call<ActiveIdentityContext>(token, "identity-context")));
  assert.equal(ownerA!.status, 200);
  assert.equal(ownerA!.data.activeSubject.id, A.id);
  assert.equal(ownerB!.status, 200);
  assert.equal(ownerB!.data.activeSubject.id, B.id);
  console.log("Account integration 1: verified subject, fixed-token rejection and distinct Owner mappings");

  for (const [token, own, other] of [[tokenA, aiA, aiB], [tokenB, aiB, aiA]] as const) {
    const roster = await call<OwnerCompanionCollection>(token, "companions");
    assert.equal(roster.status, 200);
    assert.deepEqual(roster.data.items.map(item => item.companionId), [own.id]);
    const switchIdentity = (actor: ActorContext) => call<ActiveIdentityContext>(
      token, `identity-context?activeSubjectKind=${actor.kind}&activeSubjectId=${actor.id}`,
    );
    assert.equal((await switchIdentity(own)).data.activeSubject.id, own.id);
    assert.equal((await switchIdentity(other)).status, 404);
    assert.equal((await community(token, other, "profile")).status, 404);
  }
  console.log("Account integration 2: private roster and bidirectional Companion isolation");

  const profileA = await community<CommunityProfile>(tokenA, A, "profile");
  const profileB = await community<CommunityProfile>(tokenB, B, "profile");
  assert.equal(profileA.status, 200);
  assert.equal(profileB.status, 200);
  const post = await community<CommunityPost>(tokenA, A, "posts", "POST", { body: "Disposable account isolation check" });
  assert.equal(post.status, 201);
  assert.equal((await community(tokenB, B, `following/${profileA.data.id}`, "PUT")).status, 200);
  const followingProfile = await community<CommunityProfile>(tokenB, B, `profile/${profileA.data.id}`);
  const companionFollowingProfile = await community<CommunityProfile>(tokenB, aiB, `profile/${profileA.data.id}`);
  assert.equal(followingProfile.data.following, true);
  assert.equal(companionFollowingProfile.data.following, false);
  const followerFeed = (token: string, actor: ActorContext) =>
    community<CommunityPage<CommunityPost>>(token, actor, "feed?mode=FOLLOWING");
  assert.ok((await followerFeed(tokenB, B)).data.items.some(item => item.id === post.data.id));
  assert.ok(!(await followerFeed(tokenA, A)).data.items.some(item => item.id === post.data.id));
  assert.ok(!(await followerFeed(tokenB, aiB)).data.items.some(item => item.id === post.data.id));
  assert.equal((await community(tokenA, B, "feed?mode=FOLLOWING")).status, 404);

  const notes = (token: string, actor: ActorContext) =>
    community<CommunityPage<CommunityNotification>>(token, actor, "notifications");
  const incoming = (await notes(tokenA, A)).data.items.find(note => note.kind === "FOLLOW" && note.actor.id === profileB.data.id);
  assert.ok(incoming);
  assert.ok(!(await notes(tokenB, B)).data.items.some(note => note.id === incoming.id));
  assert.ok(!(await notes(tokenA, aiA)).data.items.some(note => note.id === incoming.id));
  assert.equal((await community(tokenB, B, `notifications/${incoming.id}/read`, "PUT")).status, 404);
  assert.equal((await community(tokenA, A, `notifications/${incoming.id}/read`, "PUT")).status, 200);
  assert.equal((await community(tokenB, B, `following/${profileA.data.id}`, "DELETE")).status, 200);
  assert.equal((await community(tokenA, A, `posts/${post.data.id}`, "DELETE")).status, 200);
  console.log("Account integration 3: following feed and notifications separated by account and active actor");

  await pool.query("update public.owners set status = 'SUSPENDED' where id = $1", [A.id]);
  try {
    assert.equal((await call(tokenA, "identity-context")).status, 403);
    assert.equal((await call(tokenB, "identity-context")).status, 200);
  } finally {
    await pool.query("update public.owners set status = 'ACTIVE' where id = $1", [A.id]);
  }
  console.log("Account integration 4: verified Auth alone grants no access to an inactive Owner");

  if (sessionA && sessionB) {
    const response = await auth("token?grant_type=refresh_token", { refresh_token: sessionA.refresh_token });
    assert.equal(response.status, 200);
    const refreshed = await response.json() as Login;
    assert.notEqual(refreshed.refresh_token, sessionA.refresh_token);
    const refreshedIdentity = await call<ActiveIdentityContext>(refreshed.access_token, "identity-context");
    assert.equal(refreshedIdentity.status, 200);
    assert.equal(refreshedIdentity.data.activeSubject.id, A.id);
    assert.equal((await auth("logout?scope=local", undefined, refreshed.access_token)).status, 204);
    assert.equal((await call(refreshed.access_token, "identity-context")).status, 401);
    assert.equal((await call<ActiveIdentityContext>(tokenB, "identity-context")).data.activeSubject.id, B.id);
    assert.equal((await auth("logout?scope=local", undefined, tokenB)).status, 204);
    assert.equal((await call(tokenB, "identity-context")).status, 401);
    console.log("Account integration 5: actual Auth password grant, refresh rotation, local logout and revoked-session rejection");

    if (process.env.AUTH_TEST_VERIFY_TOKEN_EXPIRY === "1") {
      const expiring = await login("A");
      assert.ok(Number.isInteger(expiring.expires_in) && expiring.expires_in >= 5 && expiring.expires_in <= 30,
        "Use a disposable Auth instance with a JWT lifetime of 5–30 seconds for this check.");
      assert.equal((await call(expiring.access_token, "identity-context")).status, 200);
      await delay((expiring.expires_in + 1) * 1_000);
      assert.equal((await call(expiring.access_token, "identity-context")).status, 401);

      const response = await auth("token?grant_type=refresh_token", { refresh_token: expiring.refresh_token });
      assert.equal(response.status, 200);
      const renewed = await response.json() as Login;
      const identity = await call<ActiveIdentityContext>(renewed.access_token, "identity-context");
      assert.equal(identity.status, 200);
      assert.equal(identity.data.activeSubject.id, A.id);
      assert.equal((await call(expiring.access_token, "identity-context")).status, 401);
      assert.equal((await auth("logout?scope=local", undefined, renewed.access_token)).status, 204);
      console.log("Account integration 6: natural JWT expiry, rejection of the old token and refresh of the same Owner");
    }
  }
  console.log(`Account PostgreSQL/HTTP integration passed (${realAuth ? "real Supabase Auth" : "Auth HTTP test double"}).`);
} finally {
  await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  await pool.end();
}
