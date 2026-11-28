/**
 * The platform's model catalog: which models the Owner can pick, how to reach them, what they cost.
 *
 * It is a config file (backend/config/chat-models.json, or the path in CHAT_MODELS_FILE), so the
 * platform adds or removes a model without changing code. API keys never go in the file: each
 * provider names the environment variable that holds its key, and a model without a key is not
 * usable. The database's kill switches are checked separately, before every call.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface ProviderConfig {
  /** anthropic: the official Claude SDK. openai-compatible: the /chat/completions format most providers offer. */
  readonly kind: "anthropic" | "openai-compatible";
  /** openai-compatible only, e.g. https://api.deepseek.com/v1 */
  readonly baseUrl?: string;
  readonly apiKeyEnv: string;
  /**
   * A second key for the same provider, best from another account (a second key of one account
   * runs out of money together with the first). A call the first key cannot make is made with it.
   */
  readonly backupApiKeyEnv?: string;
}

export interface CatalogModel {
  /** What the Owner's setting stores. */
  readonly id: string;
  readonly name: string;
  readonly provider: string;
  /** The provider's own model name. */
  readonly model: string;
  readonly tier: "ECONOMY" | "STANDARD" | "PREMIUM";
  /** USD per million tokens. */
  readonly inputPerMTok: number;
  readonly outputPerMTok: number;
  readonly enabled: boolean;
  readonly options?: {
    /** anthropic: output_config.effort. */
    readonly effort?: "low" | "medium" | "high";
    /** Turn thinking off (only models that allow it): anthropic, and DeepSeek's OpenAI-format `thinking` field. */
    readonly thinking?: "disabled";
    /** anthropic: server-side fallback when a request is declined. */
    readonly fallbacks?: boolean;
    /** openai-compatible: some newer models want max_completion_tokens. */
    readonly maxTokensParam?: "max_tokens" | "max_completion_tokens";
    /**
     * The model can search the web by itself when a request declares the provider's own tool for it.
     * "deepseek": the server tool `deepseek_web_search` of DeepSeek's chat API (searching runs on
     * DeepSeek's side and is not billed; what it reads is billed as input tokens).
     */
    readonly webTools?: "deepseek";
  };
}

export interface CatalogFile {
  /** Used when a Companion has no model chosen. */
  readonly defaultModel: string;
  /** Cheap model for "should it speak?"; null: the reply model decides by itself. */
  readonly decisionModel: string | null;
  readonly providers: Readonly<Record<string, ProviderConfig>>;
  readonly models: readonly CatalogModel[];
}

/** Bump when prices change, so ledger rows say which prices they were charged at. */
export const PRICING_VERSION = "chat-pricing/1";
const DEFAULT_FILE = fileURLToPath(new URL("../../config/chat-models.json", import.meta.url));
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/;

const fail = (message: string): never => { throw new Error(`Chat model catalog: ${message}`); };

