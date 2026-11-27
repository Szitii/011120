import type { QuoteInput } from "./store.ts";

export type AlbumPhotoKind = "room_snapshot" | "local_photo";

export type ExportMediaResult =
  | { status: "exported"; filename: string }
  | { status: "missing" }
  | { status: "unsupported" }
  | { status: "canceled" }
  | { status: "denied" }
  | { status: "failed"; message: string };

export interface ExportMediaOptions {
  kind: AlbumPhotoKind;
  createdAt: string;
  entryId: string;
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
  return typeof error === "object" && error !== null && "name" in error && (error as { name?: unknown }).name === "AbortError";
}
