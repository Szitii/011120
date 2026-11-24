/**
 * Companions connected to the Owner's own model key (BYOK) or own agent (EXTERNAL).
 *
 * BYOK: the platform writes the prompt as for its own models (persona, memories, chat rules) and
 * calls the Owner's provider with the Owner's key; nothing is booked in the platform's ledger.
 * EXTERNAL: the Owner's agent gets the conversation as chat messages and answers itself.
 * Every call goes through the SSRF guard (guard.ts). Companions without a connection use
 * `platform` (the platform's models, or the dev host's fake replies).
 *
 * The operators' kill switches stop these too: "all models off", or the provider `owner-key`
 * (every BYOK connection) or `owner-agent` (every EXTERNAL one).
 */
import { diaryPrompt, parsePost, parseReply, postPrompt, replyPrompt, agentMessages } from "../chat/prompt.ts";
import { memoriesOf } from "../chat/platform.ts";
import { readCompletion, type ModelResult } from "../chat/providers.ts";
import type { ChatClaim, ChatPort, DiaryJob, PostJob } from "../chat/port.ts";
import type { Answer, ChatModel, DiaryAnswer, PostAnswer } from "../chat/replies.ts";
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

/**
 * How to reach a Companion's model. `secret` is the key or token: in plain text after
 * checkConnection, sealed when stored (what connection_secret returns).
 */
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
const POST_TOKENS = 1_000;
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

type Message = { role: string; content: string };

/** One /chat/completions call; `secret` in plain text (empty: no Authorization header). */
const ask = (post: PostJson, connection: Connection, secret: string, messages: Message[], maxTokens: number, signal: AbortSignal,
  timeoutMs: number) => post(endpoint(connection), secret ? { authorization: `Bearer ${secret}` } : {},
  { ...(connection.model ? { model: connection.model } : {}), messages, max_tokens: maxTokens, stream: false }, { signal, timeoutMs });

async function complete(post: PostJson, connection: Connection, secret: string, messages: Message[], maxTokens: number,
  signal: AbortSignal): Promise<ModelResult> {
  const answer = await ask(post, connection, secret, messages, maxTokens, signal, CALL_TIMEOUT_MS);
  if (answer.status < 200 || answer.status > 299) throw new Error(`The connection answered HTTP ${answer.status}.`);
  if (answer.body === undefined) throw new Error("The connection did not answer in JSON.");
  return readCompletion(answer.body);
}

/** How a test went; `httpStatus` is what the other side answered with, when it answered at all. */
export interface ConnectionCheck { result: ConnectionTest; httpStatus?: number }

/** One tiny call, so only a connection that works is saved. */
export async function testConnection(connection: Connection, post: PostJson = createPostJson()): Promise<ConnectionCheck> {
  try {
    const answer = await ask(post, connection, connection.secret, [{ role: "user", content: "你好" }], 16,
      AbortSignal.timeout(TEST_TIMEOUT_MS), TEST_TIMEOUT_MS);
    const httpStatus = answer.status;
    if (httpStatus === 401 || httpStatus === 403) return { result: "AUTH_FAILED", httpStatus };
    if (httpStatus === 404) return { result: "NOT_FOUND", httpStatus };
    if (httpStatus < 200 || httpStatus > 299) return { result: "ERROR", httpStatus };
    const reply = readCompletion(answer.body);
    return { result: reply.text.trim() || reply.cutOff ? "CONNECTED" : "BAD_ANSWER", httpStatus };
  } catch (error) {
    return { result: error instanceof BlockedAddressError ? "BLOCKED_ADDRESS" : "UNREACHABLE" };
  }
}

/** The Companion's connection, null for the platform, or "DISABLED" when the operators switched it off. */
async function connectionOf(port: ChatPort, companionId: string): Promise<Connection | null | "DISABLED"> {
  const stored = await port.connection(companionId);
  if (stored === null) return null;
  const [on] = await port.modelsEnabled([{ provider: stored.kind === "BYOK" ? "owner-key" : "owner-agent", model: stored.model ?? "agent" }]);
  return on === true ? stored : "DISABLED";
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
    const stored = await connectionOf(context.port, companionId);
    if (stored === null) return this.#platform ? this.#platform.reply(turn, context) : { failed: "UNAVAILABLE" };
    if (stored === "DISABLED") return { failed: "DISABLED" };
    const secret = this.#box.open(stored.secret, companionId);
    const messages = stored.kind === "EXTERNAL" ? agentMessages(turn)
      : toMessages(replyPrompt(turn, await memoriesOf(context.port, companionId)));
    const result = await complete(this.#post, stored, secret, messages, REPLY_TOKENS, context.signal);
    if (result.refused) return { refused: true };
    if (result.cutOff) throw new Error("the reply was cut off");
    return parseReply(result.text, turn.companion.displayName);
  }

  async diary(job: DiaryJob, context: { port: ChatPort; signal: AbortSignal }): Promise<DiaryAnswer> {
    const companionId = job.companion.companionId;
    const stored = await connectionOf(context.port, companionId);
    if (stored === null) return this.#platform?.diary ? this.#platform.diary(job, context) : { failed: "UNAVAILABLE" };
    if (stored === "DISABLED") return { failed: "DISABLED" };
    const secret = this.#box.open(stored.secret, companionId);
    const prompt = diaryPrompt(job, stored.kind === "BYOK" ? await memoriesOf(context.port, companionId) : []);
    const result = await complete(this.#post, stored, secret, toMessages(prompt), DIARY_TOKENS, context.signal);
    if (result.refused) return { refused: true };
    if (result.cutOff) throw new Error("the entry was cut off");
    return { text: result.text };
  }

  /** A community post of its own: the same prompt for a key and an agent (an agent keeps its own memories). */
  async post(job: PostJob, context: { port: ChatPort; signal: AbortSignal }): Promise<PostAnswer> {
    const companionId = job.companion.companionId;
    const stored = await connectionOf(context.port, companionId);
    if (stored === null) return this.#platform?.post ? this.#platform.post(job, context) : { failed: "UNAVAILABLE" };
    if (stored === "DISABLED") return { failed: "DISABLED" };
    const secret = this.#box.open(stored.secret, companionId);
    const prompt = postPrompt(job, stored.kind === "BYOK" ? await memoriesOf(context.port, companionId) : []);
    const result = await complete(this.#post, stored, secret, toMessages(prompt), POST_TOKENS, context.signal);
    if (result.refused) return { refused: true };
    if (result.cutOff) throw new Error("the post was cut off");
    const text = parsePost(result.text);
    return text === null ? { pass: true } : { text };
  }
}

const toMessages = (prompt: { system: string; user: string }): Message[] =>
  [{ role: "system", content: prompt.system }, { role: "user", content: prompt.user }];

/**
 * What the connection routes need: the secret box, the test call, and a limit of 10 tests per
 * Owner per 10 minutes, so the test cannot be used to make this server call addresses in bulk.
 */
export class Connections {
  readonly box: SecretBox;
  readonly #test: (connection: Connection) => Promise<ConnectionCheck>;
  readonly #tests = new Map<string, number[]>();
  readonly #now: () => number;

  constructor(box: SecretBox, test: (connection: Connection) => Promise<ConnectionCheck> = c => testConnection(c), now = Date.now) {
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

  test(connection: Connection): Promise<ConnectionCheck> { return this.#test(connection); }
}