function check(file: CatalogFile): CatalogFile {
  if (!file || typeof file !== "object" || !Array.isArray(file.models) || !file.providers || typeof file.providers !== "object") {
    fail("needs providers and models.");
  }
  for (const [name, provider] of Object.entries(file.providers)) {
    if (provider.kind !== "anthropic" && provider.kind !== "openai-compatible") fail(`provider ${name} has an unknown kind.`);
    if (provider.kind === "openai-compatible" && !/^https:\/\/\S+$/.test(provider.baseUrl ?? "")) fail(`provider ${name} needs an https baseUrl.`);
    if (!/^[A-Z][A-Z0-9_]*$/.test(provider.apiKeyEnv ?? "")) fail(`provider ${name} needs apiKeyEnv, an environment variable name.`);
    if (provider.backupApiKeyEnv !== undefined && (!/^[A-Z][A-Z0-9_]*$/.test(provider.backupApiKeyEnv) || provider.backupApiKeyEnv === provider.apiKeyEnv)) {
      fail(`provider ${name} needs backupApiKeyEnv to be another environment variable name.`);
    }
  }
  const ids = new Set<string>();
  for (const model of file.models) {
    if (!ID.test(model.id ?? "") || ids.has(model.id)) fail(`model id ${model.id} is invalid or repeated.`);
    ids.add(model.id);
    if (!file.providers[model.provider]) fail(`model ${model.id} names an unknown provider.`);
    if (typeof model.name !== "string" || !model.name || typeof model.model !== "string" || !model.model) fail(`model ${model.id} needs name and model.`);
    if (!["ECONOMY", "STANDARD", "PREMIUM"].includes(model.tier)) fail(`model ${model.id} has an unknown tier.`);
    if (!(model.inputPerMTok >= 0) || !(model.outputPerMTok >= 0)) fail(`model ${model.id} needs prices.`);
    if (typeof model.enabled !== "boolean") fail(`model ${model.id} needs enabled.`);
    if (model.options?.webTools !== undefined && (model.options.webTools !== "deepseek" || file.providers[model.provider]!.kind !== "openai-compatible")) {
      fail(`model ${model.id} has webTools its provider cannot serve.`);
    }
  }
  if (!ids.has(file.defaultModel)) fail("defaultModel is not in models.");
  if (file.decisionModel !== null && !ids.has(file.decisionModel)) fail("decisionModel is not in models (use null for none).");
  return file;
}

export class ChatCatalog {
  readonly #file: CatalogFile;
  readonly #env: Readonly<Record<string, string | undefined>>;

  constructor(file: CatalogFile, env: Readonly<Record<string, string | undefined>> = process.env) {
    this.#file = check(file);
    this.#env = env;
  }

  /** Reads CHAT_MODELS_FILE or the default file; a broken file stops the server at start. */
  static load(env: Readonly<Record<string, string | undefined>> = process.env): ChatCatalog {
    return new ChatCatalog(JSON.parse(readFileSync(env.CHAT_MODELS_FILE ?? DEFAULT_FILE, "utf8")) as CatalogFile, env);
  }

  get models(): readonly CatalogModel[] { return this.#file.models; }

  provider(model: CatalogModel): ProviderConfig { return this.#file.providers[model.provider]!; }

  /** The keys configured for the model's provider: the first one, then the backup. None: the model cannot be called. */
  apiKeys(model: CatalogModel): string[] {
    const provider = this.provider(model);
    return [provider.apiKeyEnv, provider.backupApiKeyEnv].flatMap(name => {
      const key = name === undefined ? "" : this.#env[name]?.trim() ?? "";
      return key === "" ? [] : [key];
    });
  }

  /** Enabled in the file and a key is configured. (The database switches are checked per call.) */
  usable(model: CatalogModel): boolean { return model.enabled && this.apiKeys(model).length > 0; }

  /** Whether the Owner may store this id. */
  has(id: string): boolean { return this.#file.models.some(model => model.id === id); }

  /** The model to answer with: the chosen one if usable, else the default if usable. */
  pick(id: string | null): CatalogModel | undefined {
    const chosen = this.#file.models.find(model => model.id === id);
    if (chosen && this.usable(chosen)) return chosen;
    return this.defaultModel();
  }

  /** The configured default if usable, else the first usable model (e.g. only one provider has a key). */
  defaultModel(): CatalogModel | undefined {
    const model = this.#file.models.find(m => m.id === this.#file.defaultModel)!;
    return this.usable(model) ? model : this.#file.models.find(m => this.usable(m));
  }

  decisionModel(): CatalogModel | undefined {
    const model = this.#file.models.find(m => m.id === this.#file.decisionModel);
    return model && this.usable(model) ? model : undefined;
  }

  /** Cost in US cents, with fractions. The ledger counts whole cents; tokens are recorded exactly. */
  cost(model: CatalogModel, inputTokens: number, outputTokens: number): number {
    return (inputTokens * model.inputPerMTok + outputTokens * model.outputPerMTok) / 10_000;
  }
}
