import "react-native-url-polyfill/auto";
import { AuthClient, isAuthRetryableFetchError } from "@supabase/auth-js";
import * as SecureStore from "expo-secure-store";
import { AppState, Platform } from "react-native";
import { AccountSession } from "./account-session.ts";
import type { SupabaseConfig } from "./config.ts";

const secureOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

const secureStorage = {
  getItem: (key: string) => SecureStore.getItemAsync(key, secureOptions),
  setItem: (key: string, value: string) => SecureStore.setItemAsync(key, value, secureOptions),
  removeItem: (key: string) => SecureStore.deleteItemAsync(key, secureOptions),
};

export function createSupabaseAccount(config: SupabaseConfig) {
  const web = Platform.OS === "web";
  const auth = new AuthClient({
    url: new URL("/auth/v1", config.supabaseUrl).toString(),
    headers: { apikey: config.publishableKey },
    storageKey: `companion-auth-${new URL(config.supabaseUrl).host.replace(/[^\w.-]/g, "-")}`,
    storage: web ? undefined : secureStorage,
    persistSession: true,
    autoRefreshToken: web,
    detectSessionInUrl: false,
  });
  const session = new AccountSession(auth, isAuthRetryableFetchError);

  function observe() {
    const stop = session.observe();
    if (web) return stop;
    const updateRefresh = (state: string) => {
      if (state === "active") void auth.startAutoRefresh();
      else void auth.stopAutoRefresh();
    };
    if (AppState.currentState) updateRefresh(AppState.currentState);
    const subscription = AppState.addEventListener("change", updateRefresh);
    return () => {
      stop();
      subscription.remove();
      void auth.stopAutoRefresh();
    };
  }

  return { session, observe };
}
