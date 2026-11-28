import type { CompanionIdentity, ImportReview } from "../../companion-import/types.ts";
import type {
  ActiveIdentityContextView,
  CompanionProfileView,
  ControlsResourceView,
  LifeContinuityCollectionView,
  LifeContinuityItemView,
  LifeEventInboxCollectionView,
  LifeEventInboxItemView,
  OwnerApiPort,
  OwnerCompanionSummaryView,
  ProjectionResultView,
  WorldCollectionView,
  WorldItemView,
} from "../../http/types.ts";
import { PostgresPersistenceError, persistenceError, type SqlExecutor } from "./types.ts";

type Row = Record<string, unknown>;

// Every read function returns a JSON payload built by the database; it is only checked to be an object.
const invalid = (name: string): never => {
  throw new PostgresPersistenceError("DATABASE_ERROR", `Invalid ${name} returned by PostgreSQL.`);
};
const record = (value: unknown, name: string): Row =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Row) : invalid(name);
const json = <T>(row: Row, key: "payload" | "item"): T => record(row[key], key) as unknown as T;

// The only place that touches the executor: one fixed, parameterized statement per call.
async function rows(executor: SqlExecutor, sql: string, values: readonly unknown[]): Promise<readonly Row[]> {
  try {
    return (await executor.query<Row>(sql, values)).rows;
  } catch (error) {
    throw persistenceError(error);
  }
}
const first = async (executor: SqlExecutor, sql: string, values: readonly unknown[]): Promise<Row | undefined> =>
  (await rows(executor, sql, values))[0];
async function one(executor: SqlExecutor, sql: string, values: readonly unknown[]): Promise<Row> {
  const result = await rows(executor, sql, values);
  if (result.length !== 1) {
    throw new PostgresPersistenceError("DATABASE_ERROR", "PostgreSQL command returned an unexpected row count.");
  }
  return result[0]!;
}

const page = <T, C>(items: readonly T[], limit: number, cursor: (last: T) => C) => {
  const last = items.at(-1);
  const nextCursor = items.length === limit && last !== undefined ? cursor(last) : null;
  return { items: Object.freeze(items), nextCursor };
};

export class PostgresOwnerAdapter implements OwnerApiPort {
  readonly #executor: SqlExecutor;

  constructor(executor: SqlExecutor) {
    this.#executor = executor;
  }

