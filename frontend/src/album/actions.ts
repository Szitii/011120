import type { QuoteInput } from "./store.ts";

export type AlbumPhotoKind = "room_snapshot" | "local_photo";

export type ExportMediaResult =
  | { status: "exported"; filename: string }
  | { status: "saved" }
  | { status: "missing" }
  | { status: "unsupported" }
  | { status: "unavailable" }
  | { status: "canceled" }
  | { status: "denied"; canAskAgain?: boolean }
  | { status: "failed"; message: string };

export type ShareMediaResult =
  | { status: "completed" }
  | { status: "missing" }
  | { status: "unsupported" }
  | { status: "unavailable"; reason?: "module" | "system" }
  | { status: "canceled" }
  | { status: "failed"; message: string };

export interface ExportMediaOptions {
  kind: AlbumPhotoKind;
  createdAt: string;
  entryId: string;
}

export interface MediaPermissionResult {
  granted: boolean;
  canAskAgain?: boolean;
}

export interface NativeMediaSaveDeps {
  requirePermission?: boolean;
  getFileUri: () => string | undefined;
  getPermission: () => Promise<MediaPermissionResult>;
  requestPermission: () => Promise<MediaPermissionResult>;
  createAsset: (fileUri: string) => Promise<unknown>;
}

export interface NativeShareOptions {
  mimeType?: string;
  UTI?: string;
  dialogTitle?: string;
}

export interface NativeMediaShareDeps {
  getFileUri: () => string | undefined;
  isAvailable: () => Promise<boolean>;
  shareFile: (fileUri: string) => Promise<void>;
}

const MIME_TO_EXTENSION: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/svg+xml": "svg",
};

const EXTENSION_TO_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  heic: "image/heic",
  heif: "image/heif",
  avif: "image/avif",
  bmp: "image/bmp",
  svg: "image/svg+xml",
};

const EXTENSION_TO_UTI: Record<string, string> = {
  jpg: "public.jpeg",
  png: "public.png",
  webp: "org.webmproject.webp",
  gif: "com.compuserve.gif",
  heic: "public.heic",
  heif: "public.heif",
  avif: "public.avif",
  bmp: "com.microsoft.bmp",
  svg: "public.svg-image",
};

const VALID_EXTENSION = /^[a-z0-9]{1,8}$/i;

export function detectImageExtensionFromBytes(bytes?: Uint8Array | null): string | undefined {
  if (!bytes || bytes.length < 4) return undefined;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return "gif";
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return "bmp";
  if (
    bytes.length >= 12
    && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return "webp";
  }
  if (
    bytes.length >= 12
    && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70
  ) {
    const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]).toLowerCase();
    if (brand === "avif" || brand === "avis") return "avif";
    if (brand === "heic" || brand === "heix" || brand === "hevc" || brand === "hevx" || brand === "mif1") {
      return "heic";
    }
    if (brand === "heif" || brand === "msf1") return "heif";
  }
  return undefined;
}

export function extensionFromMimeType(mimeType?: string | null): string | undefined {
  if (!mimeType) return undefined;
  const normalized = mimeType.split(";")[0].trim().toLowerCase();
  return MIME_TO_EXTENSION[normalized];
}

export function extensionFromPath(path?: string | null): string | undefined {
  if (!path) return undefined;
  const dot = path.lastIndexOf(".");
  if (dot < 0 || dot === path.length - 1) return undefined;
  const raw = path.slice(dot + 1).toLowerCase();
  if (!VALID_EXTENSION.test(raw)) return undefined;
  return raw === "jpeg" ? "jpg" : raw;
}

export function resolveImageExtension(input: {
  bytes?: Uint8Array | null;
  mimeType?: string | null;
  localPath?: string | null;
  kind: AlbumPhotoKind;
}): string {
  return (
    detectImageExtensionFromBytes(input.bytes)
    ?? extensionFromMimeType(input.mimeType)
    ?? extensionFromPath(input.localPath)
    ?? (input.kind === "room_snapshot" ? "png" : "jpg")
  );
}

export function nativeShareFilename(input: { localPath: string; kind: AlbumPhotoKind; bytes?: Uint8Array | null }): string {
  const ext = resolveImageExtension(input);
  if (extensionFromPath(input.localPath) === ext) return input.localPath;
  return input.localPath.replace(/\.[^.]+$/, "") + "." + ext;
}

export function buildNativeShareOptions(input: {
  platform: "ios" | "android";
  localPath?: string | null;
  kind: AlbumPhotoKind;
  bytes?: Uint8Array | null;
}): NativeShareOptions {
  const resolvedExt = resolveImageExtension({
    bytes: input.bytes,
    localPath: input.localPath,
    kind: input.kind,
  });
  const mimeType = EXTENSION_TO_MIME[resolvedExt] ?? "image/*";
  if (input.platform === "android") {
    return {
      mimeType,
      dialogTitle: input.kind === "room_snapshot" ? "分享小家拍立得" : "分享照片",
    };
  }
  const pathExt = extensionFromPath(input.localPath);
  if (pathExt === resolvedExt) {
    return {};
  }
  const uti = EXTENSION_TO_UTI[resolvedExt];
  return uti ? { UTI: uti, mimeType } : { mimeType };
}

