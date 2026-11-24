import type { ConnectionInput, ConnectionTest } from "../../../contracts/chat";

export const providerPresets = {
  deepseek: { label: "DeepSeek", model: "deepseek-chat", baseUrl: "https://api.deepseek.com/v1" },
  qwen: { label: "通义千问", model: "qwen-plus", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
  kimi: { label: "Kimi", model: "moonshot-v1-8k", baseUrl: "https://api.moonshot.cn/v1" },
  doubao: { label: "豆包", model: "doubao-seed-1-6-250615", baseUrl: "https://ark.cn-beijing.volces.com/api/v3" },
  glm: { label: "智谱 GLM", model: "glm-4-flash", baseUrl: "https://open.bigmodel.cn/api/paas/v4" },
  minimax: { label: "MiniMax", model: "MiniMax-M2.5", baseUrl: "https://api.minimaxi.com/v1" },
} as const;

export type ProviderId = keyof typeof providerPresets | "custom";
export type ApiKeySetup = {
  provider: ProviderId | "";
  baseUrl: string;
  apiKey: string;
  model: string;
  consent: boolean;
};
export type ExternalSetup = {
  name: string;
  endpoint: string;
  bearerToken: string;
  consent: boolean;
};

type ConnectionResult =
  | { status: "INVALID"; message: string }
  | { status: "UNAVAILABLE"; message: string }
  | { status: "READY"; input: ConnectionInput };

function invalid(message: string): ConnectionResult {
  return { status: "INVALID", message };
}

function isHttps(value: string) {
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" && !!url.hostname && !url.username && !url.password &&
      (!url.port || url.port === "443") && !url.search && !url.hash && !/[\s\\]/.test(value.trim());
  } catch {
    return false;
  }
}

export function validateApiKey(input: ApiKeySetup): ConnectionResult {
  if (!input.provider) return invalid("请先选择服务商。");
  const baseUrl = input.provider === "custom" ? input.baseUrl : providerPresets[input.provider].baseUrl;
  if (!isHttps(baseUrl)) {
    return invalid("请输入有效的 HTTPS 接口地址，地址中请勿附带密钥或参数。");
  }
  if (input.apiKey.trim().length < 8 || /\s/.test(input.apiKey.trim())) return invalid("请输入至少 8 位且不含空格的 API Key。");
  if (!input.model.trim() || /\s/.test(input.model.trim())) return invalid("请输入有效的模型名。");
  if (!input.consent) return invalid("请先阅读并确认隐私说明。");
  return { status: "READY", input: { kind: "BYOK", provider: input.provider, model: input.model.trim(),
    apiKey: input.apiKey.trim(), consent: true, ...(input.provider === "custom" ? { baseUrl: baseUrl.trim() } : {}) } };
}

export function validateExternal(input: ExternalSetup): ConnectionResult {
  if (!input.name.trim()) return invalid("请输入家机名称。");
  if (!isHttps(input.endpoint)) return invalid("请输入有效的 HTTPS 接口地址，地址中请勿附带密钥或参数。");
  if (input.bearerToken.trim() && (input.bearerToken.trim().length < 8 || /\s/.test(input.bearerToken.trim()))) return invalid("请填写访问密钥本身，密钥中不能有空格。");
  if (!input.consent) return invalid("请先阅读并确认隐私说明。");
  return { status: "READY", input: { kind: "EXTERNAL", name: input.name.trim(), endpoint: input.endpoint.trim(),
    bearerToken: input.bearerToken.trim(), consent: true } };
}

export function extendedImportAvailability() {
  return { status: "UNAVAILABLE", message: "Markdown 和纯文本记忆暂未接入审核。可以改用 JSON 角色卡，或填写名字和性格后开始。" };
}

export const connectionMessages: Record<ConnectionTest, string> = {
  CONNECTED: "已连接并保存。",
  AUTH_FAILED: "密钥被服务商拒绝，请检查后重试。",
  NOT_FOUND: "接口地址或模型名称有误。",
  UNREACHABLE: "暂时连不到服务端，请稍后再试。",
  BAD_ANSWER: "服务端回复格式不兼容。",
  BLOCKED_ADDRESS: "请使用可访问的公网 HTTPS 地址。",
  ERROR: "服务端暂时无法完成测试，请稍后再试。",
};
