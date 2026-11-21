import type pg from "pg";
import { PostgresCommunityAdapter } from "../community/postgres.ts";
import { PostgresOwnerAdapter } from "../persistence/postgres/adapter.ts";
import { TransactionalOwnerExecutor } from "../persistence/postgres/owner-executor.ts";
import { ApiAuthenticationError, OwnerSessionError, type AuthenticatedOwnerSession, type OwnerSessionResolver } from "./types.ts";

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

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
    const executor = new TransactionalOwnerExecutor(this.#pool, subject);
    const result = await executor.query<{ id: string }>(
      "select id from public.owners where auth_user_id = $1 and status = 'ACTIVE'",
      [subject],
    ).catch(() => { throw new OwnerSessionError("SERVICE_UNAVAILABLE"); });
    const ownerId = result.rows[0]?.id;
    if (!ownerId) throw new OwnerSessionError("FORBIDDEN");
    return {
      ownerId,
      owner: new PostgresOwnerAdapter(executor),
      community: new PostgresCommunityAdapter(executor),
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
