import { Platform } from "react-native";
import { Directory, File, Paths } from "expo-file-system";
import {
  needsMediaLibraryPermission,
  saveNativeMediaToLibrary,
  type ExportMediaOptions,
  type ExportMediaResult,
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
