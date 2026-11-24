import { PostgresPersistenceError, persistenceError, type SqlExecutor } from "../persistence/postgres/types.ts";
import type { ChatSettings, DiaryEntry, DiarySettings } from "../../../contracts/chat.ts";
import type { CompanionAction } from "../../../contracts/companion-actions.ts";
import type { StoredConnection } from "../connections/model.ts";
import type { Booking, ChatClaim, ChatOutcome, ChatPort, ChatReservation, DiaryStart, ReservationDecision } from "./port.ts";

/** Uses the same authenticated transaction executor as the rest of the Owner API. */
export class PostgresChatAdapter implements ChatPort {
  readonly #executor: SqlExecutor;
  constructor(executor: SqlExecutor) { this.#executor = executor; }

  open(companionIds: string[], title: string | null, keyHash: string): Promise<unknown> {
    return this.#object("select public.chat_open($1::uuid[],$2,$3) as payload", [companionIds, title, keyHash]);
  }

  list(): Promise<unknown> {
    return this.#object("select public.chat_list() as payload", []);
  }

  read(chatId: string, beforeAt: string | null, beforeId: string | null): Promise<unknown> {
    return this.#object("select public.chat_read($1,$2,$3) as payload", [chatId, beforeAt, beforeId]);
  }

  send(chatId: string, body: string, mentions: string[], keyHash: string): Promise<unknown> {
    return this.#object("select public.chat_send($1,$2,$3::uuid[],$4) as payload", [chatId, body, mentions, keyHash]);
  }

  retry(chatId: string, messageId: string): Promise<unknown> {
    return this.#object("select public.chat_retry($1,$2) as payload", [chatId, messageId]);
  }

  act(companionId: string, action: CompanionAction, keyHash: string): Promise<unknown> {
    return this.#object("select public.chat_act($1,$2,$3) as payload", [companionId, action, keyHash]);
  }

  remove(chatId: string): Promise<unknown> {
    return this.#object("select public.chat_delete($1) as payload", [chatId]);
  }

  memories(companionId: string): Promise<unknown> {
    return this.#object("select public.memory_list($1) as payload", [companionId]);
  }

  addMemory(companionId: string, body: string, keyHash: string): Promise<unknown> {
    return this.#object("select public.memory_add($1,$2,$3) as payload", [companionId, body, keyHash]);
  }

  deleteMemory(companionId: string, memoryId: string): Promise<unknown> {
    return this.#object("select public.memory_delete($1,$2) as payload", [companionId, memoryId]);
  }

  connectionView(companionId: string): Promise<unknown> {
    return this.#object("select public.connection_get($1) as payload", [companionId]);
  }

  saveConnection(companionId: string, c: StoredConnection, hint: string): Promise<unknown> {
    return this.#object("select public.connection_save($1,$2,$3,$4,$5,$6,$7,$8) as payload",
      [companionId, c.kind, c.provider, c.baseUrl, c.model, c.name, c.secret, hint]);
  }

  removeConnection(companionId: string): Promise<unknown> {
    return this.#object("select public.connection_delete($1) as payload", [companionId]);
  }

  async connection(companionId: string): Promise<StoredConnection | null> {
    const payload = await this.#payload("select public.connection_secret($1) as payload", [companionId]);
    return payload === null ? null : this.#check(payload) as StoredConnection;
  }

  settings(companionId: string): Promise<unknown> {
    return this.#object("select public.chat_get_settings($1) as payload", [companionId]);
  }