  async getIdentityContext(
    input?: Parameters<OwnerApiPort["getIdentityContext"]>[0],
  ): Promise<ActiveIdentityContextView> {
    const r = await one(this.#executor, "select * from public.get_active_identity_context($1,$2)", [
      input?.activeSubjectKind ?? "OWNER", input?.activeSubjectId ?? null,
    ]);
    return json<ActiveIdentityContextView>(r, "payload");
  }

  async listOwnerCompanions(): Promise<readonly OwnerCompanionSummaryView[]> {
    const result = await rows(this.#executor, "select * from public.list_owner_companions()", []);
    return Object.freeze(result.map((r) => json<OwnerCompanionSummaryView>(r, "item")));
  }

  async listWorldItems(limit: number, beforeCreatedAt?: string): Promise<WorldCollectionView> {
    const result = await rows(this.#executor, "select * from public.list_world_items($1,$2)", [
      limit, beforeCreatedAt ?? null,
    ]);
    return page(result.map((r) => json<WorldItemView>(r, "item")), limit, (last) => last.publishedAt);
  }

  async listLifeContinuity(
    limit: number,
    viewer?: Parameters<OwnerApiPort["listLifeContinuity"]>[1],
    before?: Parameters<OwnerApiPort["listLifeContinuity"]>[2],
  ): Promise<LifeContinuityCollectionView> {
    const result = await rows(this.#executor, "select * from public.list_life_continuity($1,$2,$3,$4,$5)", [
      viewer?.activeSubjectKind ?? "OWNER", viewer?.activeSubjectId ?? null, limit,
      before?.occurredAt ?? null, before?.id ?? null,
    ]);
    return page(result.map((r) => json<LifeContinuityItemView>(r, "item")), limit, (last) => ({
      beforeOccurredAt: last.occurredAt,
      beforeId: last.id,
    }));
  }

  async getCompanionProfile(
    companionId: string,
    viewer?: Parameters<OwnerApiPort["getCompanionProfile"]>[1],
  ): Promise<CompanionProfileView | undefined> {
    const r = await first(this.#executor, "select * from public.get_companion_profile($1,$2,$3)", [
      companionId, viewer?.activeSubjectKind ?? "OWNER", viewer?.activeSubjectId ?? null,
    ]);
    return r && json<CompanionProfileView>(r, "payload");
  }

  async listLifeEventInbox(
    limit: number,
    before?: Parameters<OwnerApiPort["listLifeEventInbox"]>[1],
  ): Promise<LifeEventInboxCollectionView> {
    const result = await rows(this.#executor, "select * from public.list_life_event_inbox($1,$2,$3)", [
      limit, before?.createdAt ?? null, before?.id ?? null,
    ]);
    return page(result.map((r) => json<LifeEventInboxItemView>(r, "item")), limit, (last) => ({
      beforeCreatedAt: last.createdAt,
      beforeId: last.id,
    }));
  }

  async acknowledgeLifeEvent(itemId: string): Promise<LifeEventInboxItemView | undefined> {
    const r = await first(this.#executor, "select * from public.ack_life_event_inbox_item($1)", [itemId]);
    return r && json<LifeEventInboxItemView>(r, "item");
  }

  async readLifeEventInbox(before: string | null): Promise<{ readonly read: number }> {
    return json(await one(this.#executor, "select public.read_life_event_inbox($1) as payload", [before]), "payload");
  }

  async getControls(companionId: string): Promise<ControlsResourceView | undefined> {
    const r = await first(this.#executor, "select * from public.get_companion_controls($1)", [companionId]);
    return r && json<ControlsResourceView>(r, "payload");
  }

  async updateControls(
    input: Parameters<OwnerApiPort["updateControls"]>[0],
  ): Promise<ControlsResourceView | undefined> {
    const r = await first(this.#executor, "select * from public.update_companion_controls($1,$2,$3,$4,$5)", [
      input.companionId, input.ifMatch, input.patch, input.idempotencyKeyHash, input.requestHash,
    ]);
    return r && json<ControlsResourceView>(r, "payload");
  }

  async createCompanionImport(input: Parameters<OwnerApiPort["createCompanionImport"]>[0]): Promise<ImportReview> {
    const r = await one(
      this.#executor,
      "select * from public.create_companion_import($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10)",
      [
        input.rawPayload, input.originalSha256, input.byteLength, input.parserVersion, input.policyVersion,
        input.sourceFormat, JSON.stringify(input.draft), JSON.stringify(input.findings),
        input.idempotencyKeyHash, input.requestHash,
      ],
    );
    return json<ImportReview>(r, "payload");
  }

  async getCompanionImportReview(importId: string): Promise<ImportReview | undefined> {
    const r = await first(this.#executor, "select * from public.get_companion_import_review($1)", [importId]);
    return r && json<ImportReview>(r, "payload");
  }

  async projectAndActivateSocialTwin(
    input: Parameters<OwnerApiPort["projectAndActivateSocialTwin"]>[0],
  ): Promise<ProjectionResultView> {
    const r = await one(
      this.#executor,
      "select * from public.project_and_activate_social_twin($1,$2,$3,$4,$5,$6::jsonb,$7,$8)",
      [
        input.companionId, input.sourceIdentityVersionId, input.handle, input.profileVisibility, input.autonomyMode,
        JSON.stringify(input.selections), input.idempotencyKeyHash, input.requestHash,
      ],
    );
    return json<ProjectionResultView>(r, "payload");
  }

  async approveCompanionImport(
    input: Parameters<OwnerApiPort["approveCompanionImport"]>[0],
  ): Promise<CompanionIdentity> {
    const r = await one(this.#executor, "select * from public.approve_companion_import($1,$2,$3,$4,$5)", [
      input.importId, [...input.approvedCandidateIds], input.companionId ?? null,
      input.idempotencyKeyHash, input.requestHash,
    ]);
    return json<CompanionIdentity>(r, "payload");
  }
}
