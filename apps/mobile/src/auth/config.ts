export interface SupabaseConfig {
  supabaseUrl: string;
  publishableKey: string;
}

export type AuthenticatedClientConfig = SupabaseConfig & { baseUrl: string; dataMode: "real" };

export function readSupabaseConfig(env: NodeJS.ProcessEnv): SupabaseConfig {
  const supabaseUrl = env.EXPO_PUBLIC_SUPABASE_URL;
  const publishableKey = env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
  if (!supabaseUrl || !publishableKey) {
    throw new Error("Real mode requires EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY.");
  }
  requireSecureUrl(supabaseUrl, "EXPO_PUBLIC_SUPABASE_URL");
  return { supabaseUrl, publishableKey };
}

export function requireSecureUrl(value: string, name: string) {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(loopback && url.protocol === "http:"))
    || url.username || url.password) {
    throw new Error(`${name} must use HTTPS or local loopback.`);
  }
}
