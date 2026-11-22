/**
 * Companion World — Skinnable Theme Engine (7 Pre-Wired Slots)
 *
 * 铁律：
 * - 浅色皮肤保持纯白画布 (#FFFFFF) 与炭黑正文 (#18181B)，不把边框文字染花。
 * - 换肤重点改变液态玻璃折射光晕、半透明聊天气泡、头像框/AI徽章、主页头图与扁平 2D 小家。
 * - 双身份防串号提示条独立适配深浅色，换肤永不失效。
 */

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
    danger: string;
  };

  glass: {
    dockFill: string;
    activePillFill: string;
    chipFill: string;
    iconTileFill: string;
    iconTint: string;
    border: string;
    outerRing: string;
    stageTint: string;
  };

  chatBubbles: {
    humanFill: string;
    humanText: string;
    humanBorder: string;
    aiFill: string;
    aiText: string;
    aiBorder: string;
    wallpaperUri?: string | null;
  };

  identityBadges: {
    avatarRing: string;
    aiBadgeBg: string;
    aiBadgeText: string;
    relationDot: string;
  };

  profileAndNotes: {
    bannerBg: string;
    bannerBorder: string;
    noteCardBg: string;
    noteCardBorder: string;
  };

  roomPack: {
    packId: string;
    wall: string;
    wallAccent: string;
    floor: string;
    rug: string;
    sky: string;
    desk: string;
    deskSide: string;
    cushion: string;
    lampShade: string;
    lampGlow: string;
    plant: string;
    stroke: string;
  };

  actorAnchor: {
    companionBarBg: string;
    companionBarText: string;
  };
}

