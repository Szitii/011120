import React, { useRef, useState, type ComponentProps } from "react";
import { Keyboard, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import Ionicons from "@expo/vector-icons/Ionicons";
import type { SelfServiceResult } from "../auth/account-session";
import type { ChatClient } from "../chat/client";
import { BottomSheet } from "../components/BottomSheet";
import { GlassChatBubble } from "../components/GlassChatBubble";
import { PixelAvatar } from "../components/PixelAvatar";
import type { LegalDocKind } from "../state/navigation";
import { useSkin, useThemedStyles, TEXT_SIZES } from "../theme/SkinProvider";
import type { UiPalette } from "../theme/skinTokens";
import { CHROME, RADIUS } from "../theme/layoutTokens";
import { WalletBalance } from "../wallet/WalletBalance";

export function SettingsScreen({
  account,
  ownerName,
  avatar,
  isCompanion,
  walletClient,
  onSwitchIdentity,
  onBlocks,
  onBringCompanion,
  onAgentSettings,
  onOpenFeedback,
  onOpenLegal,
}: {
  account?: {
    email?: string;
    signOut: () => void;
    updatePassword?: (password: string) => Promise<SelfServiceResult>;
  };
  ownerName: string;
  avatar?: string | null;
  isCompanion: boolean;
  walletClient?: ChatClient;
  onSwitchIdentity: () => void;
  onBlocks?: () => void;
  onBringCompanion?: () => void;
  onAgentSettings?: () => void;
  onOpenFeedback?: () => void;
  onOpenLegal?: (doc: LegalDocKind) => void;
}) {
  const { ui, skinPreference, setSkinById, availableSkins, textSize, setTextSize } = useSkin();
  const styles = useThemedStyles(createStyles);
  const [passwordSheetOpen, setPasswordSheetOpen] = useState(false);
  const [deleteInfoOpen, setDeleteInfoOpen] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [passwordResult, setPasswordResult] = useState<SelfServiceResult>();
  const passwordPendingRef = useRef(false);

  const canUpdatePassword = Boolean(account?.updatePassword);

  function openPasswordSheet() {
    setNewPassword("");
    setConfirmPassword("");
    setPasswordVisible(false);
    setPasswordResult(undefined);
    setPasswordSheetOpen(true);
  }

  function closePasswordSheet() {
    if (passwordPendingRef.current) return;
    Keyboard.dismiss();
    setPasswordSheetOpen(false);
    setNewPassword("");
    setConfirmPassword("");
    setPasswordVisible(false);
    setPasswordResult(undefined);
  }

  async function submitPasswordChange() {
    if (passwordPendingRef.current || !account?.updatePassword) return;
    if (newPassword.length < 6) {
      setPasswordResult({ ok: false, message: "密码至少需要 6 位字符。" });
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordResult({ ok: false, message: "两次输入的新密码不一致。" });
      return;
    }

    passwordPendingRef.current = true;
    setPasswordSaving(true);
    setPasswordResult(undefined);
    Keyboard.dismiss();
    try {
      const result = await account.updatePassword(newPassword);
      setPasswordResult(result);
      if (result.ok) {
        setNewPassword("");
        setConfirmPassword("");
      }
    } finally {
      passwordPendingRef.current = false;
      setPasswordSaving(false);
    }
  }

  return (
    <View style={styles.page}>
      <LinearGradient pointerEvents="none" colors={ui.background} style={StyleSheet.absoluteFill} />
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Text accessibilityRole="header" style={styles.pageTitle}>设置</Text>
        <View style={styles.accountCard}>
          <View style={styles.accountTop}>
            <PixelAvatar name={ownerName} role={isCompanion ? "companion" : "owner"} uri={avatar} size={52} />
            <View style={styles.accountText}>
              <Text style={styles.accountName} numberOfLines={1}>{ownerName}</Text>
              {account?.email ? <Text style={styles.accountEmail} numberOfLines={1}>{account.email}</Text> : null}
              <Text style={styles.accountMeta}>{isCompanion ? "当前以家机身份浏览" : "当前以主人身份浏览"}</Text>
            </View>
          </View>
        </View>

        {walletClient?.wallet ? <WalletBalance client={walletClient} /> : null}

        <View style={styles.card}>
          <SettingRow icon="swap-horizontal-outline" label="切换身份" onPress={onSwitchIdentity}
            last={!onBlocks && !onOpenFeedback} />
          {onBlocks && <SettingRow icon="shield-checkmark-outline" label="屏蔽管理" onPress={onBlocks} last={!onOpenFeedback} />}
          {onOpenFeedback && <SettingRow icon="chatbubble-ellipses-outline" label="意见反馈" onPress={onOpenFeedback} last />}
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>账号与安全</Text>
          <View style={styles.card}>
            <View style={[styles.row, styles.rowDivider]}>
              <View style={styles.rowLeft}>
                <Ionicons name="mail-outline" size={18} color={ui.accentInk} />
                <Text style={styles.rowLabel}>登录邮箱</Text>
              </View>
              <Text style={styles.rowValue}>
                {account?.email ?? "未登录邮箱会话"}
              </Text>
            </View>
            <SettingRow
              icon="key-outline"
              label="修改密码"
              valueText={canUpdatePassword ? undefined : "需当前登录会话"}
              onPress={openPasswordSheet}
            />
            <SettingRow
              icon="trash-outline"
              label="注销账号"
              valueText="暂未开放自助办理"
              last
              onPress={() => setDeleteInfoOpen(true)}
            />
          </View>
        </View>

        {(onBringCompanion || onAgentSettings) && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>陪伴</Text>
            <View style={styles.card}>
              {onBringCompanion && (
                <SettingRow icon="person-add-outline" label="添加陪伴成员" onPress={onBringCompanion} last={!onAgentSettings} />
              )}
              {onAgentSettings && (
                <SettingRow icon="sparkles-outline" label="互动与活动设置" onPress={onAgentSettings} last />
              )}
            </View>
          </View>
        )}

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>外观</Text>
          <View style={styles.appearanceCard}>
            <Text style={styles.subLabel}>配色</Text>
            <View style={styles.pillRow}>
              <Pressable
                accessibilityRole="radio"
                accessibilityLabel="配色跟随系统"
                aria-checked={skinPreference === "system"}
                onPress={() => setSkinById("system")}
                style={[styles.pill, skinPreference === "system" && styles.pillActive]}
              >
                <Text style={[styles.pillText, skinPreference === "system" && styles.pillTextActive]}>
                  跟随系统
                </Text>
              </Pressable>
            </View>
            <View style={styles.swatchRow}>
              {availableSkins.map(preset => {
                const active = preset.id === skinPreference;
                return (
                  <Pressable
                    key={preset.id}
                    accessibilityRole="radio"
                    accessibilityLabel={preset.name}
                    aria-checked={active}
                    onPress={() => setSkinById(preset.id)}
                    style={({ pressed }) => [styles.swatchItem, pressed && { opacity: 0.72 }]}
                  >
                    <View style={[styles.swatchCircle, {
                      backgroundColor: preset.colors.accent,
                      borderColor: active ? ui.accent : ui.line,
                    }]}>
                      {active && <Ionicons name="checkmark" size={14} color={preset.colors.accentFg} />}
                    </View>
                    <Text style={[styles.swatchName, active && styles.swatchNameActive]} numberOfLines={1}>
                      {preset.name}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            <Text style={styles.subLabel}>字体大小</Text>
            <View style={styles.pillRow}>
              {(Object.keys(TEXT_SIZES) as Array<keyof typeof TEXT_SIZES>).map(size => {
                const active = size === textSize;
                return (
                  <Pressable
                    key={size}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: active }}
                    onPress={() => setTextSize(size)}
                    style={[styles.pill, active && styles.pillActive]}
                  >
                    <Text style={[styles.pillText, active && styles.pillTextActive]}>{TEXT_SIZES[size]}</Text>
                  </Pressable>
                );
              })}
            </View>

            <Text style={styles.subLabel}>聊天样式预览</Text>
            <View style={styles.previewBox}>
              <GlassChatBubble senderRole="ai" text="看你昨晚说肩颈酸，把靠枕换软了。" />
              <GlassChatBubble senderRole="human" text="收到啦，今晚早点回来。" />
            </View>
          </View>
        </View>

        {onOpenLegal && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>协议与条款</Text>
            <View style={styles.card}>
              <SettingRow
                icon="document-text-outline"
                label="用户协议"
                onPress={() => onOpenLegal("terms")}
              />
              <SettingRow
                icon="lock-closed-outline"
                label="隐私政策"
                last
                onPress={() => onOpenLegal("privacy")}
              />
            </View>
          </View>
        )}

        {account && (
          <View style={styles.card}>
            <SettingRow
              icon="log-out-outline"
              label="退出登录"
              danger
              last
              onPress={account.signOut}
            />
          </View>
        )}

        <Text style={styles.footnote}>外观设置只在这台设备生效。</Text>
      </ScrollView>

      <BottomSheet visible={passwordSheetOpen} title="修改密码" avoidKeyboard onClose={closePasswordSheet}>
        {canUpdatePassword ? (
          <View style={styles.sheetBody}>
            {account?.email ? (
              <Text style={styles.sheetHint}>当前登录邮箱：{account.email}</Text>
            ) : null}
            {!passwordResult?.ok && (
              <>
                <Text style={styles.fieldLabel}>新密码</Text>
                <View style={styles.passwordRow}>
                  <TextInput
                    accessibilityLabel="新密码"
                    autoCapitalize="none"
                    autoCorrect={false}
                    autoComplete="new-password"
                    textContentType="newPassword"
                    placeholder="至少 6 位字符"
                    placeholderTextColor={ui.muted}
                    secureTextEntry={!passwordVisible}
                    editable={!passwordSaving}
                    value={newPassword}
                    onChangeText={setNewPassword}
                    style={styles.passwordInput}
                  />
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={passwordVisible ? "隐藏新密码" : "显示新密码"}
                    disabled={passwordSaving}
                    onPress={() => setPasswordVisible(value => !value)}
                    hitSlop={8}
                    style={styles.passwordToggle}
                  >
                    <Ionicons name={passwordVisible ? "eye-off-outline" : "eye-outline"} size={18} color={ui.muted} />
                  </Pressable>
                </View>

                <Text style={styles.fieldLabel}>确认新密码</Text>
                <View style={styles.passwordRow}>
                  <TextInput
                    accessibilityLabel="确认新密码"
                    autoCapitalize="none"
                    autoCorrect={false}
                    autoComplete="new-password"
                    textContentType="newPassword"
                    placeholder="再次输入新密码"
                    placeholderTextColor={ui.muted}
                    secureTextEntry={!passwordVisible}
                    editable={!passwordSaving}
                    value={confirmPassword}
                    onChangeText={setConfirmPassword}
                    onSubmitEditing={() => void submitPasswordChange()}
                    style={styles.passwordInput}
                  />
                </View>
              </>
            )}

            {passwordResult ? (
              <Text
                accessibilityRole={passwordResult.ok ? "text" : "alert"}
                accessibilityLiveRegion="polite"
                style={passwordResult.ok ? styles.successText : styles.errorText}
              >
                {passwordResult.message}
              </Text>
            ) : null}

            {!passwordResult?.ok ? (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: passwordSaving || !newPassword || !confirmPassword }}
                disabled={passwordSaving || !newPassword || !confirmPassword}
                onPress={() => void submitPasswordChange()}
                style={({ pressed }) => [
                  styles.primaryButton,
                  (passwordSaving || !newPassword || !confirmPassword) && styles.buttonDisabled,
                  pressed && !passwordSaving && { opacity: 0.82 },
                ]}
              >
                <Text style={styles.primaryButtonText}>
                  {passwordSaving ? "正在保存…" : "确认修改"}
                </Text>
              </Pressable>
            ) : null}
          </View>
        ) : (
          <View style={styles.sheetBody}>
            <Text style={styles.sheetDescription}>
              修改密码需要有效的邮箱登录会话。当前为本地或开发演示模式，无法调用账号密码更新。
            </Text>
          </View>
        )}
      </BottomSheet>

      <BottomSheet
        visible={deleteInfoOpen}
        title="注销账号"
        badge="暂未开放自助注销"
        onClose={() => setDeleteInfoOpen(false)}
      >
        <View style={styles.sheetBody}>
          <Text style={styles.sheetDescription}>
            当前暂未开放自助注销。
          </Text>
          <Text style={styles.sheetDescription}>
            如需了解账号注销和数据清理的办理方式，可通过「意见反馈」咨询。请勿提供密码或验证码。
          </Text>
          {onOpenFeedback ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="前往意见反馈申请注销"
              onPress={() => {
                setDeleteInfoOpen(false);
                onOpenFeedback();
              }}
              style={({ pressed }) => [styles.secondaryButton, pressed && { opacity: 0.82 }]}
            >
              <Text style={styles.secondaryButtonText}>前往意见反馈</Text>
            </Pressable>
          ) : null}
        </View>
      </BottomSheet>
    </View>
  );
}

