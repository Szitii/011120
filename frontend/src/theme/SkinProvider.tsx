import AsyncStorage from "@react-native-async-storage/async-storage";
import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { BUILTIN_SKINS, themePalette, type SkinId, type SkinTheme, type UiPalette } from "./skinTokens";

interface SkinContextValue {
  skin: SkinTheme;
  ui: UiPalette;
  availableSkins: readonly SkinTheme[];
  setSkinById: (id: SkinId) => void;
}

const SkinContext = createContext<SkinContextValue | null>(null);
const availableSkins = Object.values(BUILTIN_SKINS);

export function SkinProvider({ children }: { children: React.ReactNode }) {
  const [skinId, setSkinId] = useState<SkinId>("default");
  const selected = useRef(false);
  const writes = useRef(Promise.resolve());
  const storageKey = "companion:appearance:v1";
  useEffect(() => {
    let current = true;
    void AsyncStorage.getItem(storageKey).then(value => {
      if (current && !selected.current && value && Object.hasOwn(BUILTIN_SKINS, value)) setSkinId(value as SkinId);
    }).catch(() => undefined);
    return () => { current = false; };
  }, []);
  function setSkinById(id: SkinId) {
    selected.current = true;
    setSkinId(id);
    writes.current = writes.current.then(() => AsyncStorage.setItem(storageKey, id)).catch(() => undefined);
  }
  const value = useMemo<SkinContextValue>(() => ({
    skin: BUILTIN_SKINS[skinId],
    ui: themePalette(BUILTIN_SKINS[skinId]),
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

export function useThemedStyles<T>(factory: (ui: UiPalette) => T): T {
  const { ui } = useSkin();
  return useMemo(() => factory(ui), [factory, ui]);
}
