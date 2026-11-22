import React, { createContext, useContext, useMemo, useState } from "react";
import { BUILTIN_SKINS, type SkinId, type SkinTheme } from "./skinTokens";

interface SkinContextValue {
  skin: SkinTheme;
  availableSkins: readonly SkinTheme[];
  setSkinById: (id: SkinId) => void;
}

const SkinContext = createContext<SkinContextValue | null>(null);
const availableSkins = Object.values(BUILTIN_SKINS);

export function SkinProvider({ children }: { children: React.ReactNode }) {
  const [skinId, setSkinById] = useState<SkinId>("default");
  const value = useMemo<SkinContextValue>(() => ({
    skin: BUILTIN_SKINS[skinId],
    availableSkins,
    setSkinById,
  }), [skinId]);

  return <SkinContext.Provider value={value}>{children}</SkinContext.Provider>;
}

export function useSkin(): SkinContextValue {
  const ctx = useContext(SkinContext);
  if (!ctx) throw new Error("useSkin() must be used inside <SkinProvider>.");
  return ctx;
}
