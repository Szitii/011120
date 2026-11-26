import { useThemedStyles, useSkin } from "../theme/SkinProvider";
import type { UiPalette } from "../theme/skinTokens";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  ActivityIndicator,
  BackHandler,
  Keyboard,
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
import type { AccountBinding, AccountView, SelfServiceResult } from "./account-session";
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
  return <AccountScreen
    state={state}
    onSignIn={(email, password) => void auth.session.signIn(email, password)}
    onRegister={auth.signUp}
    onRecover={auth.resetPasswordForEmail}
    onRetrySignOut={signOut}
  />;
}

type AuthPage = "login" | "register" | "recover";

function AccountScreen({ state, onSignIn, onRegister, onRecover, onRetrySignOut }: {
  state: Exclude<AccountView, { kind: "signed-in" }>;
  onSignIn: (email: string, password: string) => void;
  onRegister: (email: string, password: string) => Promise<SelfServiceResult>;
  onRecover: (email: string) => Promise<SelfServiceResult>;
  onRetrySignOut: () => void;
}) {
  const { ui, skin } = useSkin();
  const styles = useThemedStyles(createStyles);
  const [page, setPage] = useState<AuthPage>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [result, setResult] = useState<SelfServiceResult>();
  const [sending, setSending] = useState(false);
  const pending = useRef(false);
  const formVisible = state.kind === "signed-out" || state.kind === "signing-in";
  const login = page === "login";
  const register = page === "register";
  const editable = state.kind === "signed-out" && !sending && !result?.ok;
  const canSubmit = editable && !!email.trim()
    && (page === "recover" || (!!password && (!register || !!confirmation)));

  const changePage = useCallback((next: AuthPage) => {
    if (pending.current) return;
    Keyboard.dismiss();
    setPassword("");
    setConfirmation("");
    setResult(undefined);
    setPage(next);
  }, []);

  useEffect(() => {
    if (formVisible) return;
    setPassword("");
    setConfirmation("");
  }, [formVisible]);

  useEffect(() => {
    if (login || !formVisible) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      changePage("login");
      return true;
    });
    return () => subscription.remove();
  }, [changePage, formVisible, login]);

  async function submit() {
    if (!canSubmit || pending.current) return;
    if (login) {
      onSignIn(email, password);
      return;
    }
    if (register && confirmation !== password) {
      setResult({ ok: false, message: "两次输入的密码不一致。" });
      return;
    }
    pending.current = true;
    setSending(true);
    setResult(undefined);
    Keyboard.dismiss();
    try {
      const response = await (register ? onRegister(email, password) : onRecover(email));
      setResult(response);
      if (response.ok) {
        setPassword("");
        setConfirmation("");
      }
    } finally {
      pending.current = false;
      setSending(false);
    }
  }

  const title = login ? "欢迎回家" : register ? "注册账号" : "找回密码";
  const subtitle = login ? "登录你的专属小家与社区"
    : register ? "使用邮箱注册，验证后即可登录。"
    : "输入注册邮箱，获取密码重置邮件。";
  const buttonLabel = login ? (state.kind === "signing-in" ? "正在登录…" : "登录")
    : sending ? "正在提交…" : register ? "注册" : "发送重置邮件";

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style={skin.isDark ? "light" : "dark"} />
      <LinearGradient pointerEvents="none" colors={ui.background} style={StyleSheet.absoluteFill} />
      <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
          contentContainerStyle={styles.layout}
        >
          {formVisible ? (
            <>
              <LiquidGlassSurface glass borderRadius={RADIUS.roomFrame} style={styles.heroCard}>
                <View style={styles.heroInner}>
                  {login && <View style={styles.avatarPair}>
                    <Image source={AVATAR_BOY} style={styles.heroAvatar} />
                    <Image source={AVATAR_GIRL} style={[styles.heroAvatar, { marginLeft: -10 }]} />
                  </View>}
                  <Text accessibilityRole="header" style={styles.title}>{title}</Text>
                  <Text style={styles.subtitle}>{subtitle}</Text>
                </View>
              </LiquidGlassSurface>

              <View style={styles.formCard}>
                {!result?.ok && <>
                  <Text style={styles.label}>邮箱</Text>
                  <TextInput
                    accessibilityLabel="邮箱"
                    autoCapitalize="none"
                    autoCorrect={false}
                    autoComplete="email"
                    keyboardType="email-address"
                    placeholder="输入邮箱地址"
                    placeholderTextColor={ui.muted}
                    editable={editable}
                    value={email}
                    onChangeText={setEmail}
                    onSubmitEditing={page === "recover" ? () => void submit() : undefined}
                    style={styles.input}
                  />
                  {page !== "recover" && <PasswordField
                    key={page}
                    value={password}
                    onChangeText={setPassword}
                    newPassword={register}
                    editable={editable}
                    onSubmit={login ? () => void submit() : undefined}
                  />}
                  {register && <PasswordField
                    label="确认密码"
                    value={confirmation}
                    onChangeText={setConfirmation}
                    newPassword
                    editable={editable}
                    onSubmit={() => void submit()}
                  />}
                </>}
                {login && state.kind === "signed-out" && state.message && (
                  <Text accessibilityRole="alert" style={styles.message}>{state.message}</Text>
                )}
                {result && (
                  <Text
                    accessibilityRole={result.ok ? "text" : "alert"}
                    accessibilityLiveRegion="polite"
                    style={result.ok ? styles.success : styles.message}
                  >
                    {result.message}
                  </Text>
                )}
                {!result?.ok && <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ disabled: !canSubmit }}
                  disabled={!canSubmit}
                  style={({ pressed }) => [
                    styles.button,
                    !canSubmit && styles.disabled,
                    pressed && canSubmit && { transform: [{ scale: 0.98 }] },
                  ]}
                  onPress={() => void submit()}
                >
                  <Text style={styles.buttonText}>{buttonLabel}</Text>
                </Pressable>}
                {login ? (
                  <View style={styles.actions}>
                    <AuthLink label="注册" disabled={!editable} onPress={() => changePage("register")} />
                    <AuthLink label="忘记密码" disabled={!editable} onPress={() => changePage("recover")} />
                  </View>
                ) : (
                  <AuthLink label="返回登录" disabled={sending} onPress={() => changePage("login")} />
                )}
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

