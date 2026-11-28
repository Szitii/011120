/**
 * Fetching a chat picture so a model can look at it.
 *
 * No server holds a Storage key. A picture is read with the Owner's own sign-in, the one of the
 * request that started the Companion's turn, under the same Storage rule as the app (one's own
 * chat pictures, migration 0086). So a turn no request started (a reminder, writing first) fetches
 * nothing: it reads the descriptions that are already there.
 */
import type { Picture } from "./port.ts";

/** Gets a chat picture by its path ("chat/<uuid>.jpg"). null: it cannot be had, or it is not a picture a model takes. */
export type Pictures = (path: string) => Promise<Picture | null>;

const PATH = /^chat\/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}[.](jpg|png|webp)$/;
/** The bucket takes files of 1 MB. */
const MAX_BYTES = 1_048_576;
const TIMEOUT_MS = 10_000;

/** What the bytes are, read from the bytes themselves (never from the name or a header). */
export function pictureType(bytes: Uint8Array): Picture["mime"] | null {
  const starts = (at: number, ...head: number[]) => head.every((byte, i) => bytes[at + i] === byte);
  if (starts(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (starts(0, 0x52, 0x49, 0x46, 0x46) && starts(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  return null;
}

/** Pictures from the project's Storage, read as the Owner whose sign-in token this is. */
export function storagePictures(project: URL, publishableKey: string, bearerToken: string, get: typeof fetch = fetch): Pictures {
  return async path => {
    if (!PATH.test(path)) return null;
    try {
      const response = await get(new URL(`/storage/v1/object/authenticated/media/${path}`, project),
        { headers: { apikey: publishableKey, authorization: `Bearer ${bearerToken}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!response.ok) return null;
      const bytes = new Uint8Array(await response.arrayBuffer());
      const mime = bytes.length > MAX_BYTES ? null : pictureType(bytes);
      return mime === null ? null : { mime, base64: Buffer.from(bytes).toString("base64") };
    } catch {
      return null;
    }
  };
}
