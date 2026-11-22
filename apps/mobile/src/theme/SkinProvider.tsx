import React, { createContext, useCallback, useContext, useMemo, useState } from "react";
import { BUILTIN_SKINS, mergeRemoteSkin, type SkinId, type SkinTheme } from "./skinTokens";

export interface SkinContextValue {
  skin: SkinTheme;
  skinId: SkinId;
  availableSkins: SkinTheme[];
  setSkinById: (id: SkinId) => void;
  registerRemoteSkins: (patches: Array<Partial<SkinTheme> & { id: string; name: string }>) => void;
}

const SkinContext = createContext<SkinContextValue | null>(null);

export function SkinProvider({
  initialSkinId = "default",
  children,
}: {
  initialSkinId?: SkinId;
  children: React.ReactNode;
}) {
  const [registry, setRegistry] = useState<Record<string, SkinTheme>>(() => ({
    ...BUILTIN_SKINS,
  }));
  const [skinId, setSkinId] = useState<SkinId>(initialSkinId);

  const setSkinById = useCallback(
    (id: SkinId) => {
      setSkinId((prev) => (registry[id] ? id : prev));
    },
    [registry],
  );

  const registerRemoteSkins = useCallback(
    (patches: Array<Partial<SkinTheme> & { id: string; name: string }>) => {
      setRegistry((prev) => {
        const next = { ...prev };
        for (const patch of patches) {
          const base = patch.isDark ? BUILTIN_SKINS.titanium : BUILTIN_SKINS.default;
          next[patch.id] = mergeRemoteSkin(base, patch);
        }
        return next;
      });
    },
    [],
  );

  const value = useMemo<SkinContextValue>(() => {
    const active = registry[skinId] ?? BUILTIN_SKINS.default;
    return {
      skin: active,
      skinId: active.id,
      availableSkins: Object.values(registry),
      setSkinById,
      registerRemoteSkins,
    };
  }, [registry, skinId, setSkinById, registerRemoteSkins]);

  return <SkinContext.Provider value={value}>{children}</SkinContext.Provider>;
}

export function useSkin(): SkinContextValue {
  const ctx = useContext(SkinContext);
  if (!ctx) throw new Error("useSkin() must be used inside <SkinProvider>.");
  return ctx;
}
