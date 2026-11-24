export type SkinId = "default" | "glacier" | "pearl" | "titanium";

export interface SkinTheme {
  id: SkinId;
  name: string;
  isDark: boolean;
  background: readonly [string, string];
  colors: {
    canvas: string;
    surface: string;
    ink: string;
    inkSub: string;
    inkMute: string;
    border: string;
    accent: string;
    accentFg: string;
    accentSoft: string;
    accentSoftFg: string;
    tabActive: string;
    tabInactive: string;
  };
  glass: {
    activePillFill: string;
    iconTint: string;
    border: string;
    outerRing: string;
  };
  chatBubbles: {
    humanFill: string;
    humanText: string;
    humanBorder: string;
    aiFill: string;
    aiText: string;
    aiBorder: string;
  };
  identityBadges: {
    avatarRing: string;
  };
}

const LIGHT_BASE_COLORS = {
  canvas: "#FFFFFF",
  surface: "#F6F5F0",
  ink: "#18181B",
  inkSub: "#7A7672",
  inkMute: "#9A9691",
  border: "#EAE6DF",
  accent: "#7B90AC",
  accentFg: "#FFFFFF",
  accentSoft: "#EEF2F7",
  accentSoftFg: "#354760",
  tabActive: "#354760",
  tabInactive: "#5E5A56",
};

/** 定稿前端色卡（暖珍珠浅底 × 清透液态毛玻璃 × 冰雾/雾霾灰蓝点缀） */
const PEARL_UI = {
  background: ["#F6F5F0", "#F0E9E1"] as const,
  white: "#FFFFFF",
  ink: "#242322",
  muted: "#7A7672",
  iceBlue: "#B4C0D4",
  accent: "#7B90AC",
  accentInk: "#354760",
  accentWash: "#E6ECF4",
  line: "#EAE6DF",
  highlight: "rgba(255,255,255,0.96)",
  shadow: "#53463C",
  sheen: ["rgba(255,255,255,0.78)", "rgba(246,245,240,0.44)", "rgba(255,255,255,0.62)"] as const,
} as const;

export const BUILTIN_SKINS: Record<SkinId, SkinTheme> = {
  default: {
    id: "default",
    name: "清透珍珠白",
    isDark: false,
    background: PEARL_UI.background,
    colors: { ...LIGHT_BASE_COLORS },
    glass: {
      activePillFill: "rgba(180,192,212,0.46)",
      iconTint: PEARL_UI.accentInk,
      border: PEARL_UI.highlight,
      outerRing: "rgba(123,144,172,0.18)",
    },
    chatBubbles: {
      humanFill: "rgba(180,192,212,0.84)",
      humanText: "#FFFFFF",
      humanBorder: "rgba(255,255,255,0.72)",
      aiFill: "rgba(255,255,255,0.88)",
      aiText: PEARL_UI.ink,
      aiBorder: PEARL_UI.highlight,
    },
    identityBadges: { avatarRing: "#FFFFFF" },
  },
  glacier: {
    id: "glacier",
    name: "冰川银雾",
    isDark: false,
    background: ["#F2F8FB", "#DDEBF3"],
    colors: { ...LIGHT_BASE_COLORS, border: "#D8E5ED", accent: "#397195", accentSoft: "#DBEEF7", accentSoftFg: "#0F4C5C", tabActive: "#0284C7" },
    glass: {
      activePillFill: "rgba(224,242,254,0.90)",
      iconTint: "#0284C7",
      border: "rgba(255,255,255,0.96)",
      outerRing: "rgba(148,163,184,0.26)",
    },
    chatBubbles: {
      humanFill: "rgba(14,165,233,0.78)",
      humanText: "#FFFFFF",
      humanBorder: "rgba(255,255,255,0.55)",
      aiFill: "rgba(255,255,255,0.84)",
      aiText: "#18181B",
      aiBorder: "rgba(255,255,255,0.96)",
    },
    identityBadges: { avatarRing: "#BAE6FD" },
  },
  pearl: {
    id: "pearl",
    name: "蜜桃珠光",
    isDark: false,
    background: ["#FBF5F5", "#F4E4E7"],
    colors: { ...LIGHT_BASE_COLORS, border: "#EFDAE0", accent: "#A24B67", accentSoft: "#F8E5EB", accentSoftFg: "#8A3753", tabActive: "#A24B67" },
    glass: {
      activePillFill: "rgba(255,237,240,0.92)",
      iconTint: "#E11D48",
      border: "rgba(255,255,255,0.96)",
      outerRing: "rgba(148,163,184,0.26)",
    },
    chatBubbles: {
      humanFill: "rgba(244,114,148,0.82)",
      humanText: "#FFFFFF",
      humanBorder: "rgba(255,255,255,0.55)",
      aiFill: "rgba(255,255,255,0.84)",
      aiText: "#18181B",
      aiBorder: "rgba(255,255,255,0.96)",
    },
    identityBadges: { avatarRing: "#FECDD3" },
  },
  titanium: {
    id: "titanium",
    name: "午夜钛黑",
    isDark: true,
    background: ["#101218", "#171A24"],
    colors: {
      canvas: "#0B0C10",
      surface: "#16181E",
      ink: "#F5F5F7",
      inkSub: "#989FA8",
      inkMute: "#636A75",
      border: "#242730",
      accent: "#F5F5F7",
      accentFg: "#0B0C10",
      accentSoft: "#22252E",
      accentSoftFg: "#E2E8F0",
      tabActive: "#F5F5F7",
      tabInactive: "#94A3B8",
    },
    glass: {
      activePillFill: "rgba(255,255,255,0.16)",
      iconTint: "#E2E8F0",
      border: "rgba(255,255,255,0.20)",
      outerRing: "rgba(255,255,255,0.10)",
    },
    chatBubbles: {
      humanFill: "rgba(241,245,249,0.88)",
      humanText: "#0B0C10",
      humanBorder: "rgba(255,255,255,0.45)",
      aiFill: "rgba(44,48,60,0.84)",
      aiText: "#F5F5F7",
      aiBorder: "rgba(255,255,255,0.22)",
    },
    identityBadges: { avatarRing: "#525866" },
  },
};

