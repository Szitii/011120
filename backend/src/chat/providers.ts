/**
 * Calls one catalog model with a system text and one user text, and reports the reply and usage.
 * Two ways in: the official Claude SDK, and the OpenAI-style /chat/completions format that most
 * other providers (OpenAI, DeepSeek, Qwen, Kimi, GLM, OpenRouter) accept.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { CatalogModel, ChatCatalog } from "./models.ts";

export interface ModelRequest {
  readonly system: string;
  readonly user: string;
  readonly maxTokens: number;
  readonly signal: AbortSignal;
  /** Let the model search the web for this answer, if it is a model that can (CatalogModel.options.webTools). */
  readonly web?: boolean;
}

export interface ModelResult {
  readonly text: string;
  /** All input tokens, cached or not. */
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** The provider declined for safety reasons. */
  readonly refused: boolean;
  /** The reply hit the token limit and is probably cut off mid-sentence. */
  readonly cutOff: boolean;
  /**
   * Only for a request that asked for the web on a model that has it: how many searches the provider
   * ran for this answer, or REFUSED when it would not take the tool and the answer was made without.
   */
  readonly web?: number | "REFUSED";
}

export type CallModel = (model: CatalogModel, request: ModelRequest) => Promise<ModelResult>;

/** The part of the Claude SDK this file uses; tests pass a stand-in. */
export type ClaudeClient = Pick<Anthropic, "beta">;

const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0);

async function callClaude(client: ClaudeClient, model: CatalogModel, request: ModelRequest): Promise<ModelResult> {
  const options = model.options ?? {};
  const message = await client.beta.messages.create({
    model: model.model,
    max_tokens: request.maxTokens,
    // No prompt caching: the system text is far below the smallest prefix Claude caches.
    system: request.system,
    messages: [{ role: "user", content: request.user }],
    ...(options.effort ? { output_config: { effort: options.effort } } : {}),
    ...(options.thinking === "disabled" ? { thinking: { type: "disabled" } } : {}),
    ...(options.fallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {}),
  }, { signal: request.signal });
  const usage = message.usage;
  return {
    text: message.content.flatMap(block => (block.type === "text" ? [block.text] : [])).join(""),
    inputTokens: count(usage.input_tokens),
    outputTokens: count(usage.output_tokens),
    refused: message.stop_reason === "refusal",
    cutOff: message.stop_reason === "max_tokens",
  };
}

/**
 * DeepSeek's own web search, declared as a tool: the model decides whether to search, and DeepSeek
 * runs the search (api-docs.deepseek.com/guides/web_tools). Its other tool, reading links, is left
 * out: it would open every link in the conversation again with every reply.
 */
const DEEPSEEK_WEB_TOOLS = [{ type: "deepseek_web_search" }];

async function callOpenAiCompatible(fetcher: typeof fetch, baseUrl: string, apiKey: string, model: CatalogModel,
  request: ModelRequest): Promise<ModelResult> {
  const web = request.web === true && model.options?.webTools === "deepseek";
  const post = (tools: boolean) => fetcher(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: model.model,
      messages: [{ role: "system", content: request.system }, { role: "user", content: request.user }],
      [model.options?.maxTokensParam ?? "max_tokens"]: request.maxTokens,
      // DeepSeek thinks by default; a chat reply does not need it (slower, and the thinking is paid output).
      ...(model.options?.thinking === "disabled" ? { thinking: { type: "disabled" } } : {}),
      ...(tools ? { tools: DEEPSEEK_WEB_TOOLS } : {}),
    }),
    signal: request.signal,
  });
  let response = await post(web);
  // The provider would not take the tool (it changed, or this model lost it): the Owner still gets an
  // answer, made without the web, and the result says so.
  const refused = web && response.status === 400;
  if (refused) response = await post(false);
  if (!response.ok) throw new Error(`${model.provider} answered HTTP ${response.status}`);
  const result = readCompletion(await response.json());
  return web ? { ...result, web: refused ? "REFUSED" : result.web ?? 0 } : result;
}

/** An OpenAI-style /chat/completions answer (also what Owners' own providers and agents return). */
export function readCompletion(answer: unknown): ModelResult {
  const body = (answer ?? {}) as {
    choices?: { message?: { content?: unknown }; finish_reason?: unknown }[];
    usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; server_tool_use?: { tool_search?: unknown } | null };
  };
  const choice = Array.isArray(body.choices) ? body.choices[0] : undefined;
  const searched = body.usage?.server_tool_use;
  return {
    text: typeof choice?.message?.content === "string" ? choice.message.content : "",
    inputTokens: count(body.usage?.prompt_tokens),
    outputTokens: count(body.usage?.completion_tokens),
    refused: choice?.finish_reason === "content_filter",
    cutOff: choice?.finish_reason === "length",
    // DeepSeek reports the searches it ran for the answer; other providers say nothing here.
    ...(searched && typeof searched === "object" ? { web: count(searched.tool_search) } : {}),
  };
}

/** One caller for the whole catalog. Claude clients are made once per key. */
export function createModelCaller(catalog: ChatCatalog, deps: {
  readonly fetch?: typeof fetch;
  readonly claude?: (apiKey: string) => ClaudeClient;
} = {}): CallModel {
  const fetcher = deps.fetch ?? fetch;
  const makeClaude = deps.claude ?? ((apiKey: string) => new Anthropic({ apiKey, maxRetries: 1 }));
  const clients = new Map<string, ClaudeClient>();
  return async (model, request) => {
    const apiKey = catalog.apiKey(model);
    if (apiKey === undefined) throw new Error(`no API key for ${model.provider}`);
    const provider = catalog.provider(model);
    if (provider.kind === "openai-compatible") return callOpenAiCompatible(fetcher, provider.baseUrl!, apiKey, model, request);
    let client = clients.get(apiKey);
    if (client === undefined) {
      client = makeClaude(apiKey);
      clients.set(apiKey, client);
    }
    return callClaude(client, model, request);
  };
}
