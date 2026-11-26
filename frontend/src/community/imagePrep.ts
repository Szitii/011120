import { File } from "expo-file-system";
import type { ImagePickerAsset } from "expo-image-picker";
import { Platform } from "react-native";

export const MAX_POST_IMAGE_BYTES = 1_048_576;
const MAX_LONG_EDGE = 1600;
const TARGET_MAX_BYTES = 980_000;
const NATIVE_JPEG_QUALITIES = [0.82, 0.68, 0.52, 0.36];

export type AllowedImageMime = "image/jpeg" | "image/png" | "image/webp";
export type AllowedImageExt = "jpg" | "png" | "webp";

export interface PreparedPostImage {
  previewUri: string;
  revokePreview?: () => void;
  contentType: AllowedImageMime;
  ext: AllowedImageExt;
  width?: number;
  height?: number;
}

export function randomUuidLower(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID().toLowerCase();
  }
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function resolveMimeAndExt(asset: ImagePickerAsset): { contentType: AllowedImageMime; ext: AllowedImageExt } | undefined {
  const mime = asset.mimeType?.toLowerCase();
  if (mime === "image/jpeg" || mime === "image/jpg") return { contentType: "image/jpeg", ext: "jpg" };
  if (mime === "image/png") return { contentType: "image/png", ext: "png" };
  if (mime === "image/webp") return { contentType: "image/webp", ext: "webp" };
  const name = (asset.fileName ?? asset.uri).split("?")[0]?.toLowerCase() ?? "";
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return { contentType: "image/jpeg", ext: "jpg" };
  if (name.endsWith(".png")) return { contentType: "image/png", ext: "png" };
  if (name.endsWith(".webp")) return { contentType: "image/webp", ext: "webp" };
  return undefined;
}

function isHeicLike(asset: ImagePickerAsset): boolean {
  const mime = asset.mimeType?.toLowerCase() ?? "";
  const name = (asset.fileName ?? asset.uri).split("?")[0]?.toLowerCase() ?? "";
  return mime.includes("heic") || mime.includes("heif") || name.endsWith(".heic") || name.endsWith(".heif");
}

async function compressWebImage(uri: string): Promise<PreparedPostImage> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const element = new window.Image();
    element.onload = () => resolve(element);
    element.onerror = () => reject(new Error("无法解码所选图片。"));
    element.src = uri;
  });
  const srcWidth = img.naturalWidth || img.width;
  const srcHeight = img.naturalHeight || img.height;
  const scale = Math.min(1, MAX_LONG_EDGE / Math.max(srcWidth || 1, srcHeight || 1));
  const width = Math.max(1, Math.round(srcWidth * scale));
  const height = Math.max(1, Math.round(srcHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("当前浏览器不支持图片压缩。");
  ctx.drawImage(img, 0, 0, width, height);

  let chosen: Blob | null = null;
  for (const quality of [0.8, 0.65, 0.5, 0.35]) {
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/jpeg", quality));
    if (!blob) continue;
    chosen = blob;
    if (blob.size <= TARGET_MAX_BYTES) break;
  }
  if (!chosen || chosen.size > MAX_POST_IMAGE_BYTES) {
    throw new Error("单张图片压缩后仍超过 1 MB，请换一张小一点的图片。");
  }
  const previewUri = URL.createObjectURL(chosen);
  return {
    previewUri,
    revokePreview: () => URL.revokeObjectURL(previewUri),
    contentType: "image/jpeg",
    ext: "jpg",
    width,
    height,
  };
}

function removeTemporaryImage(file: File) {
  try {
    file.delete();
  } catch {
    // The OS may already have cleared the cache file.
  }
}

async function compressNativeImage(asset: ImagePickerAsset): Promise<PreparedPostImage> {
  const format = resolveMimeAndExt(asset);
  const originalFile = new File(asset.uri);
  const hasDimensions = asset.width > 0 && asset.height > 0;
  const size = originalFile.size;
  if (format && !isHeicLike(asset) && hasDimensions
    && Math.max(asset.width, asset.height) <= MAX_LONG_EDGE && size > 0 && size <= TARGET_MAX_BYTES) {
    return {
      previewUri: asset.uri,
      contentType: format.contentType,
      ext: format.ext,
      width: Math.round(asset.width),
      height: Math.round(asset.height),
    };
  }

  const { ImageManipulator, SaveFormat } = await import("expo-image-manipulator").catch(() => {
    throw new Error("当前版本无法处理这张图片，请更新应用或选择另一张图片。");
  });
  const context = ImageManipulator.manipulate(asset.uri);
  let image: Awaited<ReturnType<typeof context.renderAsync>> | undefined;
  try {
    image = await context.renderAsync();
    if (Math.max(image.width, image.height) > MAX_LONG_EDGE) {
      context.resize(image.width >= image.height ? { width: MAX_LONG_EDGE } : { height: MAX_LONG_EDGE });
      image.release();
      image = undefined;
      image = await context.renderAsync();
    }
    for (const [index, compress] of NATIVE_JPEG_QUALITIES.entries()) {
      const out = await image.saveAsync({ compress, format: SaveFormat.JPEG });
      const file = new File(out.uri);
      const size = file.size;
      const limit = index === NATIVE_JPEG_QUALITIES.length - 1 ? MAX_POST_IMAGE_BYTES : TARGET_MAX_BYTES;
      if (size > 0 && size <= limit) {
        return {
          previewUri: out.uri,
          revokePreview: () => removeTemporaryImage(file),
          contentType: "image/jpeg",
          ext: "jpg",
          width: out.width,
          height: out.height,
        };
      }
      removeTemporaryImage(file);
    }
  } finally {
    image?.release();
    context.release();
  }

  throw new Error("单张图片压缩后仍超过 1 MB，请换一张小一点的图片。");
}

export async function preparePostImage(asset: ImagePickerAsset): Promise<PreparedPostImage> {
  if (Platform.OS === "web" && typeof document !== "undefined") {
    return compressWebImage(asset.uri);
  }
  return compressNativeImage(asset);
}

export async function readMediaBytes(uri: string): Promise<ArrayBuffer> {
  if (Platform.OS === "web") {
    const response = await fetch(uri);
    if (!response.ok) throw new Error("无法读取草稿照片。");
    return response.arrayBuffer();
  }
  return new File(uri).arrayBuffer();
}