  saveSettings(companionId: string, settings: ChatSettings): Promise<unknown> {
    return this.#object("select public.chat_update_settings($1,$2,$3,$4,$5) as payload",
      [companionId, settings.groupActivity, settings.companionInteraction, settings.model, settings.revision]);
  }

  async claim(chatId: string): Promise<ChatClaim | null> {
    const payload = await this.#payload("select public.chat_claim($1) as payload", [chatId]);
    return payload === null ? null : this.#check(payload) as ChatClaim;
  }

  async finish(replyId: string, claimId: string, outcome: ChatOutcome, bodies: string[] | null): Promise<boolean> {
    const payload = await this.#object("select public.chat_finish($1,$2,$3,$4::text[]) as payload", [replyId, claimId, outcome, bodies]);
    return (payload as { accepted?: unknown }).accepted === true;
  }

  async reserve(input: ChatReservation): Promise<ReservationDecision> {
    return await this.#object("select public.chat_reserve($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) as payload", [
      input.replyId, input.claimId, input.purpose, input.provider, input.model, input.pricingVersion,
      input.inputTokens, input.outputTokens, input.costMinor, input.traceId,
    ]) as ReservationDecision;
  }

  async settle(transactionId: string, inputTokens: number, outputTokens: number, costMinor: number, ok: boolean): Promise<void> {
    await this.#object("select public.chat_settle($1,$2,$3,$4,$5) as payload", [transactionId, inputTokens, outputTokens, costMinor, ok]);
  }

  async modelsEnabled(models: readonly { provider: string; model: string }[]): Promise<boolean[]> {
    const payload = await this.#payload("select public.chat_models_enabled($1::text[],$2::text[]) as payload",
      [models.map(m => m.provider), models.map(m => m.model)]);
    if (!Array.isArray(payload) || payload.some(value => typeof value !== "boolean")) {
      throw new PostgresPersistenceError("DATABASE_ERROR", "Invalid chat response.");
    }
    return payload as boolean[];
  }

  diary(companionId: string, beforeAt: string | null, beforeId: string | null): Promise<unknown> {
    return this.#object("select public.diary_list($1,$2,$3) as payload", [companionId, beforeAt, beforeId]);
  }

  deleteDiary(companionId: string, entryId: string): Promise<unknown> {
    return this.#object("select public.diary_delete($1,$2) as payload", [companionId, entryId]);
  }

  diarySettings(companionId: string): Promise<unknown> {
    return this.#object("select public.diary_get_settings($1) as payload", [companionId]);
  }

  saveDiarySettings(companionId: string, settings: DiarySettings): Promise<unknown> {
    return this.#object("select public.diary_update_settings($1,$2,$3) as payload", [companionId, settings.frequency, settings.revision]);
  }

  async diaryBegin(companionId: string): Promise<DiaryStart> {
    return await this.#object("select public.diary_begin($1) as payload", [companionId]) as DiaryStart;
  }

  async diaryReserve(entryId: string, claimId: string, b: Booking): Promise<ReservationDecision> {
    return await this.#object("select public.diary_reserve($1,$2,$3,$4,$5,$6,$7,$8,$9) as payload", [
      entryId, claimId, b.provider, b.model, b.pricingVersion, b.inputTokens, b.outputTokens, b.costMinor, entryId,
    ]) as ReservationDecision;
  }

  async diaryFinish(entryId: string, claimId: string, body: string | null): Promise<DiaryEntry | null> {
    const payload = await this.#object("select public.diary_finish($1,$2,$3) as payload", [entryId, claimId, body]);
    return (payload as { entry?: DiaryEntry | null }).entry ?? null;
  }

  async #object(sql: string, values: readonly unknown[]): Promise<unknown> {
    return this.#check(await this.#payload(sql, values));
  }

  async #payload(sql: string, values: readonly unknown[]): Promise<unknown> {
    const result = await this.#executor.query(sql, values).catch((error: unknown) => { throw persistenceError(error); });
    if (result.rows.length !== 1) throw new PostgresPersistenceError("DATABASE_ERROR", "Invalid chat response.");
    return result.rows[0]!.payload ?? null;
  }

  #check(payload: unknown): unknown {
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      throw new PostgresPersistenceError("DATABASE_ERROR", "Invalid chat response.");
    }
    return payload;
  }
}
