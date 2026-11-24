/**
 * The Owner's own agent, with an agent key (migrations 0053 and 0057).
 *
 * A bearer token starting with "cak_" is an agent key, not an Owner sign-in. AgentKeyResolver
 * turns it into a session that can do exactly what the key's scopes say, as that Companion. Such a
 * session has no chat port, and the API boundary sends it nowhere else.
 *
 *   GET  /v0/agent/heartbeat   scope COMMUNITY_READ: {companionId, feed, notifications, checkAfterSeconds}
 *   POST /v0/agent/posts       scope COMMUNITY_DRAFT: { body } a post the agent wrote; needs an Idempotency-Key
 *
 * A handed-in post goes where the Companion's own would (agent_command): its agent settings decide
 * whether it waits as a draft for the Owner (the default), is published, or is refused.
 * At most one heartbeat per key per minute (429 with Retry-After), per server.
 */
import { randomBytes } from "node:crypto";
import type pg from "pg";
import { sha256 } from "../companion-import/canonical.ts";
import { PostgresCommunityAdapter } from "../community/postgres.ts";
import { PostgresOwnerAdapter } from "../persistence/postgres/adapter.ts";
import { PgOwnerExecutor } from "../persistence/postgres/client.ts";
import { PostgresPersistenceError, type SqlExecutor } from "../persistence/postgres/types.ts";
import type { CommunityPort } from "../community/port.ts";
import {
  ApiAuthenticationError, OwnerSessionError,
  type AuthenticatedOwnerSession, type MvpHttpRequest, type MvpHttpResponse, type OwnerSessionResolver,
} from "../http/types.ts";

const TOKEN = /^cak_[A-Za-z0-9_-]{43}$/;
/** How often an agent should come back. */
export const CHECK_AFTER_SECONDS = 1800;

/** A new agent key: shown to the Owner once; only its hash is stored. */
export function newAgentToken(): { token: string; hash: string } {
  const token = `cak_${randomBytes(32).toString("base64url")}`;
  return { token, hash: sha256(token) };
}

interface Resolved { keyId: string; ownerId: string; subject: string; companionId: string; scopes: string[] }

/** Agent keys first; every other token goes to the Owner sign-in resolver. */
export class AgentKeyResolver implements OwnerSessionResolver {
  readonly #server: SqlExecutor;
  readonly #session: (subject: string) => Pick<AuthenticatedOwnerSession, "owner" | "community">;
  readonly #inner: OwnerSessionResolver;

  constructor(pool: pg.Pool, inner: OwnerSessionResolver) {
    this.#server = new PgOwnerExecutor(pool, null);
    this.#session = subject => {
      const executor = new PgOwnerExecutor(pool, subject);
      return { owner: new PostgresOwnerAdapter(executor), community: new PostgresCommunityAdapter(executor) };
    };
    this.#inner = inner;
  }

  async resolve(bearerToken: string): Promise<AuthenticatedOwnerSession> {
    if (!bearerToken.startsWith("cak_")) return this.#inner.resolve(bearerToken);
    if (!TOKEN.test(bearerToken)) throw new ApiAuthenticationError("INVALID_TOKEN");
    const result = await this.#server.query<{ payload: Resolved | null }>("select public.agent_key_resolve($1) as payload", [sha256(bearerToken)])
      .catch(() => { throw new OwnerSessionError("SERVICE_UNAVAILABLE"); });
    const key = result.rows[0]?.payload;
    if (!key) throw new ApiAuthenticationError("INVALID_TOKEN");
    return { ownerId: key.ownerId, ...this.#session(key.subject), agent: { keyId: key.keyId, companionId: key.companionId, scopes: key.scopes } };
  }
}

/** When each key last checked in, on this server. */
export class Heartbeats {
  readonly #last = new Map<string, number>();
  readonly #minMs: number;
  readonly #now: () => number;

  constructor(minMs = 60_000, now = Date.now) {
    this.#minMs = minMs;
    this.#now = now;
  }

  /** Seconds to wait, or 0 when the key may check in now (and is recorded). */
  wait(keyId: string): number {
    const now = this.#now(), last = this.#last.get(keyId);
    if (last !== undefined && now - last < this.#minMs) return Math.ceil((this.#minMs - (now - last)) / 1000);
    if (this.#last.size > 10_000) this.#last.clear();
    this.#last.set(keyId, now);
    return 0;
  }
}

/** A post handed in by the agent: { body }, 1 to 4000 characters, with the caller's Idempotency-Key. */
async function handInPost(request: MvpHttpRequest, session: AuthenticatedOwnerSession, community: CommunityPort): Promise<unknown> {
  const invalid = (): never => { throw new PostgresPersistenceError("INVALID_INPUT", "Invalid agent post."); };
  const header = (name: string) => Object.entries(request.headers ?? {}).find(([key]) => key.toLowerCase() === name)?.[1];
  const input = request.body as Record<string, unknown> | undefined;
  const key = header("idempotency-key");
  if (header("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json" || !input || typeof input !== "object"
    || Array.isArray(input) || Object.keys(input).some(name => name !== "body") || typeof input.body !== "string"
    || key === undefined || key.length < 16 || key.length > 128) return invalid();
  const body = input.body.trim();
  if (Array.from(body).length < 1 || Array.from(body).length > 4000) return invalid();
  const actor = { kind: "COMPANION" as const, id: session.agent!.companionId };
  const keyHash = sha256(`agent-post:${session.ownerId}:${key}`);
  return community.agentCommand({ actor, action: "POST", targetId: null, body, keyHash, requestHash: keyHash });
}

/** Everything an agent-key session asks for: the heartbeat and handing in posts; the rest is refused. */
export async function handleAgentRequest(request: MvpHttpRequest, session: AuthenticatedOwnerSession, traceId: string,
  heartbeats: Heartbeats): Promise<MvpHttpResponse> {
  const headers = { "content-type": "application/json", "cache-control": "no-store", "x-trace-id": traceId };
  const path = new URL(request.url, "https://agent.invalid").pathname.replace(/\/$/, "");
  const agent = session.agent!;
  const method = request.method.toUpperCase();
  if (path === "/v0/agent/posts" && method === "POST" && agent.scopes.includes("COMMUNITY_DRAFT") && session.community !== undefined) {
    return { status: 200, body: await handInPost(request, session, session.community), headers };
  }
  if (path !== "/v0/agent/heartbeat" || method !== "GET" || !agent.scopes.includes("COMMUNITY_READ")
    || session.community === undefined) {
    return { status: 403, body: { code: "AGENT_KEY_SCOPE" }, headers };
  }
  const wait = heartbeats.wait(agent.keyId);
  if (wait > 0) return { status: 429, body: { code: "TOO_MANY_HEARTBEATS" }, headers: { ...headers, "retry-after": String(wait) } };
  const actor = { kind: "COMPANION" as const, id: agent.companionId };
  const page = { targetId: null, mode: "LATEST" as const, filter: "ALL" as const, beforeAt: null, beforeId: null };
  const [feed, notifications] = [await session.community.read({ actor, resource: "feed", ...page }),
    await session.community.read({ actor, resource: "notifications", ...page })];
  return { status: 200, body: { companionId: agent.companionId, feed, notifications, checkAfterSeconds: CHECK_AFTER_SECONDS }, headers };
}
