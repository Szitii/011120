import { Platform } from "react-native";
import { Directory, File, Paths } from "expo-file-system";
import {
  buildNativeShareOptions,
  nativeShareFilename,
  needsMediaLibraryPermission,
  saveNativeMediaToLibrary,
  shareNativeMediaFile,
  type ExportMediaOptions,
  type ExportMediaResult,
  type ShareMediaResult,
} from "./actions";

const directory = new Directory(Paths.document, "cw-album-v1");

async function loadMediaLibrary() {
  try {
    const mod = await import("expo-media-library");
    if (typeof mod?.Asset?.create !== "function") return undefined;
    return mod;
  } catch {
    return undefined;
  }
}

// SDK 58 documents the legacy entry point for these permission functions.
// Load only when needed so Android 10+ does not need the legacy module.
async function loadMediaLibraryPermissions() {
  try {
    const mod = await import("expo-media-library/legacy");
    if (typeof mod.getPermissionsAsync !== "function" || typeof mod.requestPermissionsAsync !== "function") {
      return undefined;
    }
    return mod;
  } catch {
    return undefined;
  }
}

async function loadSharing() {
  try {
    const mod = await import("expo-sharing");
    if (typeof mod?.isAvailableAsync !== "function" || typeof mod?.shareAsync !== "function") {
      return undefined;
    }
    return mod;
  } catch {
    return undefined;
  }
}

function readHeaderBytes(file: File): Uint8Array | undefined {
  try {
    const handle = file.open();
    try {
      return handle.readBytesSync(16);
    } finally {
      handle.close();
    }
  } catch {
    return undefined;
  }
}

export async function keepMedia(path: string, uri: string): Promise<void> {
  directory.create({ idempotent: true, intermediates: true });
  new File(uri).copy(new File(directory, path));
}

export async function findMedia(path: string): Promise<string | undefined> {
  const file = new File(directory, path);
  return file.exists ? file.uri : undefined;
}

export async function removeMedia(path: string): Promise<void> {
  const file = new File(directory, path);
  if (file.exists) file.delete();
  try {
    const cached = new Directory(Paths.cache, "cw-album-share-v1", path);
    if (cached.exists) cached.delete();
  } catch { /* OS can evict this temporary cache. */ }
}

export async function exportMedia(path: string, _options: ExportMediaOptions): Promise<ExportMediaResult> {
  if (Platform.OS !== "ios" && Platform.OS !== "android") {
    return { status: "unsupported" };
  }
  const mediaLibrary = await loadMediaLibrary();
  if (!mediaLibrary) {
    return { status: "unavailable" };
  }
  const requirePermission = needsMediaLibraryPermission(Platform.OS, Platform.Version);
  const permissions = requirePermission ? await loadMediaLibraryPermissions() : undefined;
  if (requirePermission && !permissions) return { status: "unavailable" };
  return saveNativeMediaToLibrary({
    requirePermission,
    getFileUri: () => {
      const file = new File(directory, path);
      return file.exists ? file.uri : undefined;
    },
    getPermission: async () => {
      if (!permissions) throw new Error("Media library permission API unavailable");
      return permissions.getPermissionsAsync(true, Platform.OS === "android" ? [] : undefined);
    },
    requestPermission: async () => {
      if (!permissions) throw new Error("Media library permission API unavailable");
      return permissions.requestPermissionsAsync(true, Platform.OS === "android" ? [] : undefined);
    },
    createAsset: (fileUri) => mediaLibrary.Asset.create(fileUri),
  });
}

export async function shareMedia(path: string, options: ExportMediaOptions): Promise<ShareMediaResult> {
  if (Platform.OS !== "ios" && Platform.OS !== "android") {
    return { status: "unsupported" };
  }
  const platform = Platform.OS;
  const sharing = await loadSharing();
  if (!sharing) {
    return { status: "unavailable", reason: "module" };
  }
  return shareNativeMediaFile({
    getFileUri: () => {
      const file = new File(directory, path);
      return file.exists ? file.uri : undefined;
    },
    isAvailable: () => sharing.isAvailableAsync(),
    shareFile: async (fileUri) => {
      const file = new File(directory, path);
      const bytes = readHeaderBytes(file);
      const filename = nativeShareFilename({ localPath: path, kind: options.kind, bytes });
      let shareUri = fileUri;
      if (filename !== path) {
        // Keep the original untouched; retain the temporary copy for recipients
        // that read the shared URI after the system chooser closes.
        const cache = new Directory(Paths.cache, "cw-album-share-v1", path);
        cache.create({ idempotent: true, intermediates: true });
        const copy = new File(cache, filename);
        await file.copy(copy, { overwrite: true });
        shareUri = copy.uri;
      }
      const shareOptions = buildNativeShareOptions({
        platform,
        localPath: filename,
        kind: options.kind,
        bytes,
      });
      await sharing.shareAsync(shareUri, shareOptions);
    },
  });
}
