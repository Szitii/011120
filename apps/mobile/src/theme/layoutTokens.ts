/**
 * Companion World — Fixed Structural Layout Tokens
 * 换肤时保持不变的骨架规范，确保任意皮肤下排版与可读性稳定。
 */

export const SPACING = {
  xxs: 4,
  xs: 8,
  sm: 12,
  md: 16,
  lg: 20,
  xl: 24,
} as const;

export const RADIUS = {
  sm: 10,
  md: 16,
  lg: 20,
  xl: 26,
  bubble: 20,
  bubbleTail: 6,
  pill: 999,
} as const;

export const CHROME = {
  headerHeight: 54,
  companionStripHeight: 32,
  floatingDockHeight: 60,
  floatingDockInset: 16,
  floatingDockBottom: 12,
  scrollBottomClearance: 96,
} as const;
