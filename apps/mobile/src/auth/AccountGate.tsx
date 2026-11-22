import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { ActivityIndicator, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput } from "react-native";
import { StatusBar } from "expo-status-bar";
import { colors } from "../theme";
import type { AccountBinding, AccountView } from "./account-session";
import type { SupabaseConfig } from "./config";
import { createSupabaseAccount } from "./supabase";

export function AccountGate({ config, children }: {
  config: SupabaseConfig;
  children: (account: AccountBinding, onSignOut: () => void) => ReactNode;
}) {
  const [auth] = useState(() => createSupabaseAccount(config));
  const state = useSyncExternalStore(auth.session.subscribe, auth.session.snapshot);
  useEffect(auth.observe, [auth]);
  const signOut = () => { void auth.session.signOut(); };

  if (state.kind === "signed-in") return children(state.account, signOut);
  return <SignInScreen state={state} onSignIn={(email, password) => void auth.session.signIn(email, password)}
    onRetrySignOut={signOut} />;
}

function SignInScreen({ state, onSignIn, onRetrySignOut }: {
  state: Exclude<AccountView, { kind: "signed-in" }>;
  onSignIn: (email: string, password: string) => void;
  onRetrySignOut: () => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const formVisible = state.kind === "signed-out" || state.kind === "signing-in";
  const canSubmit = state.kind === "signed-out" && !!email.trim() && !!password;

  function submit() {
    if (!canSubmit) return;
    onSignIn(email, password);
    setPassword("");
  }

  return <SafeAreaView style={styles.safe}>
    <StatusBar style="dark" />
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.layout}>
      {formVisible ? <>
        <Text accessibilityRole="header" style={styles.title}>登录家机社区</Text>
        <Text style={styles.label}>邮箱</Text>
        <TextInput accessibilityLabel="邮箱" autoCapitalize="none" autoCorrect={false}
          autoComplete="email" keyboardType="email-address" editable={state.kind === "signed-out"}
          value={email} onChangeText={setEmail} style={styles.input} />
        <Text style={styles.label}>密码</Text>
        <TextInput accessibilityLabel="密码" autoCapitalize="none" autoComplete="current-password"
          secureTextEntry editable={state.kind === "signed-out"} onSubmitEditing={submit}
          value={password} onChangeText={setPassword} style={styles.input} />
        {state.kind === "signed-out" && state.message && (
          <Text accessibilityRole="alert" style={styles.message}>{state.message}</Text>
        )}
        <Pressable accessibilityRole="button" accessibilityState={{ disabled: !canSubmit }}
          disabled={!canSubmit} style={[styles.button, !canSubmit && styles.disabled]} onPress={submit}>
          <Text style={styles.buttonText}>{state.kind === "signing-in" ? "正在登录…" : "登录"}</Text>
        </Pressable>
      </> : state.kind === "logout-error" ? <>
        <Text accessibilityRole="alert" style={styles.message}>{state.message}</Text>
        <Pressable accessibilityRole="button" style={styles.button} onPress={onRetrySignOut}>
          <Text style={styles.buttonText}>重试退出</Text>
        </Pressable>
      </> : <ActivityIndicator accessibilityLabel={state.kind === "restoring" ? "正在恢复登录" : "正在退出"}
        color={colors.roseDark} />}
    </ScrollView>
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas },
  layout: { flexGrow: 1, justifyContent: "center", alignSelf: "center", width: "100%", maxWidth: 400, padding: 24, gap: 10 },
  title: { fontSize: 26, fontWeight: "700", color: colors.ink, marginBottom: 14 },
  label: { fontSize: 14, color: colors.text },
  input: {
    minHeight: 48, paddingHorizontal: 12, borderRadius: 12, borderWidth: 1,
    borderColor: colors.line, color: colors.text, backgroundColor: colors.paper, marginBottom: 8,
  },
  message: { color: colors.muted, lineHeight: 20 },
  button: {
    alignItems: "center", justifyContent: "center", minHeight: 48, borderRadius: 12,
    backgroundColor: colors.roseWash, marginTop: 6,
  },
  disabled: { opacity: 0.7 },
  buttonText: { color: colors.text, fontSize: 15, fontWeight: "600" },
});
