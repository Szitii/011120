import { PostgresPersistenceError, type SqlExecutor } from "../persistence/postgres/types.ts";
import type { CommunityCommand, CommunityPort, CommunityRead } from "./port.ts";
import type { ActorContext, HumanProfileSettings } from "../../../contracts/community.ts";

/** Uses the same authenticated transaction executor as the existing Owner API. */
export class PostgresCommunityAdapter implements CommunityPort {
  readonly #executor: SqlExecutor;
  constructor(executor: SqlExecutor) { this.#executor = executor; }

  read(input: CommunityRead): Promise<unknown> {
    return this.#query("select public.community_read($1,$2,$3,$4,$5,$6,$7,$8) as payload", [
      input.actor.kind, input.actor.id, input.resource, input.targetId,
      input.mode, input.filter, input.beforeAt, input.beforeId,
    ]);
  }

  command(input: CommunityCommand): Promise<unknown> {
    return this.#query("select public.community_command($1,$2,$3,$4,$5,$6,$7) as payload", [
      input.actor.kind, input.actor.id, input.action, input.targetId,
      input.body, input.keyHash, input.requestHash,
    ]);
  }

  humanProfileSettings(actor: ActorContext): Promise<unknown> {
    return this.#query("select public.community_get_human_profile($1,$2) as payload", [actor.kind, actor.id]);
  }

  saveHumanProfile(actor: ActorContext, settings: HumanProfileSettings): Promise<unknown> {
    return this.#query("select public.community_update_human_profile($1,$2,$3,$4,$5) as payload", [
      actor.kind, actor.id, settings.displayName, settings.bio, settings.revision,
    ]);
  }

  async #query(sql: string, values: readonly unknown[]): Promise<unknown> {
    try {
      const result = await this.#executor.query(sql, values);
      const payload = result.rows[0]?.payload;
      if (result.rows.length !== 1 || payload === null || typeof payload !== "object" || Array.isArray(payload)) {
        throw new PostgresPersistenceError("DATABASE_ERROR", "Invalid community response.");
      }
      return payload;
    } catch (error) {
      if (error instanceof PostgresPersistenceError) throw error;
      const state = (error as { code?: string }).code;
      const code = state === "P0001" ? "NOT_FOUND" : state === "22023" ? "INVALID_INPUT"
        : state === "23505" ? "CONFLICT" : state === "42501" ? "FORBIDDEN"
        : state === "55000" ? "INVALID_STATE" : state?.startsWith("08") ? "DATABASE_UNAVAILABLE" : "DATABASE_ERROR";
      throw new PostgresPersistenceError(code, "Community database request failed.", state);
    }
  }
}