function compactDate(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "undated";
  const year = String(parsed.getFullYear());
  const month = String(parsed.getMonth() + 1).padStart(2, "0");
  const day = String(parsed.getDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

export function buildExportFilename(input: {
  kind: AlbumPhotoKind;
  createdAt: string;
  entryId: string;
  localPath?: string | null;
  mimeType?: string | null;
  bytes?: Uint8Array | null;
}): string {
  const prefix = input.kind === "room_snapshot" ? "companion-world-polaroid" : "companion-world-photo";
  const datePart = compactDate(input.createdAt);
  const cleanId = input.entryId.replace(/[^a-z0-9]/gi, "").slice(-6).toLowerCase();
  const suffix = cleanId ? `-${cleanId}` : "";
  const ext = resolveImageExtension({
    bytes: input.bytes,
    mimeType: input.mimeType,
    localPath: input.localPath,
    kind: input.kind,
  });
  return `${prefix}-${datePart}${suffix}.${ext}`;
}

export function needsMediaLibraryPermission(platform: string, version?: string | number): boolean {
  if (platform === "ios") return true;
  if (platform === "android") {
    const apiLevel = typeof version === "number" ? version : Number.parseInt(String(version ?? ""), 10);
    return Number.isNaN(apiLevel) || apiLevel < 29;
  }
  return false;
}

export async function saveNativeMediaToLibrary(deps: NativeMediaSaveDeps): Promise<ExportMediaResult> {
  if (!deps.getFileUri()) return { status: "missing" };
  try {
    if (deps.requirePermission !== false) {
      const existing = await deps.getPermission();
      if (!existing.granted && existing.canAskAgain === false) {
        return { status: "denied", canAskAgain: false };
      }
      const permission = existing.granted ? existing : await deps.requestPermission();
      if (!permission.granted) {
        return { status: "denied", canAskAgain: permission.canAskAgain };
      }
    }
    const latestUri = deps.getFileUri();
    if (!latestUri) return { status: "missing" };
    await deps.createAsset(latestUri);
    return { status: "saved" };
  } catch {
    return { status: "failed", message: "保存到系统相册失败，请稍后重试。" };
  }
}

export async function shareNativeMediaFile(deps: NativeMediaShareDeps): Promise<ShareMediaResult> {
  if (!deps.getFileUri()) return { status: "missing" };
  try {
    const available = await deps.isAvailable();
    if (!available) return { status: "unavailable", reason: "system" };
    const latestUri = deps.getFileUri();
    if (!latestUri) return { status: "missing" };
    await deps.shareFile(latestUri);
    return { status: "completed" };
  } catch (error) {
    if (isShareAbortError(error)) return { status: "canceled" };
    return { status: "failed", message: "未能调起系统分享，请稍后重试。" };
  }
}

export function getExportFeedback(
  result: ExportMediaResult,
  isWeb: boolean,
): { message: string; isError: boolean } | undefined {
  if (result.status === "exported") {
    return { message: `已开始下载：${result.filename}`, isError: false };
  }
  if (result.status === "saved") {
    return { message: "已保存到系统相册。", isError: false };
  }
  if (result.status === "missing") {
    return {
      message: isWeb ? "这张照片的本地文件已失效，无法导出。" : "这张照片的本地文件已失效，无法保存。",
      isError: true,
    };
  }
  if (result.status === "denied") {
    return {
      message: result.canAskAgain === false
        ? "未获得系统相册写入权限，请在系统设置中开启后重试。"
        : "未获得系统相册写入权限，无法保存。",
      isError: true,
    };
  }
  if (result.status === "unavailable") {
    return {
      message: "当前安装包暂不支持保存到系统相册，请更新应用后重试。",
      isError: true,
    };
  }
  if (result.status === "canceled") return undefined;
  if (result.status === "unsupported") {
    return {
      message: isWeb ? "当前环境暂不支持导出原图。" : "当前设备暂不支持保存到系统相册。",
      isError: true,
    };
  }
  return { message: result.message, isError: true };
}

export function getShareFeedback(
  result: ShareMediaResult,
): { message: string; isError: boolean } | undefined {
  if (result.status === "completed" || result.status === "canceled") return undefined;
  if (result.status === "missing") {
    return { message: "这张照片的本地文件已失效，无法分享。", isError: true };
  }
  if (result.status === "unavailable") {
    return {
      message: result.reason === "module"
        ? "当前安装包暂不支持分享图片，请更新应用后重试。"
        : "当前设备暂不支持分享图片。",
      isError: true,
    };
  }
  if (result.status === "unsupported") {
    return { message: "当前环境暂不支持分享图片。", isError: true };
  }
  return { message: result.message, isError: true };
}

export function formatAlbumDate(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toLocaleDateString("zh-CN");
}

export function formatQuoteShareText(quote: Pick<QuoteInput, "speaker" | "text" | "sentAt">): string {
  const text = quote.text.trim();
  const speaker = quote.speaker.trim() || "聊天金句";
  const date = formatAlbumDate(quote.sentAt);
  const meta = date ? `—— ${speaker} · ${date}` : `—— ${speaker}`;
  return text ? `「${text}」\n${meta}` : meta;
}

interface WebShareNavigator {
  share?: (data: { text?: string; title?: string; url?: string }) => Promise<void>;
}

export function canUseWebShare(
  nav: WebShareNavigator | undefined = (globalThis as { navigator?: WebShareNavigator }).navigator,
): boolean {
  return typeof nav?.share === "function";
}

export async function shareTextOnWeb(
  text: string,
  nav: WebShareNavigator | undefined = (globalThis as { navigator?: WebShareNavigator }).navigator,
): Promise<boolean> {
  if (typeof nav?.share !== "function") return false;
  await nav.share({ text });
  return true;
}

export function isShareAbortError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { name?: unknown; code?: unknown };
  if (candidate.name === "AbortError") return true;
  if (typeof candidate.code === "string" && /cancel/i.test(candidate.code)) return true;
  return false;
}
