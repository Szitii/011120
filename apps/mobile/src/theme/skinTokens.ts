export type SkinId = "default" | "glacier" | "pearl" | "titanium" | (string & {});

export interface SkinTheme {
  id: SkinId;
  name: string;
  tier: "free" | "paid";
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
    dockFill: string;
    activePillFill: string;
    chipFill: string;
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
    aiBadgeBg: string;
    aiBadgeText: string;
  };
  roomPack: {
    packId: string;
    atmosphere: "day" | "warm" | "night";
  };
  actorAnchor: {
    companionBarBg: string;
    companionBarText: string;
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

export const BUILTIN_SKINS: Record<"default" | "glacier" | "pearl" | "titanium", SkinTheme> = {
  default: {
    id: "default",
    name: "极简白",
    tier: "free",
    isDark: false,
    colors: { ...LIGHT_BASE_COLORS },
    glass: {
      dockFill: "rgba(255,255,255,0.88)",
      activePillFill: "rgba(241,245,249,0.96)",
      chipFill: "rgba(255,255,255,0.86)",
      iconTint: "#2563EB",
      border: "rgba(255,255,255,0.95)",
      outerRing: "rgba(148,163,184,0.28)",
    },
    chatBubbles: {
      humanFill: "rgba(37,99,235,0.78)",
      humanText: "#FFFFFF",
      humanBorder: "rgba(255,255,255,0.55)",
      aiFill: "rgba(255,255,255,0.82)",
      aiText: "#18181B",
      aiBorder: "rgba(255,255,255,0.96)",
    },
    identityBadges: { avatarRing: "#CBD5E1", aiBadgeBg: "#F1F5F9", aiBadgeText: "#475569" },
    roomPack: { packId: "flat-2d-clean-white", atmosphere: "day" },
    actorAnchor: { companionBarBg: "#18181B", companionBarText: "#FFFFFF" },
  },
  glacier: {
    id: "glacier",
    name: "冰川银雾",
    tier: "paid",
    isDark: false,
    colors: { ...LIGHT_BASE_COLORS, accentSoft: "#EDF6F8", accentSoftFg: "#0F4C5C", tabActive: "#0284C7" },
    glass: {
      dockFill: "rgba(248,253,255,0.90)",
      activePillFill: "rgba(224,242,254,0.90)",
      chipFill: "rgba(248,253,255,0.88)",
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
    identityBadges: { avatarRing: "#BAE6FD", aiBadgeBg: "#F1F5F9", aiBadgeText: "#475569" },
    roomPack: { packId: "flat-2d-glacier", atmosphere: "day" },
    actorAnchor: { companionBarBg: "#18181B", companionBarText: "#FFFFFF" },
  },
  pearl: {
    id: "pearl",
    name: "蜜桃珠光",
    tier: "paid",
    isDark: false,
    colors: { ...LIGHT_BASE_COLORS, accentSoft: "#FBF1F3", accentSoftFg: "#9F1239", tabActive: "#E11D48" },
    glass: {
      dockFill: "rgba(255,251,252,0.90)",
      activePillFill: "rgba(255,237,240,0.92)",
      chipFill: "rgba(255,251,252,0.88)",
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
    identityBadges: { avatarRing: "#FECDD3", aiBadgeBg: "#F4F4F6", aiBadgeText: "#52525B" },
    roomPack: { packId: "flat-2d-pearl", atmosphere: "warm" },
    actorAnchor: { companionBarBg: "#18181B", companionBarText: "#FFFFFF" },
  },
  titanium: {
    id: "titanium",
    name: "午夜钛黑",
    tier: "paid",
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
      dockFill: "rgba(28,31,40,0.88)",
      activePillFill: "rgba(255,255,255,0.16)",
      chipFill: "rgba(34,37,48,0.86)",
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
    identityBadges: { avatarRing: "#525866", aiBadgeBg: "#22252E", aiBadgeText: "#CBD5E1" },
    roomPack: { packId: "flat-2d-titanium-night", atmosphere: "night" },
    actorAnchor: { companionBarBg: "#E2E8F0", companionBarText: "#0F172A" },
  },
};

export function mergeRemoteSkin(
  base: SkinTheme,
  patch: Partial<SkinTheme> & { id: string; name: string },
): SkinTheme {
  return {
    ...base,
    ...patch,
    colors: { ...base.colors, ...(patch.colors ?? {}) },
    glass: { ...base.glass, ...(patch.glass ?? {}) },
    chatBubbles: { ...base.chatBubbles, ...(patch.chatBubbles ?? {}) },
    identityBadges: { ...base.identityBadges, ...(patch.identityBadges ?? {}) },
    roomPack: { ...base.roomPack, ...(patch.roomPack ?? {}) },
    actorAnchor: { ...base.actorAnchor, ...(patch.actorAnchor ?? {}) },
  };
}
