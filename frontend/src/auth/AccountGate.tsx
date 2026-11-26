import { useThemedStyles, useSkin } from "../theme/SkinProvider";
import type { UiPalette } from "../theme/skinTokens";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { StatusBar } from "expo-status-bar";
import Ionicons from "@expo/vector-icons/Ionicons";
import { LiquidGlassSurface } from "../components/LiquidGlassSurface";
import { RADIUS } from "../theme/layoutTokens";
import type { AccountBinding, AccountView } from "./account-session";
import type { SupabaseConfig } from "./config";
import { createSupabaseAccount } from "./supabase";

const AVATAR_BOY = require("../../assets/avatar-companion-pixel.png");
const AVATAR_GIRL = require("../../assets/avatar-owner-pixel.png");

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
  const { ui } = useSkin();
  const styles = useThemedStyles(createStyles);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordVisible, setPasswordVisible] = useState(false);
  const formVisible = state.kind === "signed-out" || state.kind === "signing-in";
  const canSubmit = state.kind === "signed-out" && !!email.trim() && !!password;

  // The password only lives in this component's memory. Keep it across a failed
  // attempt; drop it as soon as the form is no longer shown.
  useEffect(() => {
    if (formVisible) return;
    setPassword("");
    setPasswordVisible(false);
  }, [formVisible]);

  function submit() {
    if (!canSubmit) return;
    onSignIn(email, password);
  }

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="dark" />
      <LinearGradient pointerEvents="none" colors={ui.background} style={StyleSheet.absoluteFill} />
      <KeyboardAvoidingView
        style={styles.fill}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
      <ScrollView
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
        contentContainerStyle={styles.layout}
      >
        {formVisible ? (
          <>
            <LiquidGlassSurface glass borderRadius={28} style={styles.heroCard}>
              <View style={styles.heroInner}>
                <View style={styles.avatarPair}>
                  <Image source={AVATAR_BOY} style={styles.heroAvatar} />
                  <Image source={AVATAR_GIRL} style={[styles.heroAvatar, { marginLeft: -10 }]} />
                </View>
                <Text accessibilityRole="header" style={styles.title}>欢迎回家</Text>
                <Text style={styles.subtitle}>登录你的专属小家与社区</Text>
              </View>
            </LiquidGlassSurface>

            <View style={styles.formCard}>
              <Text style={styles.label}>邮箱</Text>
              <TextInput
                accessibilityLabel="邮箱"
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="email"
                keyboardType="email-address"
                placeholder="输入登录邮箱"
                placeholderTextColor={ui.muted}
                editable={state.kind === "signed-out"}
                value={email}
                onChangeText={setEmail}
                style={styles.input}
              />
              <Text style={styles.label}>密码</Text>
              <View style={styles.passwordRow}>
                <TextInput
                  accessibilityLabel="密码"
                  autoCapitalize="none"
                  autoComplete="current-password"
                  textContentType="password"
                  placeholder="输入密码"
                  placeholderTextColor={ui.muted}
                  secureTextEntry={!passwordVisible}
                  editable={state.kind === "signed-out"}
                  onSubmitEditing={submit}
                  value={password}
                  onChangeText={setPassword}
                  style={[styles.input, styles.passwordInput]}
                />
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={passwordVisible ? "隐藏密码" : "显示密码"}
                  accessibilityHint={passwordVisible ? "让密码重新以圆点显示" : "在输入框中显示密码原文"}
                  onPress={() => setPasswordVisible(value => !value)}
                  hitSlop={8}
                  style={({ pressed }) => [styles.passwordToggle, pressed && styles.passwordTogglePressed]}
                >
                  <Ionicons name={passwordVisible ? "eye-off-outline" : "eye-outline"} size={19} color={ui.muted} />
                </Pressable>
              </View>
              {state.kind === "signed-out" && state.message && (
                <Text accessibilityRole="alert" style={styles.message}>{state.message}</Text>
              )}
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: !canSubmit }}
                disabled={!canSubmit}
                style={({ pressed }) => [
                  styles.button,
                  !canSubmit && styles.disabled,
                  pressed && canSubmit && { transform: [{ scale: 0.98 }] },
                ]}
                onPress={submit}
              >
                <Text style={styles.buttonText}>{state.kind === "signing-in" ? "正在登录…" : "登录"}</Text>
              </Pressable>
            </View>
          </>
        ) : state.kind === "logout-error" ? (
          <View style={styles.formCard}>
            <Text accessibilityRole="alert" style={styles.message}>{state.message}</Text>
            <Pressable accessibilityRole="button" style={styles.button} onPress={onRetrySignOut}>
              <Text style={styles.buttonText}>重试退出</Text>
            </Pressable>
          </View>
        ) : (
          <ActivityIndicator
            accessibilityLabel={state.kind === "restoring" ? "正在恢复登录" : "正在退出"}
            color={ui.accent}
          />
        )}
      </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const createStyles = (ui: UiPalette) => StyleSheet.create({
  safe: { flex: 1, backgroundColor: ui.background[0] },
  fill: { flex: 1 },
  layout: {
    flexGrow: 1,
    justifyContent: "center",
    alignSelf: "center",
    width: "100%",
    maxWidth: 400,
    padding: 22,
    gap: 16,
  },
  heroCard: { width: "100%" },
  heroInner: { alignItems: "center", paddingVertical: 26, paddingHorizontal: 20 },
  avatarPair: { flexDirection: "row", alignItems: "center", marginBottom: 14 },
  heroAvatar: {
    width: 60,
    height: 60,
    borderRadius: 30,
    borderWidth: 2.5,
    borderColor: ui.highlight,
    backgroundColor: ui.background[0],
  },
  title: { fontSize: 24, fontWeight: "700", color: ui.ink, marginBottom: 4 },
  subtitle: { fontSize: 13, color: ui.muted },
  formCard: {
    backgroundColor: ui.white,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: ui.line,
    padding: 20,
    gap: 8,
  },
  label: { fontSize: 13, fontWeight: "600", color: ui.ink, marginTop: 4 },
  input: {
    minHeight: 46,
    paddingHorizontal: 14,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: ui.line,
    color: ui.ink,
    backgroundColor: ui.white,
    marginBottom: 6,
    fontSize: 14.5,
  },
  passwordRow: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: ui.line,
    backgroundColor: ui.white,
    marginBottom: 6,
  },
  passwordInput: {
    flex: 1,
    borderWidth: 0,
    borderRadius: 0,
    backgroundColor: "transparent",
    marginBottom: 0,
  },
  passwordToggle: {
    alignSelf: "stretch",
    justifyContent: "center",
    paddingHorizontal: 12,
  },
  passwordTogglePressed: { opacity: 0.6 },
  message: { color: ui.muted, fontSize: 13, lineHeight: 19, marginVertical: 4 },
  button: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: 48,
    borderRadius: RADIUS.pill,
    backgroundColor: ui.iceBlue,
    borderWidth: 1,
    borderColor: ui.highlight,
    marginTop: 8,
  },
  disabled: { opacity: 0.5 },
  buttonText: { color: ui.onAccent, fontSize: 15, fontWeight: "700" },
});
