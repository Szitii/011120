import AsyncStorage from "@react-native-async-storage/async-storage";
import { useWindowDimensions } from "react-native";
import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { BUILTIN_SKINS, themePalette, type SkinId, type SkinTheme, type UiPalette } from "./skinTokens";

export const TEXT_SIZES = { system: "跟随系统", standard: "标准", large: "大", extra: "特大" } as const;
type TextSize = keyof typeof TEXT_SIZES;
const textSizeStorage = "companion:text-size:v1";
const fontMagnification = { standard: 1, large: 1.15, extra: 1.3 };

interface SkinContextValue {
  textSize: TextSize;
  setTextSize: (size: TextSize) => void;
  skin: SkinTheme;
  ui: UiPalette;
  availableSkins: readonly SkinTheme[];
  setSkinById: (id: SkinId) => void;
}

const SkinContext = createContext<SkinContextValue | null>(null);
const availableSkins = Object.values(BUILTIN_SKINS);

export function SkinProvider({ children }: { children: React.ReactNode }) {
  const [skinId, setSkinId] = useState<SkinId>("default");
  const [textSize, setTextSizeValue] = useState<TextSize>("system");
  const textSelected = useRef(false);
  const selected = useRef(false);
  const writes = useRef(Promise.resolve());
  const storageKey = "companion:appearance:v1";
  useEffect(() => {
    let current = true;
    void AsyncStorage.getItem(storageKey).then(value => {
      if (current && !selected.current && value && Object.hasOwn(BUILTIN_SKINS, value)) setSkinId(value as SkinId);
    }).catch(() => undefined);
    void AsyncStorage.getItem(textSizeStorage).then(value => {
      if (current && !textSelected.current && value && Object.hasOwn(TEXT_SIZES, value)) setTextSizeValue(value as TextSize);
    }).catch(() => undefined);
    return () => { current = false; };
  }, []);
  function setSkinById(id: SkinId) {
    selected.current = true;
    setSkinId(id);
    writes.current = writes.current.then(() => AsyncStorage.setItem(storageKey, id)).catch(() => undefined);
  }
  function setTextSize(size: TextSize) {
    textSelected.current = true;
    setTextSizeValue(size);
    writes.current = writes.current.then(() => AsyncStorage.setItem(textSizeStorage, size)).catch(() => undefined);
  }
  const value = useMemo<SkinContextValue>(() => ({
    skin: BUILTIN_SKINS[skinId],
    ui: themePalette(BUILTIN_SKINS[skinId]),
    availableSkins, textSize, setTextSize,
    setSkinById,
  }), [skinId, textSize]);

  return <SkinContext.Provider value={value}>{children}</SkinContext.Provider>;
}

export function useSkin(): SkinContextValue {
  const ctx = useContext(SkinContext);
  if (!ctx) throw new Error("useSkin() must be used inside <SkinProvider>.");
  return ctx;
}

export function useThemedStyles<T extends Record<string, object>>(factory: (ui: UiPalette) => T): T {
  const { ui, textSize } = useSkin();
  const { fontScale } = useWindowDimensions();
  const scale = textSize === "system" ? 1 : fontMagnification[textSize] / (fontScale || 1);
  return useMemo(() => {
    const styles = factory(ui);
    if (scale === 1) return styles;
    // Native text applies the system factor after these base styles.
    return Object.fromEntries(Object.entries(styles).map(([name, style]) => {
      if (!("fontSize" in style) || typeof style.fontSize !== "number") return [name, style];
      return [name, { ...style, fontSize: style.fontSize * scale,
        ...("lineHeight" in style && typeof style.lineHeight === "number" ? { lineHeight: style.lineHeight * scale } : {}) }];
    })) as T;
  }, [factory, ui, scale]);
}
