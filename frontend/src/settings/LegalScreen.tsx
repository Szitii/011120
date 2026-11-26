import React from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import type { LegalDocKind } from "../state/navigation";
import { CHROME } from "../theme/layoutTokens";
import { useSkin, useThemedStyles } from "../theme/SkinProvider";
import type { UiPalette } from "../theme/skinTokens";

interface LegalSection {
  readonly heading: string;
  readonly body: string;
}

export interface LegalDocumentContent {
  readonly title: string;
  readonly statusBadge: string;
  readonly notice: string;
  readonly sections: readonly LegalSection[];
}

export const LEGAL_DOCUMENTS: Record<LegalDocKind, LegalDocumentContent> = {
  terms: {
    title: "用户协议",
    statusBadge: "待法务确认",
    notice: "当前页面为协议结构占位文本（待法务确认），正式条款以运营主体最终审定并公布的版本为准。",
    sections: [
      {
        heading: "1. 适用范围与主体说明（待法务确认）",
        body: "待法务确认：明确服务运营主体、适用地区、账号注册与使用条件。",
      },
      {
        heading: "2. 账号、双身份与使用规范（待法务确认）",
        body: "待法务确认：明确主人（Owner）与家机（Companion）身份边界、社区内容发布规则及禁止行为。",
      },
      {
        heading: "3. AI 生成内容与接入责任说明（待法务确认）",
        body: "待法务确认：明确平台模型、用户自带密钥或自建 Agent 接入时的权责划分与使用限制。",
      },
      {
        heading: "4. 服务变更、中止与账号终止（待法务确认）",
        body: "待法务确认：明确服务调整通知方式、违约处理措施及账号注销条件。",
      },
    ],
  },
  privacy: {
    title: "隐私政策",
    statusBadge: "待法务确认",
    notice: "当前页面为隐私政策结构占位文本（待法务确认），正式数据处理规则以运营主体最终审定并公布的版本为准。",
    sections: [
      {
        heading: "1. 收集的信息范围（待法务确认）",
        body: "待法务确认：说明注册邮箱、基础资料、对话记录、语音/图片文件与必要运行日志的收集范围与用途。",
      },
      {
        heading: "2. 私人小家与公共社区的数据隔离（待法务确认）",
        body: "待法务确认：说明私密记忆、日记与公开社区动态之间的可见性边界与授权机制。",
      },
      {
        heading: "3. 存储、第三方模型与跨境传输（待法务确认）",
        body: "待法务确认：说明数据存储地点、模型服务商调用说明及加密与访问控制措施。",
      },
      {
        heading: "4. 用户权利与数据删除（待法务确认）",
        body: "待法务确认：说明查询、更正、导出、撤回授权及账号与关联数据删除的办理方式与处理周期。",
      },
    ],
  },
};

export function LegalScreen({ doc }: { doc: LegalDocKind }) {
  const { ui } = useSkin();
  const styles = useThemedStyles(createStyles);
  const content = LEGAL_DOCUMENTS[doc];

  return (
    <View style={styles.page}>
      <LinearGradient pointerEvents="none" colors={ui.background} style={StyleSheet.absoluteFill} />
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.headerRow}>
          <Text accessibilityRole="header" style={styles.pageTitle}>{content.title}</Text>
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{content.statusBadge}</Text>
          </View>
        </View>

        <View style={styles.noticeCard}>
          <Text style={styles.noticeText}>{content.notice}</Text>
        </View>

        <View style={styles.card}>
          {content.sections.map((section, index) => (
            <View
              key={section.heading}
              style={[styles.sectionBlock, index < content.sections.length - 1 && styles.sectionDivider]}
            >
              <Text style={styles.sectionHeading}>{section.heading}</Text>
              <Text style={styles.sectionBody}>{section.body}</Text>
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

const createStyles = (ui: UiPalette) => StyleSheet.create({
  page: { flex: 1 },
  content: {
    paddingHorizontal: CHROME.screenInset,
    paddingTop: 8,
    paddingBottom: CHROME.scrollBottomClearance + 24,
    gap: 14,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    paddingHorizontal: 4,
  },
  pageTitle: { fontSize: 24, fontWeight: "800", color: ui.ink },
  badge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: ui.line,
    backgroundColor: ui.accentWash,
  },
  badgeText: { fontSize: 11.5, fontWeight: "600", color: ui.accentInk },
  noticeCard: {
    backgroundColor: ui.white,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: ui.line,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  noticeText: { fontSize: 12.5, lineHeight: 19, color: ui.muted },
  card: {
    backgroundColor: ui.white,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: ui.line,
    overflow: "hidden",
  },
  sectionBlock: {
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 6,
  },
  sectionDivider: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: ui.line,
  },
  sectionHeading: { fontSize: 14, fontWeight: "700", color: ui.ink },
  sectionBody: { fontSize: 13, lineHeight: 20, color: ui.muted },
});