export function themePalette(skin: SkinTheme) {
  const tokens = skin.colors;
  return {
    background: skin.background,
    white: skin.isDark ? tokens.surface : tokens.canvas,
    ink: skin.id === "default" ? PEARL_UI.ink : tokens.ink,
    muted: tokens.inkSub,
    placeholder: skin.isDark ? "#929CB2" : "#746D67",
    accent: tokens.accent,
    accentInk: tokens.accentSoftFg,
    accentWash: tokens.accentSoft,
    iceBlue: skin.id === "default" ? PEARL_UI.iceBlue : tokens.accentSoft,
    line: tokens.border,
    onAccent: tokens.accentFg,
    highlight: skin.glass.border,
    shadow: skin.isDark ? "#000000" : PEARL_UI.shadow,
    warning: skin.isDark ? "#E5BE83" : "#8E652B",
    warningSurface: skin.isDark ? "#3A2F20" : "#FFF6E8",
    mineInk: tokens.accentSoftFg,
    roomNight: "rgba(26,34,58,0.24)",
    danger: skin.isDark ? "#F6A7AF" : "#984C59",
    affection: skin.isDark ? "#F6A7AF" : "#C87D87",
    onDark: "#F8FAFC",
    scrim: skin.isDark ? "rgba(0,0,0,0.58)" : "rgba(15,23,42,0.34)",
    sheen: skin.isDark ? ["#303645", "#232734", "#363D50"] as const : PEARL_UI.sheen,
  };
}

export type UiPalette = ReturnType<typeof themePalette>;

export const GLASS_MATERIAL = {
  lightBorder: "rgba(255,255,255,0.90)",
  darkBorder: "rgba(255,255,255,0.2)",
  lightFinish: ["rgba(255,255,255,0.44)", "rgba(255,255,255,0.16)", "rgba(255,255,255,0.34)"],
  darkFinish: ["rgba(255,255,255,0.16)", "rgba(255,255,255,0.04)", "rgba(255,255,255,0.10)"],
  bubbleGleam: { mine: "rgba(255,255,255,0.34)", dark: "rgba(255,255,255,0.18)", light: "rgba(255,255,255,0.92)" },
} as const;
