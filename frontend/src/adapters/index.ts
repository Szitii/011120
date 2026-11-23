import type { ClientApi } from "../contracts.ts";
import { readSupabaseConfig, requireSecureUrl, type AuthenticatedClientConfig } from "../auth/config.ts";
import { MockApiAdapter } from "./mock-api.ts";
import { RealApiAdapter } from "./real-api.ts";

export interface ClientBootstrap {
  api: ClientApi;
  sample_companionCompanionId?: string;
}

export function createClientBootstrap(env: Readonly<Record<string, string | undefined>> = {
  // Expo statically substitutes direct public env access in exported bundles.
  EXPO_PUBLIC_DATA_MODE: process.env.EXPO_PUBLIC_DATA_MODE,
  EXPO_PUBLIC_API_BASE_URL: process.env.EXPO_PUBLIC_API_BASE_URL,
  EXPO_PUBLIC_OWNER_BEARER_TOKEN: process.env.EXPO_PUBLIC_OWNER_BEARER_TOKEN,
  EXPO_PUBLIC_SAMPLE_COMPANION_COMPANION_ID: process.env.EXPO_PUBLIC_SAMPLE_COMPANION_COMPANION_ID,
  EXPO_PUBLIC_SUPABASE_URL: process.env.EXPO_PUBLIC_SUPABASE_URL,
  EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
}): (ClientBootstrap & { dataMode: "dev" | "mock" }) | AuthenticatedClientConfig {
  const mode = env.EXPO_PUBLIC_DATA_MODE ?? "real";
  if (mode === "mock") return { api: new MockApiAdapter(), dataMode: "mock" };
  if (mode !== "real" && mode !== "dev") throw new Error("Invalid EXPO_PUBLIC_DATA_MODE.");

  const baseUrl = env.EXPO_PUBLIC_API_BASE_URL;
  if (!baseUrl) throw new Error("EXPO_PUBLIC_API_BASE_URL is required.");
  if (mode === "real") {
    requireSecureUrl(baseUrl, "EXPO_PUBLIC_API_BASE_URL");
    return { baseUrl, dataMode: "real", ...readSupabaseConfig(env) };
  }

  const bearerToken = env.EXPO_PUBLIC_OWNER_BEARER_TOKEN;
  if (!bearerToken) throw new Error("Dev mode requires EXPO_PUBLIC_OWNER_BEARER_TOKEN.");
  return {
    api: new RealApiAdapter({ baseUrl, bearerToken }),
    dataMode: "dev",
    sample_companionCompanionId: env.EXPO_PUBLIC_SAMPLE_COMPANION_COMPANION_ID,
  };
}
