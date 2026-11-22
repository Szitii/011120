import { PostgresPersistenceError, type SqlExecutor } from "../persistence/postgres/types.ts";
import type { AgentCommand, CommunityCommand, CommunityPort, CommunityRead, FollowList } from "./port.ts";
import type { ActorContext, AgentSettings, HumanProfileSettings } from "../../../contracts/community.ts";

// SQLSTATE -> error code. Invalid values (bad cast, range check, missing field) are all INVALID_INPUT.
const ERRORS: Readonly<Record<string, PostgresPersistenceError["code"]>> = {
  P0001: "NOT_FOUND", "23505": "CONFLICT", "42501": "FORBIDDEN", "55000": "INVALID_STATE",
  "22023": "INVALID_INPUT", "22P02": "INVALID_INPUT", "22007": "INVALID_INPUT", "22008": "INVALID_INPUT",
  "23502": "INVALID_INPUT", "23514": "INVALID_INPUT",
};

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

  followList(input: FollowList): Promise<unknown> {
    return this.#query("select public.community_follow_list($1,$2,$3,$4,$5) as payload", [
      input.actor.kind, input.actor.id, input.direction, input.beforeAt, input.beforeId,
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

  agentSettings(actor: ActorContext): Promise<unknown> {
    return this.#query("select public.agent_get_settings($1,$2) as payload", [actor.kind, actor.id]);
  }

  saveAgentSettings(actor: ActorContext, settings: AgentSettings): Promise<unknown> {
    return this.#query("select public.agent_update_settings($1,$2,$3) as payload", [actor.kind, actor.id, settings]);
  }

  agentCommand(input: AgentCommand): Promise<unknown> {
    return this.#query("select public.agent_command($1,$2,$3,$4,$5,$6,$7) as payload", [
      input.actor.kind, input.actor.id, input.action, input.targetId,
      input.body, input.keyHash, input.requestHash,
    ]);
  }

  agentDrafts(actor: ActorContext): Promise<unknown> {
    return this.#query("select public.agent_list_drafts($1,$2) as payload", [actor.kind, actor.id]);
  }

  decideAgentDraft(actor: ActorContext, draftId: string, publish: boolean): Promise<unknown> {
    return this.#query("select public.agent_decide_draft($1,$2,$3,$4) as payload", [actor.kind, actor.id, draftId, publish]);
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
      const code = (state === undefined ? undefined : ERRORS[state]) ?? (state?.startsWith("08") ? "DATABASE_UNAVAILABLE" : "DATABASE_ERROR");
      throw new PostgresPersistenceError(code, "Community database request failed.", state);
    }
  }
}
