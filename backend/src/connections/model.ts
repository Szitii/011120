/**
 * Companions connected to the Owner's own model key (BYOK) or own agent (EXTERNAL).
 *
 * BYOK: the platform writes the prompt as for its own models (persona, memories, chat rules) and
 * calls the Owner's provider with the Owner's key; nothing is booked in the platform's ledger.
 * EXTERNAL: the Owner's agent gets the conversation as chat messages and answers itself.
 * Every call goes through the SSRF guard (guard.ts). Companions without a connection use
 * `platform` (the platform's models, or the dev host's fake replies).
 */
import { diaryPrompt, parseReply, replyPrompt, agentMessages } from "../chat/prompt.ts";
import { readCompletion, type ModelResult } from "../chat/providers.ts";
import type { ChatClaim, ChatPort, DiaryJob } from "../chat/port.ts";
import type { Answer, ChatModel, DiaryAnswer } from "../chat/replies.ts";
import type { ConnectionInput, ConnectionTest } from "../../../contracts/chat.ts";
import { BlockedAddressError, checkUrl, createPostJson, type PostJson } from "./guard.ts";
import type { SecretBox } from "./secret-box.ts";

/** The providers the app offers; their API base is fixed here, not taken from the app. */
export const PROVIDERS: Readonly<Record<string, string>> = {
  deepseek: "https://api.deepseek.com/v1",
  qwen: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  kimi: "https://api.moonshot.cn/v1",
  doubao: "https://ark.cn-beijing.volces.com/api/v3",
  glm: "https://open.bigmodel.cn/api/paas/v4",
  minimax: "https://api.minimaxi.com/v1",
};

/** What connection_secret returns: how to reach the Companion's model, with the sealed key. */
export interface StoredConnection {
  kind: "BYOK" | "EXTERNAL";
  provider: string | null;
  baseUrl: string;
  model: string | null;
  name: string | null;
  secret: string;
}

/** A checked connection, ready to test and save (`secret` still in plain text). */
export interface Connection {
  kind: "BYOK" | "EXTERNAL";
  provider: string | null;
  baseUrl: string;
  model: string | null;
  name: string | null;
  secret: string;
}

const REPLY_TOKENS = 2_000;
const DIARY_TOKENS = 2_000;
const TEST_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 90_000;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/;
/** A key or token: 8 to 512 printable characters, no spaces. */
const SECRET = /^[\x21-\x7e]{8,512}$/;

/** The endpoint a connection posts to: BYOK adds /chat/completions to the API base; EXTERNAL is the endpoint itself. */
function endpoint(connection: { kind: string; baseUrl: string }): URL {
  const url = checkUrl(connection.kind === "BYOK" ? `${connection.baseUrl.replace(/\/$/, "")}/chat/completions` : connection.baseUrl);
  if (typeof url === "string") throw new BlockedAddressError();
  return url;
}

/** Checks what the app sent; the reason when it cannot be used. */
export function checkConnection(input: ConnectionInput): Connection | "INVALID_INPUT" | "INVALID_URL" | "BLOCKED_ADDRESS" {
  if (input.consent !== true) return "INVALID_INPUT";
  if (input.kind === "BYOK") {
    const custom = input.provider === "custom";
    const base = custom ? input.baseUrl : PROVIDERS[input.provider];
    if (base === undefined || typeof base !== "string" || !MODEL.test(input.model) || !SECRET.test(input.apiKey)) return "INVALID_INPUT";
    const url = checkUrl(base);
    if (typeof url === "string") return url;
    const baseUrl = url.href.replace(/\/$/, "");
    return { kind: "BYOK", provider: input.provider, baseUrl, model: input.model, name: null, secret: input.apiKey };
  }
  const name = input.name.trim();
  if (Array.from(name).length < 1 || Array.from(name).length > 40 || !(input.bearerToken === "" || SECRET.test(input.bearerToken))
    || !(input.model === undefined || input.model === null || MODEL.test(input.model))) return "INVALID_INPUT";
  const url = checkUrl(input.endpoint);
  if (typeof url === "string") return url;
  return { kind: "EXTERNAL", provider: null, baseUrl: url.href, model: input.model ?? null, name, secret: input.bearerToken };
}

async function complete(post: PostJson, connection: { kind: string; baseUrl: string; model: string | null }, secret: string,
  messages: { role: string; content: string }[], maxTokens: number, signal: AbortSignal, timeoutMs: number): Promise<ModelResult> {
  const answer = await post(endpoint(connection), secret ? { authorization: `Bearer ${secret}` } : {},
    { ...(connection.model ? { model: connection.model } : {}), messages, max_tokens: maxTokens, stream: false }, { signal, timeoutMs });
  if (answer.status < 200 || answer.status > 299) throw new Error(`The connection answered HTTP ${answer.status}.`);
  if (answer.body === undefined) throw new Error("The connection did not answer in JSON.");
  return readCompletion(answer.body);
}

