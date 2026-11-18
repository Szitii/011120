import type { ClientApi } from "../contracts.ts";
import { MockApiAdapter } from "./mock-api.ts";
import { RealApiAdapter } from "./real-api.ts";

export interface ClientBootstrap {
  api: ClientApi;
  sample_companionCompanionId?: string;
  dataMode: "real" | "mock";
}

export function createClientBootstrap(env: NodeJS.ProcessEnv = process.env): ClientBootstrap {
  const mode = env.EXPO_PUBLIC_DATA_MODE === "mock" ? "mock" : "real";
  if (mode === "mock") return { api: new MockApiAdapter(), dataMode: "mock" };

  const baseUrl = env.EXPO_PUBLIC_API_BASE_URL;
  const bearerToken = env.EXPO_PUBLIC_OWNER_BEARER_TOKEN;
  if (!baseUrl || !bearerToken) {
    throw new Error("Real mode requires EXPO_PUBLIC_API_BASE_URL and EXPO_PUBLIC_OWNER_BEARER_TOKEN.");
  }
  const sample_companionCompanionId = env.EXPO_PUBLIC_SAMPLE_COMPANION_COMPANION_ID;
  return {
    api: new RealApiAdapter({ baseUrl, bearerToken }),
    dataMode: "real",
    ...(sample_companionCompanionId ? { sample_companionCompanionId } : {}),
  };
}
