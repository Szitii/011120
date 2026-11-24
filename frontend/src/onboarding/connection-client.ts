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
  | { status: "UNAVAILABLE"; message: string };

const missingIntegration: ConnectionResult = {
  status: "UNAVAILABLE",
  message: "服务端连接功能尚未接入。你可以先使用平台托管体验。",
};

function invalid(message: string): ConnectionResult {
  return { status: "INVALID", message };
}

function isHttps(value: string) {
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" && !!url.hostname && !url.username && !url.password &&
      !url.search && !url.hash && !/[\s\\]/.test(value.trim());
  } catch {
    return false;
  }
}

export function testAndEnableApiKey(input: ApiKeySetup): ConnectionResult {
  if (!input.provider) return invalid("请先选择服务商。");
  const baseUrl = input.provider === "custom" ? input.baseUrl : providerPresets[input.provider].baseUrl;
  if (!isHttps(baseUrl)) {
    return invalid("请输入有效的 HTTPS 接口地址，地址中请勿附带密钥或参数。");
  }
  if (!input.apiKey.trim() || /\s/.test(input.apiKey.trim())) return invalid("请粘贴完整的 API Key，密钥中不能有空格。");
  if (!input.model.trim() || /\s/.test(input.model.trim())) return invalid("请输入有效的模型名。");
  if (!input.consent) return invalid("请先阅读并确认隐私说明。");
  return missingIntegration;
}

export function testAndConnectExternal(input: ExternalSetup): ConnectionResult {
  if (!input.name.trim()) return invalid("请输入家机名称。");
  if (!isHttps(input.endpoint)) return invalid("请输入有效的 HTTPS 接口地址，地址中请勿附带密钥或参数。");
  if (/\s/.test(input.bearerToken.trim())) return invalid("请填写访问密钥本身，密钥中不能有空格。");
  if (!input.consent) return invalid("请先阅读并确认隐私说明。");
  return missingIntegration;
}

export function extendedImportAvailability(): ConnectionResult {
  return { status: "UNAVAILABLE", message: "Markdown 和纯文本记忆暂未接入审核。可以改用 JSON 角色卡，或填写名字和性格后开始。" };
}
