import { PostgresPersistenceError, persistenceError, type SqlExecutor } from "../persistence/postgres/types.ts";
import type { ChatSettings, DiaryEntry, DiarySettings } from "../../../contracts/chat.ts";
import type { CompanionAction } from "../../../contracts/companion-actions.ts";
import type { Connection } from "../connections/model.ts";
import type {
  AgentScope, Booking, ChatClaim, ChatOutcome, ChatPort, ChatReservation, DiaryStart, MemoryNote, MemoryStart, PostOutcome, PostStart,
  ReachStart, ReminderChange, ReservationDecision,
} from "./port.ts";
import type { Clip } from "./voices.ts";

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

  saveAvatar(companionId: string | null, avatar: string | null): Promise<unknown> {
    return companionId === null ? this.#object("select public.owner_set_avatar($1) as payload", [avatar])
      : this.#object("select public.companion_set_avatar($1,$2) as payload", [companionId, avatar]);
  }

  deleteCompanion(companionId: string): Promise<unknown> {
    return this.#object("select public.companion_delete($1) as payload", [companionId]);
  }

  markRead(chatId: string, messageId: string): Promise<unknown> {
    return this.#object("select public.chat_mark_read($1,$2) as payload", [chatId, messageId]);
  }

  features(): Promise<unknown> {
    return this.#object("select public.platform_features() as payload", []);
  }

  wallet(): Promise<unknown> {
    return this.#object("select public.wallet_get() as payload", []);
  }

  feedback(): Promise<unknown> {
    return this.#object("select public.feedback_list() as payload", []);
  }

  sendFeedback(body: string, appVersion: string | null, platform: string | null, keyHash: string): Promise<unknown> {
    return this.#object("select public.feedback_send($1,$2,$3,$4) as payload", [body, appVersion, platform, keyHash]);
  }

  addFeedback(feedbackId: string, body: string, keyHash: string): Promise<unknown> {
    return this.#object("select public.feedback_add($1,$2,$3) as payload", [feedbackId, body, keyHash]);
  }

  readFeedback(feedbackId: string): Promise<unknown> {
    return this.#object("select public.feedback_read($1) as payload", [feedbackId]);
  }

  badges(): Promise<unknown> {
    return this.#object("select public.home_badges() as payload", []);
  }

  anniversary(companionId: string): Promise<unknown> {
    return this.#object("select public.anniversary_get($1) as payload", [companionId]);
  }

  saveAnniversary(companionId: string, startDate: string | null, timeZone: string, revision: number): Promise<unknown> {
    return this.#object("select public.anniversary_save($1,$2::date,$3,$4) as payload", [companionId, startDate, timeZone, revision]);
  }

  memories(companionId: string): Promise<unknown> {
    return this.#object("select public.memory_list($1) as payload", [companionId]);
  }

  persona(companionId: string): Promise<unknown> {
    return this.#object("select public.persona_get($1) as payload", [companionId]);
  }

  savePersona(companionId: string, version: number, fields: Readonly<Record<string, string>>): Promise<unknown> {
    return this.#object("select public.persona_save($1,$2,$3::jsonb) as payload", [companionId, version, JSON.stringify(fields)]);
  }

  addMemory(companionId: string, body: string, keyHash: string): Promise<unknown> {
    return this.#object("select public.memory_add($1,$2,$3) as payload", [companionId, body, keyHash]);
  }

  deleteMemory(companionId: string, memoryId: string): Promise<unknown> {
    return this.#object("select public.memory_delete($1,$2) as payload", [companionId, memoryId]);
  }

  worldEntries(companionId: string): Promise<unknown> {
    return this.#object("select public.world_list($1) as payload", [companionId]);
  }

  saveWorldEntry(companionId: string, entryId: string | null, keys: readonly string[], body: string, enabled: boolean): Promise<unknown> {
    return this.#object("select public.world_save($1,$2,$3::text[],$4,$5) as payload", [companionId, entryId, keys, body, enabled]);
  }

  deleteWorldEntry(companionId: string, entryId: string): Promise<unknown> {
    return this.#object("select public.world_delete($1,$2) as payload", [companionId, entryId]);
  }

  connectionView(companionId: string): Promise<unknown> {
    return this.#object("select public.connection_get($1) as payload", [companionId]);
  }

  saveConnection(companionId: string, c: Connection, hint: string): Promise<unknown> {
    return this.#object("select public.connection_save($1,$2,$3,$4,$5,$6,$7,$8) as payload",
      [companionId, c.kind, c.provider, c.baseUrl, c.model, c.name, c.secret, hint]);
  }

  createAgentKey(companionId: string, name: string, tokenHash: string, days: number, scopes: readonly AgentScope[]): Promise<unknown> {
    return this.#object("select public.agent_key_create($1,$2,$3,$4,$5::text[]) as payload", [companionId, name, tokenHash, days, scopes]);
  }

  agentKeys(companionId: string): Promise<unknown> {
    return this.#object("select public.agent_key_list($1) as payload", [companionId]);
  }

  revokeAgentKey(companionId: string, keyId: string): Promise<unknown> {
    return this.#object("select public.agent_key_revoke($1,$2) as payload", [companionId, keyId]);
  }

  removeConnection(companionId: string): Promise<unknown> {
    return this.#object("select public.connection_delete($1) as payload", [companionId]);
  }

  async connection(companionId: string): Promise<Connection | null> {
    const payload = await this.#payload("select public.connection_secret($1) as payload", [companionId]);
    return payload === null ? null : this.#check(payload) as Connection;
  }

  settings(companionId: string): Promise<unknown> {
    return this.#object("select public.chat_get_settings($1) as payload", [companionId]);
  }

  saveSettings(companionId: string, settings: ChatSettings): Promise<unknown> {
    return this.#object("select public.chat_update_settings($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) as payload",
      [companionId, settings.groupActivity, settings.companionInteraction, settings.model, settings.voice ?? null,
        settings.revision, settings.preferredUserTitle === undefined ? null : settings.preferredUserTitle ?? "", settings.autoMemory ?? null,
        settings.proactive ?? null, settings.replyRules === undefined ? null : JSON.stringify(settings.replyRules)]);
  }

  async claim(chatId: string): Promise<ChatClaim | null> {
    const payload = await this.#payload("select public.chat_claim($1) as payload", [chatId]);
    return payload === null ? null : this.#check(payload) as ChatClaim;
  }

  async finish(replyId: string, claimId: string, outcome: ChatOutcome, bodies: string[] | null,
    clips?: readonly (Clip | null)[], action?: CompanionAction, reminders?: ReminderChange): Promise<boolean> {
    const audio = clips === undefined || clips.every(clip => clip === null) ? null : JSON.stringify(clips.map(clip => clip === null ? null
      : { mime: clip.mime, durationMs: clip.durationMs, characters: clip.characters, data: Buffer.from(clip.bytes).toString("base64") }));
    const payload = await this.#object("select public.chat_finish($1,$2,$3,$4::text[],$5::jsonb,$6,$7::jsonb) as payload",
      [replyId, claimId, outcome, bodies, audio, action ?? null, reminders === undefined ? null : JSON.stringify(reminders)]);
    return (payload as { accepted?: unknown }).accepted === true;
  }

  async reachBegin(companionId: string): Promise<ReachStart> {
    return await this.#object("select public.chat_reach_begin($1) as payload", [companionId]) as ReachStart;
  }

  reminders(companionId: string): Promise<unknown> {
    return this.#object("select public.chat_reminder_list($1) as payload", [companionId]);
  }

  cancelReminder(companionId: string, reminderId: string): Promise<unknown> {
    return this.#object("select public.chat_reminder_cancel($1,$2) as payload", [companionId, reminderId]);
  }

  async voiceLeft(): Promise<{ companion: number; owner: number }> {
    const payload = await this.#object("select public.chat_voice_left() as payload", []) as { left?: unknown; ownerLeft?: unknown };
    const count = (value: unknown): number => (typeof value === "number" ? value : 0);
    return { companion: count(payload.left), owner: count(payload.ownerLeft) };
  }

  async voiceUsed(kind: "SPEAK" | "HEAR", amount: number): Promise<void> {
    await this.#payload("select public.voice_usage_add($1,$2) as payload", [kind, Math.max(0, Math.round(amount))]);
  }

  sendVoice(chatId: string, body: string, recording: { mime: string; durationMs: number; bytes: Uint8Array }, keyHash: string): Promise<unknown> {
    return this.#object("select public.chat_send_voice($1,$2,$3,$4::jsonb) as payload", [chatId, body, keyHash, JSON.stringify({
      mime: recording.mime, durationMs: recording.durationMs, data: Buffer.from(recording.bytes).toString("base64"),
    })]);
  }

  async audio(chatId: string, messageId: string): Promise<{ mime: string; bytes: Uint8Array }> {
    const payload = await this.#object("select public.chat_audio_get($1,$2) as payload", [chatId, messageId]) as { mime?: unknown; data?: unknown };
    if (typeof payload.mime !== "string" || typeof payload.data !== "string") {
      throw new PostgresPersistenceError("DATABASE_ERROR", "Invalid chat response.");
    }
    return { mime: payload.mime, bytes: Buffer.from(payload.data, "base64") };
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

  promptTexts(): Promise<unknown> {
    return this.#object("select public.prompt_texts() as payload", []);
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
    return this.#object("select public.diary_update_settings($1,$2,$3,$4) as payload",
      [companionId, settings.frequency, settings.autoWrite ?? null, settings.revision]);
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

  async postBegin(companionId: string): Promise<PostStart> {
    return await this.#object("select public.agent_auto_begin($1) as payload", [companionId]) as PostStart;
  }

  async postReserve(runId: string, claimId: string, b: Booking): Promise<ReservationDecision> {
    return await this.#object("select public.agent_auto_reserve($1,$2,$3,$4,$5,$6,$7,$8,$9) as payload", [
      runId, claimId, b.provider, b.model, b.pricingVersion, b.inputTokens, b.outputTokens, b.costMinor, runId,
    ]) as ReservationDecision;
  }

  async postFinish(runId: string, claimId: string, body: string | null, nothing: boolean): Promise<PostOutcome | null> {
    const payload = await this.#object("select public.agent_auto_finish($1,$2,$3,$4) as payload", [runId, claimId, body, nothing]);
    return (payload as { status?: PostOutcome }).status ?? null;
  }

  async memoryBegin(companionId: string): Promise<MemoryStart> {
    return await this.#object("select public.memory_auto_begin($1) as payload", [companionId]) as MemoryStart;
  }

  async memoryReserve(companionId: string, claimId: string, b: Booking): Promise<ReservationDecision> {
    return await this.#object("select public.memory_auto_reserve($1,$2,$3,$4,$5,$6,$7,$8,$9) as payload", [
      companionId, claimId, b.provider, b.model, b.pricingVersion, b.inputTokens, b.outputTokens, b.costMinor, claimId,
    ]) as ReservationDecision;
  }

  async memoryFinish(companionId: string, claimId: string, notes: readonly MemoryNote[] | null): Promise<{ accepted: boolean; added: number; replaced: number }> {
    const payload = await this.#object("select public.memory_auto_finish($1,$2,$3::text[],$4::uuid[]) as payload",
      [companionId, claimId, notes?.map(note => note.body) ?? null, notes?.map(note => note.replaces) ?? null]) as Record<string, unknown>;
    const count = (value: unknown): number => (typeof value === "number" ? value : 0);
    return { accepted: payload.accepted === true, added: count(payload.added), replaced: count(payload.replaced) };
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
