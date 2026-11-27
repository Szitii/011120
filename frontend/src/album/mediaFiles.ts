import { Directory, File, Paths } from "expo-file-system";
import type { ExportMediaOptions, ExportMediaResult } from "./actions";

const directory = new Directory(Paths.document, "cw-album-v1");

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
  const file = new File(directory, path);
  if (!file.exists) return { status: "missing" };
  return { status: "unsupported" };
}