/** One tiny call, so only a connection that works is saved. */
export async function testConnection(connection: Connection, post: PostJson = createPostJson()): Promise<ConnectionTest> {
  try {
    const answer = await post(endpoint(connection), connection.secret ? { authorization: `Bearer ${connection.secret}` } : {},
      { ...(connection.model ? { model: connection.model } : {}), messages: [{ role: "user", content: "你好" }], max_tokens: 16, stream: false },
      { signal: AbortSignal.timeout(TEST_TIMEOUT_MS), timeoutMs: TEST_TIMEOUT_MS });
    if (answer.status === 401 || answer.status === 403) return "AUTH_FAILED";
    if (answer.status === 404) return "NOT_FOUND";
    if (answer.status < 200 || answer.status > 299) return "ERROR";
    const reply = readCompletion(answer.body);
    return reply.text.trim() || reply.cutOff ? "CONNECTED" : "BAD_ANSWER";
  } catch (error) {
    return error instanceof BlockedAddressError ? "BLOCKED_ADDRESS" : "UNREACHABLE";
  }
}

export class ConnectedChatModel implements ChatModel {
  readonly #platform: ChatModel | undefined;
  readonly #box: SecretBox;
  readonly #post: PostJson;

  constructor(platform: ChatModel | undefined, box: SecretBox, post: PostJson = createPostJson()) {
    this.#platform = platform;
    this.#box = box;
    this.#post = post;
  }

  async reply(turn: ChatClaim, context: { port: ChatPort; signal: AbortSignal }): Promise<Answer> {
    const companionId = turn.companion.companionId;
    const stored = await context.port.connection(companionId);
    if (stored === null) return this.#platform ? this.#platform.reply(turn, context) : { failed: "UNAVAILABLE" };
    const secret = this.#box.open(stored.secret, companionId);
    const messages = stored.kind === "EXTERNAL" ? agentMessages(turn)
      : toMessages(replyPrompt(turn, await memoriesOf(context.port, companionId)));
    const result = await complete(this.#post, stored, secret, messages, REPLY_TOKENS, context.signal, CALL_TIMEOUT_MS);
    if (result.refused) return { refused: true };
    if (result.cutOff) throw new Error("the reply was cut off");
    return parseReply(result.text, turn.companion.displayName);
  }

  async diary(job: DiaryJob, context: { port: ChatPort; signal: AbortSignal }): Promise<DiaryAnswer> {
    const companionId = job.companion.companionId;
    const stored = await context.port.connection(companionId);
    if (stored === null) {
      return this.#platform?.diary ? this.#platform.diary(job, context) : { failed: "UNAVAILABLE" };
    }
    const secret = this.#box.open(stored.secret, companionId);
    const prompt = diaryPrompt(job, stored.kind === "BYOK" ? await memoriesOf(context.port, companionId) : []);
    const result = await complete(this.#post, stored, secret, toMessages(prompt), DIARY_TOKENS, context.signal, CALL_TIMEOUT_MS);
    if (result.refused) return { refused: true };
    if (result.cutOff) throw new Error("the entry was cut off");
    return { text: result.text };
  }
}

const toMessages = (prompt: { system: string; user: string }) =>
  [{ role: "system", content: prompt.system }, { role: "user", content: prompt.user }];

async function memoriesOf(port: ChatPort, companionId: string): Promise<string[]> {
  const list = await port.memories(companionId) as { items?: { body?: unknown }[] };
  return (list.items ?? []).flatMap(memory => (typeof memory.body === "string" ? [memory.body] : []));
}

/**
 * What the connection routes need: the secret box, the test call, and a limit of 10 tests per
 * Owner per 10 minutes, so the test cannot be used to make this server call addresses in bulk.
 */
export class Connections {
  readonly box: SecretBox;
  readonly #test: (connection: Connection) => Promise<ConnectionTest>;
  readonly #tests = new Map<string, number[]>();
  readonly #now: () => number;

  constructor(box: SecretBox, test: (connection: Connection) => Promise<ConnectionTest> = c => testConnection(c), now = Date.now) {
    this.box = box;
    this.#test = test;
    this.#now = now;
  }

  /** False when the Owner tested too often; otherwise counts this test. */
  allow(ownerId: string): boolean {
    const now = this.#now();
    const recent = (this.#tests.get(ownerId) ?? []).filter(at => at > now - 600_000);
    if (recent.length >= 10) { this.#tests.set(ownerId, recent); return false; }
    recent.push(now);
    this.#tests.set(ownerId, recent);
    return true;
  }

  test(connection: Connection): Promise<ConnectionTest> { return this.#test(connection); }
}

