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
  const project = new URL(config.supabaseUrl);
  const storageKey = `companion-auth-${project.host.replace(/[^\w.-]/g, "-")}`;
  const options = {
    url: new URL("/auth/v1", project).toString(),
    headers: { apikey: config.publishableKey },
    detectSessionInUrl: false,
  };
  const auth = new AuthClient({
    ...options,
    storageKey,
    storage: web ? undefined : secureStorage,
    persistSession: true,
    autoRefreshToken: web,
  });
  // Some Supabase projects return a session from signUp. Keep that session out of
  // the login client's storage and cross-tab events, even when confirmation is off.
  const emailAuth = () => new AuthClient({
    ...options,
    storageKey: `${storageKey}-email`,
    persistSession: false,
    autoRefreshToken: false,
    skipAutoInitialize: true,
  });
  const session = new AccountSession({
    onAuthStateChange: listener => auth.onAuthStateChange(listener),
    getSession: () => auth.getSession(),
    refreshSession: () => auth.refreshSession(),
    signInWithPassword: credentials => auth.signInWithPassword(credentials),
    signUp: async credentials => {
      const { data: { user }, error } = await emailAuth().signUp(credentials);
      return { data: { user }, error };
    },
    resetPasswordForEmail: email => emailAuth().resetPasswordForEmail(email),
    signOut: options => auth.signOut(options),
  }, isAuthRetryableFetchError);

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

  return {
    session,
    observe,
    signUp: (email: string, password: string) => session.signUp(email, password),
    resetPasswordForEmail: (email: string) => session.resetPasswordForEmail(email),
  };
}