export const BUILTIN_SKINS: Record<"default" | "glacier" | "pearl" | "titanium", SkinTheme> = {
  default: {
    id: "default",
    name: "极简白",
    tier: "free",
    isDark: false,
    colors: {
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
      tabInactive: "#94A3B8",
      danger: "#E11D48",
    },
    glass: {
      dockFill: "rgba(255, 255, 255, 0.88)",
      activePillFill: "rgba(241, 245, 249, 0.96)",
      chipFill: "rgba(255, 255, 255, 0.86)",
      iconTileFill: "rgba(255, 255, 255, 0.84)",
      iconTint: "#2563EB",
      border: "rgba(255, 255, 255, 0.95)",
      outerRing: "rgba(148, 163, 184, 0.28)",
      stageTint: "#EBF3FF",
    },
    chatBubbles: {
      humanFill: "rgba(37, 99, 235, 0.78)",
      humanText: "#FFFFFF",
      humanBorder: "rgba(255, 255, 255, 0.55)",
      aiFill: "rgba(255, 255, 255, 0.82)",
      aiText: "#18181B",
      aiBorder: "rgba(255, 255, 255, 0.96)",
      wallpaperUri: null,
    },
    identityBadges: {
      avatarRing: "#CBD5E1",
      aiBadgeBg: "#F1F5F9",
      aiBadgeText: "#475569",
      relationDot: "#2563EB",
    },
    profileAndNotes: {
      bannerBg: "#F4F7FB",
      bannerBorder: "#E6EEF8",
      noteCardBg: "#F8FAFC",
      noteCardBorder: "#E2E8F0",
    },
    roomPack: {
      packId: "flat-2d-clean-white",
      wall: "#F8F9FB",
      wallAccent: "#ECEFF4",
      floor: "#EFECE6",
      rug: "#E2E8F0",
      sky: "#D6ECFF",
      desk: "#FFFFFF",
      deskSide: "#E2E8F0",
      cushion: "#F9C6D0",
      lampShade: "#FFF6D6",
      lampGlow: "rgba(253, 224, 71, 0.25)",
      plant: "#68A87E",
      stroke: "#334155",
    },
    actorAnchor: {
      companionBarBg: "#18181B",
      companionBarText: "#FFFFFF",
    },
  },

  glacier: {
    id: "glacier",
    name: "冰川银雾",
    tier: "paid",
    isDark: false,
    colors: {
      canvas: "#FFFFFF",
      surface: "#F5F7F9",
      ink: "#18181B",
      inkSub: "#64748B",
      inkMute: "#94A3B8",
      border: "#E8EDF1",
      accent: "#18181B",
      accentFg: "#FFFFFF",
      accentSoft: "#EDF6F8",
      accentSoftFg: "#0F4C5C",
      tabActive: "#0284C7",
      tabInactive: "#94A3B8",
      danger: "#E11D48",
    },
    glass: {
      dockFill: "rgba(248, 253, 255, 0.90)",
      activePillFill: "rgba(224, 242, 254, 0.90)",
      chipFill: "rgba(248, 253, 255, 0.88)",
      iconTileFill: "rgba(255, 255, 255, 0.86)",
      iconTint: "#0284C7",
      border: "rgba(255, 255, 255, 0.96)",
      outerRing: "rgba(148, 163, 184, 0.26)",
      stageTint: "#E2F5FA",
    },
    chatBubbles: {
      humanFill: "rgba(14, 165, 233, 0.78)",
      humanText: "#FFFFFF",
      humanBorder: "rgba(255, 255, 255, 0.55)",
      aiFill: "rgba(255, 255, 255, 0.84)",
      aiText: "#18181B",
      aiBorder: "rgba(255, 255, 255, 0.96)",
      wallpaperUri: null,
    },
    identityBadges: {
      avatarRing: "#BAE6FD",
      aiBadgeBg: "#F1F5F9",
      aiBadgeText: "#475569",
      relationDot: "#0284C7",
    },
    profileAndNotes: {
      bannerBg: "#F2FAFC",
      bannerBorder: "#DCEEF4",
      noteCardBg: "#F4FAFC",
      noteCardBorder: "#DCEEF3",
    },
    roomPack: {
      packId: "flat-2d-glacier",
      wall: "#F5FAFC",
      wallAccent: "#E3F1F6",
      floor: "#ECF0F4",
      rug: "#CBE6F5",
      sky: "#C5E8FF",
      desk: "#FFFFFF",
      deskSide: "#D9E6F0",
      cushion: "#93C5FD",
      lampShade: "#FEF9C3",
      lampGlow: "rgba(186, 230, 253, 0.35)",
      plant: "#4CA384",
      stroke: "#293A56",
    },
    actorAnchor: {
      companionBarBg: "#18181B",
      companionBarText: "#FFFFFF",
    },
  },

  pearl: {
    id: "pearl",
    name: "蜜桃珠光",
    tier: "paid",
    isDark: false,
    colors: {
      canvas: "#FFFFFF",
      surface: "#F7F6F7",
      ink: "#18181B",
      inkSub: "#64748B",
      inkMute: "#94A3B8",
      border: "#ECECEF",
      accent: "#18181B",
      accentFg: "#FFFFFF",
      accentSoft: "#FBF1F3",
      accentSoftFg: "#9F1239",
      tabActive: "#E11D48",
      tabInactive: "#94A3B8",
      danger: "#E11D48",
    },
    glass: {
      dockFill: "rgba(255, 251, 252, 0.90)",
      activePillFill: "rgba(255, 237, 240, 0.92)",
      chipFill: "rgba(255, 251, 252, 0.88)",
      iconTileFill: "rgba(255, 255, 255, 0.86)",
      iconTint: "#E11D48",
      border: "rgba(255, 255, 255, 0.96)",
      outerRing: "rgba(148, 163, 184, 0.26)",
      stageTint: "#FCEBEF",
    },
    chatBubbles: {
      humanFill: "rgba(244, 114, 148, 0.82)",
      humanText: "#FFFFFF",
      humanBorder: "rgba(255, 255, 255, 0.55)",
      aiFill: "rgba(255, 255, 255, 0.84)",
      aiText: "#18181B",
      aiBorder: "rgba(255, 255, 255, 0.96)",
      wallpaperUri: null,
    },
    identityBadges: {
      avatarRing: "#FECDD3",
      aiBadgeBg: "#F4F4F6",
      aiBadgeText: "#52525B",
      relationDot: "#F43F5E",
    },
    profileAndNotes: {
      bannerBg: "#FCF8F9",
      bannerBorder: "#F3E6E9",
      noteCardBg: "#FCF7F8",
      noteCardBorder: "#F2E4E7",
    },
    roomPack: {
      packId: "flat-2d-pearl",
      wall: "#FCF9F9",
      wallAccent: "#F4E9EB",
      floor: "#F4ECE6",
      rug: "#FAD8DF",
      sky: "#DCEEFF",
      desk: "#FFFFFF",
      deskSide: "#EFE4E6",
      cushion: "#F7A8B8",
      lampShade: "#FFF4D8",
      lampGlow: "rgba(254, 215, 170, 0.30)",
      plant: "#6BA884",
      stroke: "#42343B",
    },
    actorAnchor: {
      companionBarBg: "#18181B",
      companionBarText: "#FFFFFF",
    },
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
      tabInactive: "#636A75",
      danger: "#FB7185",
    },
    glass: {
      dockFill: "rgba(28, 31, 40, 0.88)",
      activePillFill: "rgba(255, 255, 255, 0.16)",
      chipFill: "rgba(34, 37, 48, 0.86)",
      iconTileFill: "rgba(42, 46, 58, 0.84)",
      iconTint: "#E2E8F0",
      border: "rgba(255, 255, 255, 0.20)",
      outerRing: "rgba(255, 255, 255, 0.10)",
      stageTint: "#1C202B",
    },
    chatBubbles: {
      humanFill: "rgba(241, 245, 249, 0.88)",
      humanText: "#0B0C10",
      humanBorder: "rgba(255, 255, 255, 0.45)",
      aiFill: "rgba(44, 48, 60, 0.84)",
      aiText: "#F5F5F7",
      aiBorder: "rgba(255, 255, 255, 0.22)",
      wallpaperUri: null,
    },
    identityBadges: {
      avatarRing: "#525866",
      aiBadgeBg: "#22252E",
      aiBadgeText: "#CBD5E1",
      relationDot: "#93B4FF",
    },
    profileAndNotes: {
      bannerBg: "#15171D",
      bannerBorder: "#252934",
      noteCardBg: "#16181E",
      noteCardBorder: "#282C36",
    },
    roomPack: {
      packId: "flat-2d-titanium-night",
      wall: "#181B24",
      wallAccent: "#222634",
      floor: "#12141C",
      rug: "#282E40",
      sky: "#0E1324",
      desk: "#2B3040",
      deskSide: "#1F2330",
      cushion: "#6B82B8",
      lampShade: "#FDE68A",
      lampGlow: "rgba(253, 230, 138, 0.22)",
      plant: "#4D8A6E",
      stroke: "#8C95A8",
    },
    actorAnchor: {
      companionBarBg: "#E2E8F0",
      companionBarText: "#0F172A",
    },
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
    profileAndNotes: { ...base.profileAndNotes, ...(patch.profileAndNotes ?? {}) },
    roomPack: { ...base.roomPack, ...(patch.roomPack ?? {}) },
    actorAnchor: { ...base.actorAnchor, ...(patch.actorAnchor ?? {}) },
  };
}
