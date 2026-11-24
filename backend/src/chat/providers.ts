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

async function callOpenAiCompatible(fetcher: typeof fetch, baseUrl: string, apiKey: string, model: CatalogModel,
  request: ModelRequest): Promise<ModelResult> {
  const response = await fetcher(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: model.model,
      messages: [{ role: "system", content: request.system }, { role: "user", content: request.user }],
      [model.options?.maxTokensParam ?? "max_tokens"]: request.maxTokens,
    }),
    signal: request.signal,
  });
  if (!response.ok) throw new Error(`${model.provider} answered HTTP ${response.status}`);
  return readCompletion(await response.json());
}

/** An OpenAI-style /chat/completions answer (also what Owners' own providers and agents return). */
export function readCompletion(answer: unknown): ModelResult {
  const body = (answer ?? {}) as {
    choices?: { message?: { content?: unknown }; finish_reason?: unknown }[];
    usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
  };
  const choice = Array.isArray(body.choices) ? body.choices[0] : undefined;
  return {
    text: typeof choice?.message?.content === "string" ? choice.message.content : "",
    inputTokens: count(body.usage?.prompt_tokens),
    outputTokens: count(body.usage?.completion_tokens),
    refused: choice?.finish_reason === "content_filter",
    cutOff: choice?.finish_reason === "length",
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
