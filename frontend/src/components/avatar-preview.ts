import { File } from "expo-file-system";
import type { ImagePickerAsset } from "expo-image-picker";
import { Platform } from "react-native";

const MAX_SOURCE_BYTES = 24 * 1024 * 1024;
const MAX_SOURCE_PIXELS = 50_000_000;
const MAX_PREVIEW_BYTES = 1024 * 1024;
const MAX_PREVIEW_EDGE = 512;
const JPEG_QUALITY = 0.85;

export type AvatarPreview = { uri: string; release: () => void };
export class AvatarPreviewError extends Error {}

function checkDimensions(width: number, height: number) {
  if (width * height > MAX_SOURCE_PIXELS) {
    throw new AvatarPreviewError("这张照片像素太高，请选一张较小的图片。");
  }
}

function checkFormat(asset: ImagePickerAsset) {
  const mime = asset.mimeType?.toLowerCase();
  const name = asset.fileName ?? asset.uri.split(/[?#]/)[0];
  const heic = /\.(heic|heif)$/i.test(name) || /^image\/(heic|heif)$/i.test(mime ?? "");
  if (heic && Platform.OS === "web") {
    throw new AvatarPreviewError("网页预览暂不支持 HEIC，请选 JPG、PNG 或 WebP。");
  }
  const raster = mime && mime !== "application/octet-stream"
    ? /^image\/(jpe?g|png|webp|heic|heif)$/.test(mime)
    : /\.(jpe?g|png|webp|heic|heif)$/i.test(name);
  if ((asset.type && asset.type !== "image") || !raster) {
    throw new AvatarPreviewError("请选择 JPG、PNG、WebP 或手机可读取的 HEIC 照片。");
  }
}

export async function prepareAvatarPreview(asset: ImagePickerAsset): Promise<AvatarPreview> {
  const web = Platform.OS === "web";
  try {
    if (web ? !asset.uri.startsWith("blob:") : !/^(file|content|ph):/.test(asset.uri)) {
      throw new AvatarPreviewError("照片文件不可用，请重新选择。");
    }
    checkFormat(asset);
    const sourceBytes = asset.fileSize ?? asset.file?.size ?? (web ? undefined : new File(asset.uri).size);
    if (sourceBytes !== undefined && sourceBytes > MAX_SOURCE_BYTES) {
      throw new AvatarPreviewError("照片超过 24 MB，请选一张较小的图片。");
    }
    checkDimensions(asset.width, asset.height);

    const { ImageManipulator, SaveFormat } = await import("expo-image-manipulator");
    const context = ImageManipulator.manipulate(asset.uri);
    let image: Awaited<ReturnType<typeof context.renderAsync>> | undefined;
    try {
      image = await context.renderAsync();
      const { width, height } = image;
      if (width <= 0 || height <= 0) throw new AvatarPreviewError("无法读取这张照片，请重新选择。");
      checkDimensions(width, height);

      const edge = Math.min(width, height);
      if (width !== height) {
        context.crop({
          originX: Math.floor((width - edge) / 2),
          originY: Math.floor((height - edge) / 2),
          width: edge,
          height: edge,
        });
      }
      if (edge > MAX_PREVIEW_EDGE) context.resize({ width: MAX_PREVIEW_EDGE });
      if (width !== height || edge > MAX_PREVIEW_EDGE) {
        image.release();
        image = undefined;
        image = await context.renderAsync();
      }
      const output = await image.saveAsync({ format: SaveFormat.JPEG, compress: JPEG_QUALITY });
      const file = web ? undefined : new File(output.uri);
      const release = () => {
        if (web) URL.revokeObjectURL(output.uri);
        else {
          try { file?.delete(); } catch { /* The system may already have cleared this cache file. */ }
        }
      };
      try {
        const bytes = file ? file.size : (await (await fetch(output.uri)).blob()).size;
        if (!bytes || bytes > MAX_PREVIEW_BYTES) {
          throw new AvatarPreviewError("无法生成 1 MB 以内的预览，请换一张照片。");
        }
        return { uri: output.uri, release };
      } catch (error) {
        release();
        throw error;
      }
    } finally {
      image?.release();
      context.release();
    }
  } finally {
    if (web && asset.uri.startsWith("blob:")) URL.revokeObjectURL(asset.uri);
  }
}