function SettingRow({ icon, label, valueText, danger, last, onPress }: {
  icon?: ComponentProps<typeof Ionicons>["name"];
  label: string;
  valueText?: string;
  danger?: boolean;
  last?: boolean;
  onPress: () => void;
}) {
  const { ui } = useSkin();
  const styles = useThemedStyles(createStyles);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [styles.row, !last && styles.rowDivider, pressed && { opacity: 0.72 }]}
    >
      <View style={styles.rowLeft}>
        {icon ? <Ionicons name={icon} size={18} color={danger ? ui.danger : ui.accentInk} /> : null}
        <Text style={[styles.rowLabel, danger && styles.rowLabelDanger]}>{label}</Text>
      </View>
      {!danger && (
        <View style={styles.rowRight}>
          {valueText ? <Text style={styles.rowValue}>{valueText}</Text> : null}
          <Ionicons name="chevron-forward" size={15} color={ui.muted} />
        </View>
      )}
    </Pressable>
  );
}

const createStyles = (ui: UiPalette) => StyleSheet.create({
  page: { flex: 1 },
  content: {
    paddingHorizontal: CHROME.screenInset,
    paddingTop: 8,
    paddingBottom: CHROME.scrollBottomClearance + 24,
    gap: 16,
  },
  pageTitle: { fontSize: 24, fontWeight: "800", color: ui.ink, paddingLeft: 4 },
  accountCard: {
    backgroundColor: ui.white,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: ui.line,
    padding: 16,
  },
  accountTop: { flexDirection: "row", alignItems: "center", gap: 12 },
  accountText: { flex: 1, gap: 3 },
  accountName: { fontSize: 18, fontWeight: "700", color: ui.ink },
  accountEmail: { fontSize: 12.5, color: ui.muted },
  accountMeta: { fontSize: 11.5, color: ui.accentInk },
  section: { gap: 8 },
  sectionTitle: { fontSize: 12.5, fontWeight: "700", color: ui.muted, paddingLeft: 4 },
  card: {
    backgroundColor: ui.white,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: ui.line,
    overflow: "hidden",
  },
  row: {
    minHeight: 52,
    paddingHorizontal: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  rowDivider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: ui.line },
  rowLeft: { flexDirection: "row", alignItems: "center", gap: 10, flexShrink: 1, minWidth: 0 },
  rowRight: { flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 1, maxWidth: "60%" },
  rowLabel: { fontSize: 15, fontWeight: "600", color: ui.ink, flexShrink: 1 },
  rowLabelDanger: { color: ui.danger },
  rowValue: { fontSize: 13, color: ui.muted, flexShrink: 1, textAlign: "right" },
  appearanceCard: {
    backgroundColor: ui.white,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: ui.line,
    padding: 14,
    gap: 10,
  },
  subLabel: { fontSize: 11.5, fontWeight: "700", color: ui.muted, paddingLeft: 2 },
  swatchRow: { flexDirection: "row", gap: 8 },
  swatchItem: { flex: 1, alignItems: "center", gap: 6, paddingVertical: 4 },
  swatchCircle: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "center",
  },
  swatchName: { fontSize: 10.5, color: ui.muted, textAlign: "center" },
  swatchNameActive: { color: ui.accentInk, fontWeight: "600" },
  pillRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  pill: {
    paddingHorizontal: 13,
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: ui.line,
    backgroundColor: ui.background[0],
  },
  pillActive: { backgroundColor: ui.accentWash, borderColor: ui.accent },
  pillText: { fontSize: 12, color: ui.ink },
  pillTextActive: { color: ui.accentInk, fontWeight: "600" },
  previewBox: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: ui.line,
    backgroundColor: ui.background[0],
    padding: 12,
    gap: 8,
  },
  footnote: { textAlign: "center", fontSize: 11, color: ui.muted, paddingTop: 4 },
  sheetBody: { gap: 10 },
  sheetHint: { fontSize: 12.5, color: ui.muted },
  sheetDescription: { fontSize: 13.5, lineHeight: 20, color: ui.muted },
  fieldLabel: { fontSize: 13, fontWeight: "600", color: ui.ink, marginTop: 2 },
  passwordRow: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: ui.line,
    backgroundColor: ui.white,
  },
  passwordInput: {
    flex: 1,
    minHeight: 44,
    paddingHorizontal: 14,
    color: ui.ink,
    fontSize: 14.5,
  },
  passwordToggle: {
    alignSelf: "stretch",
    justifyContent: "center",
    paddingHorizontal: 12,
  },
  errorText: { fontSize: 13, lineHeight: 19, color: ui.danger },
  successText: { fontSize: 13.5, lineHeight: 20, color: ui.ink },
  primaryButton: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: 46,
    borderRadius: RADIUS.pill,
    backgroundColor: ui.iceBlue,
    borderWidth: 1,
    borderColor: ui.highlight,
    marginTop: 4,
  },
  primaryButtonText: { fontSize: 14.5, fontWeight: "700", color: ui.onAccent },
  secondaryButton: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: 44,
    borderRadius: RADIUS.pill,
    backgroundColor: ui.accentWash,
    borderWidth: 1,
    borderColor: ui.line,
    marginTop: 4,
  },
  secondaryButtonText: { fontSize: 14, fontWeight: "600", color: ui.accentInk },
  buttonDisabled: { opacity: 0.5 },
});