function PasswordField({ label = "密码", value, onChangeText, newPassword, editable, onSubmit }: {
  label?: string;
  value: string;
  onChangeText: (value: string) => void;
  newPassword: boolean;
  editable: boolean;
  onSubmit?: () => void;
}) {
  const { ui } = useSkin();
  const styles = useThemedStyles(createStyles);
  const [visible, setVisible] = useState(false);
  return (
    <>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.passwordRow}>
        <TextInput
          accessibilityLabel={label}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete={newPassword ? "new-password" : "current-password"}
          textContentType={newPassword ? "newPassword" : "password"}
          placeholder={`输入${label}`}
          placeholderTextColor={ui.muted}
          secureTextEntry={!visible}
          editable={editable}
          onSubmitEditing={onSubmit}
          value={value}
          onChangeText={onChangeText}
          style={[styles.input, styles.passwordInput]}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${visible ? "隐藏" : "显示"}${label}`}
          accessibilityState={{ disabled: !editable }}
          disabled={!editable}
          onPress={() => setVisible(value => !value)}
          hitSlop={8}
          style={({ pressed }) => [styles.passwordToggle, pressed && styles.passwordTogglePressed]}
        >
          <Ionicons name={visible ? "eye-off-outline" : "eye-outline"} size={19} color={ui.muted} />
        </Pressable>
      </View>
    </>
  );
}

function AuthLink({ label, disabled, onPress }: { label: string; disabled: boolean; onPress: () => void }) {
  const styles = useThemedStyles(createStyles);
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled}
      onPress={onPress} style={[styles.link, disabled && styles.disabled]}>
      <Text style={styles.linkText}>{label}</Text>
    </Pressable>
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
  message: { color: ui.danger, fontSize: 13, lineHeight: 19, marginVertical: 4 },
  success: { color: ui.ink, fontSize: 14, lineHeight: 21 },
  actions: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between" },
  link: { minHeight: 44, paddingHorizontal: 8, justifyContent: "center", alignItems: "center" },
  linkText: { color: ui.accentInk, fontSize: 14, fontWeight: "600" },
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
