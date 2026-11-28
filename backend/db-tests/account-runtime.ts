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

  if (!realAuth) {
    // A verified Supabase user with no Owner row yet: the first request creates exactly one Owner.
    // Signing up, as the sign-in service leaves it: a user and the identity that holds the address a second time.
    const signUp = async (email: string) => {
      const id = randomUUID();
      await pool.query("insert into auth.users(id, email) values ($1, $2)", [id, email]);
      await pool.query("insert into auth.identities(user_id, identity_data) values ($1::uuid, jsonb_build_object('sub', $1::uuid::text, 'email', $2::text))", [id, email]);
      return id;
    };
    const address = `closing-${randomUUID()}@account-fixture.test`;
    const subject = await signUp(address);
    stubUsers.set("token-new", subject);
    const first = await call<ActiveIdentityContext>("token-new", "identity-context");
    const second = await call<ActiveIdentityContext>("token-new", "identity-context");
    assert.equal(first.status, 200);
    assert.equal(first.data.activeSubject.kind, "OWNER");
    assert.equal(second.data.activeSubject.id, first.data.activeSubject.id);
    const owners = await pool.query("select id, status from public.owners where auth_user_id = $1", [subject]);
    assert.deepEqual(owners.rows, [{ id: first.data.activeSubject.id, status: "ACTIVE" }]);
    console.log("Account integration 4b: first sign-in creates one ACTIVE Owner and is idempotent");

    // ---- closing the account (migration 0083): kept on file, signed out for good, gone for everyone else ----
    // A sign-in token says when the password was last typed (`amr`); the Auth double accepts these two for the new user.
    const jwt = (typedAt: number, sub = subject) => {
      const token = `e30.${Buffer.from(JSON.stringify({ sub,
        amr: [{ method: "password", timestamp: Math.floor(typedAt / 1000) }] })).toString("base64url")}.signature`;
      stubUsers.set(token, sub);
      return token;
    };
    const stale = jwt(Date.now() - 11 * 60_000), fresh = jwt(Date.now() - 60_000);
    const closing = first.data.activeSubject.id;
    const me: ActorContext = { kind: "OWNER", id: closing };
    // A name of its own: the search below returns 20 identities, and a new account's default name is shared by every other fresh one.
    await pool.query("update public.owners set display_name = $2 where id = $1", [closing, `注销前${closing.slice(0, 8)}`]);
    const mine = await community<CommunityProfile>(fresh, me, "profile");
    const said = await community<CommunityPost>(fresh, me, "posts", "POST", { body: "注销前说的话" });
    assert.deepEqual([mine.status, said.status], [200, 201]);
    const lookFor = `search?category=HUMAN&q=${encodeURIComponent(mine.data.displayName)}`;
    const finds = async () => (await community<CommunityPage<{ type: string; actor?: CommunityProfile }>>(tokenA, A, lookFor)).data.items
      .some(item => item.actor?.id === mine.data.id);
    assert.deepEqual([(await community(tokenA, A, `profile/${mine.data.id}`)).status, await finds()], [200, true]);
    // What it owns: a Companion with a stored model key and a key for its agent, two signed-in devices, an avatar file.
    const companion = randomUUID();
    await pool.query("insert into public.companions (id, owner_id, status, origin_type) values ($1, $2, 'ACTIVE', 'IMPORTED_CARD')", [companion, closing]);
    await pool.query(`insert into companion_private.companion_connections(companion_id, kind, provider, base_url, model, secret, secret_hint, consented_at)
      values ($1, 'BYOK', 'custom', 'https://example.com/v1', 'm', 'v1.a.b.c', 'abcd', now())`, [companion]);
    await pool.query(`insert into companion_private.agent_keys(owner_id, companion_id, name, token_hash, scopes, expires_at)
      values ($1, $2, 'k', repeat('c', 64), array['COMMUNITY_READ'], now() + interval '1 day')`, [closing, companion]);
    await pool.query("insert into auth.sessions(user_id) values ($1), ($1)", [subject]);
    const asSubject = async (sql: string, values: unknown[] = []) => {
      const client = await pool.connect();
      try {
        await client.query("begin"); await client.query("set local role authenticated");
        await client.query("select set_config('request.jwt.claim.sub', $1, true)", [subject]);
        return await client.query(sql, values);
      } finally { await client.query("rollback"); client.release(); }
    };
    const uploadAvatar = () => asSubject("insert into storage.objects(bucket_id, name, owner_id) values ('media', $1, $2)",
      [`avatar/${randomUUID()}.jpg`, subject]);
    await uploadAvatar();

    // The password must have been typed within ten minutes: an older sign-in, or a token that does not say, is sent back.
    for (const token of [stale, "token-new"]) {
      const sentBack = await call<{ code: string }>(token, "account", "DELETE");
      assert.deepEqual([sentBack.status, sentBack.data.code], [403, "SIGN_IN_AGAIN"]);
    }
    assert.equal((await call(fresh, "account", "DELETE", { confirm: true })).status, 400, "it takes no body");
    // Only the server may call it: going around the server (Supabase's own API) is refused by the database.
    await assert.rejects(asSubject("select public.account_close()"), (error: unknown) => (error as { code?: string }).code === "42501");
    assert.equal((await pool.query("select status from public.owners where id = $1", [closing])).rows[0].status, "ACTIVE");

    const taken = async (email: string) => (await pool.query(`select (select count(*)::int from auth.identities where email = lower($1))
      + (select count(*)::int from auth.users where lower(email) = lower($1)) as n`, [email])).rows[0].n;
    assert.equal(await taken(address), 2, "while the account is open its address is taken: by the user and by its identity");
    const closed = await call<{ closed: boolean }>(fresh, "account", "DELETE");
    assert.deepEqual([closed.status, closed.data], [200, { closed: true }]);
    const after = (await pool.query(`select o.status, o.closed_at is not null as dated, u.banned_until > now() + interval '99 years' as banned,
        (select count(*)::int from auth.sessions s where s.user_id = u.id) as sessions,
        (select count(*)::int from companion_private.companion_connections x where x.companion_id = $2) as connections,
        (select count(*)::int from companion_private.agent_keys k where k.owner_id = o.id) as keys,
        (select count(*)::int from public.audit_events e where e.owner_id = o.id and e.action = 'ACCOUNT_CLOSE') as audited,
        (select count(*)::int from public.community_posts p where p.id = $3 and p.deleted_at is null) as posts,
        (select count(*)::int from public.companions c where c.id = $2 and c.status = 'ACTIVE') as companions
      from public.owners o join auth.users u on u.id = o.auth_user_id where o.id = $1`, [closing, companion, said.data.id])).rows[0];
    assert.deepEqual(after, { status: "DELETED", dated: true, banned: true, sessions: 0, connections: 0, keys: 0, audited: 1, posts: 1, companions: 1 },
      "signed out and its keys destroyed; what it wrote and made is kept on file");
    // No way back in, not even with the token that closed it; nobody else is touched.
    for (const token of [fresh, stale, "token-new"]) {
      const refused = await call<{ code: string }>(token, "identity-context");
      assert.deepEqual([refused.status, refused.data.code], [403, "FORBIDDEN"]);
    }
    assert.equal((await call(fresh, "account", "DELETE")).status, 403);
    assert.equal((await call(tokenA, "identity-context")).status, 200);
    await assert.rejects(uploadAvatar(), (error: unknown) => (error as { code?: string }).code === "42501", "a closed account uploads nothing");
    // Gone from the community: the profile, the post, the search.
    assert.deepEqual([(await community(tokenA, A, `profile/${mine.data.id}`)).status, (await community(tokenA, A, `posts/${said.data.id}`)).status, await finds()],
      [404, 404, false]);
    assert.ok(!(await community<CommunityPage<CommunityPost>>(tokenA, A, "feed")).data.items.some(item => item.id === said.data.id));
    console.log("Account integration 4c: closing an account needs a fresh sign-in, keeps the data, ends every sign-in and hides the account");

    // ---- the address is given back: it can sign up again, as a new and empty account ----
    // The sign-in service calls an address taken when an identity or a user has it (`taken`); the closed account has it in neither.
    const mark = (id: string) => `.closed-${id.replaceAll("-", "")}.invalid`;
    const kept = async (id: string) => (await pool.query(`select u.email::text as "user", i.email as identity, i.identity_data->>'sub' as sub
      from auth.users u join auth.identities i on i.user_id = u.id where u.id = $1`, [id])).rows;
    assert.equal(await taken(address), 0);
    // Still on file under the old sign-in, marked, and the rest of the identity untouched.
    assert.deepEqual(await kept(subject), [{ user: address + mark(subject), identity: address + mark(subject), sub: subject }]);
    const again = await signUp(address);
    const back = await call<ActiveIdentityContext>(jwt(Date.now() - 60_000, again), "identity-context");
    assert.equal(back.status, 200);
    assert.notEqual(back.data.activeSubject.id, closing, "a new Owner, not the closed one reopened");
    assert.deepEqual((await pool.query(`select (select count(*)::int from public.companions c where c.owner_id = o.id) as companions,
        (select count(*)::int from public.community_posts p join public.community_actors a on a.id = p.actor_id where a.owner_id = o.id) as posts
      from public.owners o where o.id = $1`, [back.data.activeSubject.id])).rows, [{ companions: 0, posts: 0 }], "nothing of the closed account comes with it");
    assert.equal((await pool.query("select status from public.owners where id = $1", [closing])).rows[0].status, "DELETED");
    // Closed a second time, the same address is on file twice, each under its own mark, and free once more.
    assert.equal((await call(jwt(Date.now() - 60_000, again), "account", "DELETE")).status, 200);
    assert.deepEqual([await taken(address), (await kept(again))[0].user], [0, address + mark(again)]);
    // The longest address the sign-in service stores (255 characters) still closes: it loses its end to the mark.
    const long = `${"a".repeat(64)}@${"b".repeat(60)}.${"c".repeat(60)}.${"d".repeat(60)}.test`.padEnd(255, "x");
    const longUser = await signUp(long);
    const longToken = jwt(Date.now() - 60_000, longUser);
    assert.deepEqual([(await call(longToken, "identity-context")).status, (await call(longToken, "account", "DELETE")).status], [200, 200]);
    const longKept = (await kept(longUser))[0];
    assert.deepEqual([longKept.user.length, longKept.user, longKept.identity, await taken(long)],
      [255, long.slice(0, 255 - mark(longUser).length) + mark(longUser), longKept.user, 0]);
    console.log("Account integration 4d: a closed account gives its e-mail address back; signing up with it again starts a new, empty account");
  }

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
