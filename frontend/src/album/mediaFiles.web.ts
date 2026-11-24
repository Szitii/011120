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
