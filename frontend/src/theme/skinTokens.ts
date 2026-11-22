export type SkinId = "default" | "glacier" | "pearl" | "titanium";

export interface SkinTheme {
  id: SkinId;
  name: string;
  isDark: boolean;
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
  surface: "#F5F7FA",
  ink: "#18181B",
  inkSub: "#64748B",
  inkMute: "#94A3B8",
  border: "#E8ECF2",
  accent: "#18181B",
  accentFg: "#FFFFFF",
  accentSoft: "#EEF2F7",
  accentSoftFg: "#18181B",
  tabActive: "#18181B",
  tabInactive: "#64748B",
};

export const PEARL_UI = {
  background: ["#F7F6F3", "#F1EFEA"],
  white: "#FFFFFF",
  ink: "#242322",
  muted: "#625F5D",
  accent: "#7B90AC",
  accentInk: "#354760",
  accentWash: "#E6EBF2",
  line: "#E4E1DC",
  highlight: "rgba(255,255,255,0.96)",
  shadow: "#373537",
  sheen: ["rgba(255,255,255,0.72)", "rgba(246,247,250,0.36)", "rgba(255,255,255,0.54)"],
} as const;

export const BUILTIN_SKINS: Record<SkinId, SkinTheme> = {
  default: {
    id: "default",
    name: "极简白",
    isDark: false,
    colors: { ...LIGHT_BASE_COLORS },
    glass: {
      activePillFill: "rgba(123,144,172,0.27)",
      iconTint: PEARL_UI.accentInk,
      border: PEARL_UI.highlight,
      outerRing: "rgba(116,122,136,0.17)",
    },
    chatBubbles: {
      humanFill: "rgba(123,144,172,0.32)",
      humanText: PEARL_UI.accentInk,
      humanBorder: "rgba(255,255,255,0.55)",
      aiFill: "rgba(255,255,255,0.82)",
      aiText: PEARL_UI.ink,
      aiBorder: PEARL_UI.highlight,
    },
    identityBadges: { avatarRing: "#CBD5E1" },
  },
  glacier: {
    id: "glacier",
    name: "冰川银雾",
    isDark: false,
    colors: { ...LIGHT_BASE_COLORS, accentSoft: "#EDF6F8", accentSoftFg: "#0F4C5C", tabActive: "#0284C7" },
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
    colors: { ...LIGHT_BASE_COLORS, accentSoft: "#FBF1F3", accentSoftFg: "#9F1239", tabActive: "#E11D48" },
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
