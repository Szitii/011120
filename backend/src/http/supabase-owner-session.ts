import type pg from "pg";
import { PostgresChatAdapter } from "../chat/postgres.ts";
import { PostgresCommunityAdapter } from "../community/postgres.ts";
import { PostgresOwnerAdapter } from "../persistence/postgres/adapter.ts";
import { PgOwnerExecutor } from "../persistence/postgres/client.ts";
import { ApiAuthenticationError, OwnerSessionError, type AuthenticatedOwnerSession, type OwnerSessionResolver } from "./types.ts";

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/**
 * When the sign-in behind this token last proved who it is, in milliseconds: the newest entry of
 * the token's `amr` list (password, a code from an e-mail, ...). Supabase keeps that time when it
 * refreshes a token, so an old sign-in does not look new. Read only from a token Supabase has
 * just accepted.
 */
export function signedInAt(bearerToken: string): number | undefined {
  try {
    const claims = JSON.parse(Buffer.from(bearerToken.split(".")[1] ?? "", "base64url").toString("utf8")) as { amr?: unknown };
    const times = (Array.isArray(claims.amr) ? claims.amr : []).flatMap((entry: unknown) => {
      const { method, timestamp } = (entry ?? {}) as { method?: unknown; timestamp?: unknown };
      return method !== "token_refresh" && typeof timestamp === "number" && Number.isFinite(timestamp) ? [timestamp * 1000] : [];
    });
    return times.length === 0 ? undefined : Math.max(...times);
  } catch {
    return undefined;
  }
}

export class SupabaseOwnerSessionResolver implements OwnerSessionResolver {
  readonly #pool: pg.Pool;
  readonly #userUrl: URL;
  readonly #publishableKey: string;

  constructor(input: { pool: pg.Pool; supabaseUrl: string; publishableKey: string }) {
    const project = new URL(input.supabaseUrl);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(project.hostname);
    if ((project.protocol !== "https:" && !(loopback && project.protocol === "http:"))
      || project.username || project.password || !input.publishableKey.trim()) {
      throw new Error("A Supabase project URL and publishable key are required.");
    }
    this.#pool = input.pool;
    this.#userUrl = new URL("/auth/v1/user", project);
    this.#publishableKey = input.publishableKey;
  }

  async resolve(bearerToken: string): Promise<AuthenticatedOwnerSession> {
    const subject = await this.#verifySubject(bearerToken);
    const executor = new PgOwnerExecutor(this.#pool, subject);
    // Creates the Owner on first sign-in; null means the account exists but is not ACTIVE.
    const result = await executor.query<{ id: string | null }>(
      "select public.claim_owner() as id",
      [],
    ).catch(() => { throw new OwnerSessionError("SERVICE_UNAVAILABLE"); });
    const ownerId = result.rows[0]?.id;
    if (!ownerId) throw new OwnerSessionError("FORBIDDEN");
    const at = signedInAt(bearerToken);
    return {
      ownerId,
      ...(at === undefined ? {} : { signedInAt: at }),
      owner: new PostgresOwnerAdapter(executor),
      community: new PostgresCommunityAdapter(executor),
      chat: new PostgresChatAdapter(executor),
    };
  }

  async #verifySubject(bearerToken: string): Promise<string> {
    const response = await fetch(this.#userUrl, {
      headers: { apikey: this.#publishableKey, Authorization: `Bearer ${bearerToken}` },
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    }).catch(() => { throw new OwnerSessionError("SERVICE_UNAVAILABLE"); });
    if (response.status === 401 || response.status === 403) {
      throw new ApiAuthenticationError("INVALID_TOKEN");
    }
    if (!response.ok) throw new OwnerSessionError("SERVICE_UNAVAILABLE");
    const payload: unknown = await response.json().catch(() => undefined);
    if (!payload || typeof payload !== "object") throw new OwnerSessionError("SERVICE_UNAVAILABLE");
    const user = payload as Record<string, unknown>;
    if (user.role !== "authenticated" || user.is_anonymous === true
      || typeof user.id !== "string" || !UUID.test(user.id)) {
      throw new ApiAuthenticationError("INVALID_TOKEN");
    }
    return user.id;
  }
}
