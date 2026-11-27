import { buildExportFilename, type ExportMediaOptions, type ExportMediaResult } from "./actions";

let database: Promise<IDBDatabase> | undefined;

function openDatabase() {
  database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("cw-album-v1", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("media");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }).catch(error => { database = undefined; throw error; });
  return database;
}

async function mediaRequest<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction("media", mode);
    const request = operation(transaction.objectStore("media"));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onabort = transaction.onerror = () => reject(transaction.error ?? request.error);
  });
}

export async function keepMedia(path: string, uri: string): Promise<void> {
  const response = await fetch(uri);
  if (!response.ok) throw new Error("无法读取所选图片。");
  const blob = await response.blob();
  await mediaRequest("readwrite", store => store.put(blob, path));
}

export async function findMedia(path: string): Promise<string | undefined> {
  const blob = await mediaRequest<Blob | undefined>("readonly", store => store.get(path));
  return blob ? URL.createObjectURL(blob) : undefined;
}

export async function removeMedia(path: string): Promise<void> {
  await mediaRequest("readwrite", store => store.delete(path));
}

export async function exportMedia(path: string, options: ExportMediaOptions): Promise<ExportMediaResult> {
  if (typeof document === "undefined" || !document.body) {
    return { status: "unsupported" };
  }
  try {
    const blob = await mediaRequest<Blob | undefined>("readonly", store => store.get(path));
    if (!blob || blob.size === 0) return { status: "missing" };
    let headerBytes: Uint8Array | undefined;
    try {
      headerBytes = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
    } catch {
      headerBytes = undefined;
    }
    const filename = buildExportFilename({
      kind: options.kind,
      createdAt: options.createdAt,
      entryId: options.entryId,
      localPath: path,
      mimeType: blob.type,
      bytes: headerBytes,
    });
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = filename;
    anchor.rel = "noopener";
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    try {
      anchor.click();
    } finally {
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    }
    return { status: "exported", filename };
  } catch {
    return { status: "failed", message: "照片导出失败，请稍后重试。" };
  }
}
