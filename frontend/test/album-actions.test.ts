import assert from "node:assert/strict";
import test from "node:test";
import {
  buildExportFilename,
  buildNativeShareOptions,
  canUseWebShare,
  detectImageExtensionFromBytes,
  formatQuoteShareText,
  getExportFeedback,
  getShareFeedback,
  isShareAbortError,
  needsMediaLibraryPermission,
  nativeShareFilename,
  resolveImageExtension,
  saveNativeMediaToLibrary,
  shareNativeMediaFile,
  shareTextOnWeb,
} from "../src/album/actions.ts";

test("detectImageExtensionFromBytes identifies real file signatures", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
  const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);
  const heic = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]);

  assert.equal(detectImageExtensionFromBytes(png), "png");
  assert.equal(detectImageExtensionFromBytes(jpg), "jpg");
  assert.equal(detectImageExtensionFromBytes(webp), "webp");
  assert.equal(detectImageExtensionFromBytes(heic), "heic");
  assert.equal(detectImageExtensionFromBytes(new Uint8Array([1, 2])), undefined);
});

test("resolveImageExtension prefers real file bytes and MIME type over fallback path suffix", () => {
  const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(
    resolveImageExtension({ bytes: pngBytes, mimeType: "image/jpeg", localPath: "album-1.jpg", kind: "local_photo" }),
    "png",
  );
  assert.equal(
    resolveImageExtension({ mimeType: "image/webp; charset=utf-8", localPath: "album-1.jpg", kind: "local_photo" }),
    "webp",
  );
  assert.equal(
    resolveImageExtension({ localPath: "album-1.jpeg", kind: "local_photo" }),
    "jpg",
  );
  assert.equal(
    resolveImageExtension({ kind: "room_snapshot" }),
    "png",
  );
});

test("buildExportFilename formats deterministic filenames for polaroids and photos", () => {
  const localNoon = new Date(2026, 10, 26, 12, 0, 0).toISOString();
  const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(
    buildExportFilename({
      kind: "room_snapshot",
      createdAt: localNoon,
      entryId: "album-abc123",
      localPath: "album-abc123.png",
      mimeType: "image/png",
      bytes: pngBytes,
    }),
    "companion-world-polaroid-20261126-abc123.png",
  );
  assert.equal(
    buildExportFilename({
      kind: "local_photo",
      createdAt: localNoon,
      entryId: "album-xyz987",
      localPath: "album-xyz987.jpg",
      mimeType: "image/webp",
    }),
    "companion-world-photo-20261126-xyz987.webp",
  );
});

test("nativeShareFilename replaces wrong suffix without adding a second suffix", () => {
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(nativeShareFilename({ localPath: "album-1.jpg", kind: "local_photo", bytes }), "album-1.png");
  assert.equal(nativeShareFilename({ localPath: "album-1.png", kind: "local_photo", bytes }), "album-1.png");
  assert.equal(nativeShareFilename({ localPath: "album-1", kind: "room_snapshot", bytes }), "album-1.png");
});

test("buildNativeShareOptions sets Android MIME type and avoids duplicate iOS extensions", () => {
  const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.deepEqual(
    buildNativeShareOptions({
      platform: "android",
      localPath: "album-1.jpg",
      kind: "room_snapshot",
      bytes: pngBytes,
    }),
    { mimeType: "image/png", dialogTitle: "分享小家拍立得" },
  );
  assert.deepEqual(
    buildNativeShareOptions({
      platform: "ios",
      localPath: "album-1.png",
      kind: "room_snapshot",
      bytes: pngBytes,
    }),
    {},
  );
  assert.deepEqual(
    buildNativeShareOptions({
      platform: "ios",
      localPath: "album-1.jpg",
      kind: "local_photo",
      bytes: pngBytes,
    }),
    { UTI: "public.png", mimeType: "image/png" },
  );
});

test("formatQuoteShareText keeps speaker, date, and quote text", () => {
  const sentAt = "2026-11-26T12:00:00Z";
  const expectedDate = new Date(sentAt).toLocaleDateString("zh-CN");
  const formatted = formatQuoteShareText({
    speaker: "小星",
    text: "  今晚风很轻，记得早点休息。 ",
    sentAt,
  });
  assert.equal(formatted, `「今晚风很轻，记得早点休息。」\n—— 小星 · ${expectedDate}`);
});

test("canUseWebShare, shareTextOnWeb, and isShareAbortError handle browser share capabilities", async () => {
  assert.equal(canUseWebShare({}), false);
  assert.equal(await shareTextOnWeb("hello", {}), false);

  const shared: Array<{ text?: string }> = [];
  const nav = {
    share: async (data: { text?: string }) => {
      shared.push(data);
    },
  };
  assert.equal(canUseWebShare(nav), true);
  assert.equal(await shareTextOnWeb("hello", nav), true);
  assert.deepEqual(shared, [{ text: "hello" }]);

  assert.equal(isShareAbortError({ name: "AbortError" }), true);
  assert.equal(isShareAbortError({ code: "ERR_SHARING_CANCELED" }), true);
  assert.equal(isShareAbortError(new Error("failed")), false);
});

test("needsMediaLibraryPermission skips runtime permission on Android 10+ and keeps iOS/Android <= 9", () => {
  assert.equal(needsMediaLibraryPermission("ios", "18.1"), true);
  assert.equal(needsMediaLibraryPermission("android", 28), true);
  assert.equal(needsMediaLibraryPermission("android", 29), false);
  assert.equal(needsMediaLibraryPermission("android", 34), false);
  assert.equal(needsMediaLibraryPermission("web"), false);
});

test("saveNativeMediaToLibrary skips permission calls on Android 10+ and saves directly", async () => {
  let permissionChecked = false;
  const savedUris: string[] = [];
  const result = await saveNativeMediaToLibrary({
    requirePermission: false,
    getFileUri: () => "file:///documents/cw-album-v1/album-android10.png",
    getPermission: async () => { permissionChecked = true; return { granted: false }; },
    requestPermission: async () => { permissionChecked = true; return { granted: false }; },
    createAsset: async (uri) => { savedUris.push(uri); },
  });
  assert.deepEqual(result, { status: "saved" });
  assert.equal(permissionChecked, false);
  assert.deepEqual(savedUris, ["file:///documents/cw-album-v1/album-android10.png"]);
});

test("saveNativeMediaToLibrary skips permission prompt when local file is missing", async () => {
  let asked = false;
  let saved = false;
  const result = await saveNativeMediaToLibrary({
    getFileUri: () => undefined,
    getPermission: async () => { asked = true; return { granted: true }; },
    requestPermission: async () => { asked = true; return { granted: true }; },
    createAsset: async () => { saved = true; },
  });
  assert.deepEqual(result, { status: "missing" });
  assert.equal(asked, false);
  assert.equal(saved, false);
});

test("saveNativeMediaToLibrary requests permission on demand and saves original file URI", async () => {
  const calls: string[] = [];
  const result = await saveNativeMediaToLibrary({
    getFileUri: () => "file:///documents/cw-album-v1/album-1.png",
    getPermission: async () => {
      calls.push("get");
      return { granted: false, canAskAgain: true };
    },
    requestPermission: async () => {
      calls.push("request");
      return { granted: true, canAskAgain: true };
    },
    createAsset: async (uri) => {
      calls.push(`create:${uri}`);
    },
  });
  assert.deepEqual(result, { status: "saved" });
  assert.deepEqual(calls, ["get", "request", "create:file:///documents/cw-album-v1/album-1.png"]);
});

test("saveNativeMediaToLibrary returns denied immediately when canAskAgain is false without re-requesting", async () => {
  let requested = false;
  let created = false;
  const result = await saveNativeMediaToLibrary({
    getFileUri: () => "file:///documents/cw-album-v1/album-2.jpg",
    getPermission: async () => ({ granted: false, canAskAgain: false }),
    requestPermission: async () => {
      requested = true;
      return { granted: false, canAskAgain: false };
    },
    createAsset: async () => {
      created = true;
    },
  });
  assert.deepEqual(result, { status: "denied", canAskAgain: false });
  assert.equal(requested, false);
  assert.equal(created, false);
});

test("saveNativeMediaToLibrary handles user denial and save failures without faking success", async () => {
  let createCalled = false;
  const denied = await saveNativeMediaToLibrary({
    getFileUri: () => "file:///documents/cw-album-v1/album-2.jpg",
    getPermission: async () => ({ granted: false, canAskAgain: true }),
    requestPermission: async () => ({ granted: false, canAskAgain: true }),
    createAsset: async () => { createCalled = true; },
  });
  assert.deepEqual(denied, { status: "denied", canAskAgain: true });
  assert.equal(createCalled, false);

  const failed = await saveNativeMediaToLibrary({
    getFileUri: () => "file:///documents/cw-album-v1/album-2.jpg",
    getPermission: async () => ({ granted: true }),
    requestPermission: async () => ({ granted: true }),
    createAsset: async () => { throw new Error("disk full"); },
  });
  assert.equal(failed.status, "failed");
});

test("shareNativeMediaFile checks file existence, availability, cancel, and failure without faking success", async () => {
  let checkedAvailable = false;
  const missing = await shareNativeMediaFile({
    getFileUri: () => undefined,
    isAvailable: async () => { checkedAvailable = true; return true; },
    shareFile: async () => undefined,
  });
  assert.deepEqual(missing, { status: "missing" });
  assert.equal(checkedAvailable, false);

  const unavailable = await shareNativeMediaFile({
    getFileUri: () => "file:///documents/cw-album-v1/album-1.png",
    isAvailable: async () => false,
    shareFile: async () => undefined,
  });
  assert.deepEqual(unavailable, { status: "unavailable", reason: "system" });

  const sharedUris: string[] = [];
  const completed = await shareNativeMediaFile({
    getFileUri: () => "file:///documents/cw-album-v1/album-1.png",
    isAvailable: async () => true,
    shareFile: async (uri) => { sharedUris.push(uri); },
  });
  assert.deepEqual(completed, { status: "completed" });
  assert.deepEqual(sharedUris, ["file:///documents/cw-album-v1/album-1.png"]);

  const canceled = await shareNativeMediaFile({
    getFileUri: () => "file:///documents/cw-album-v1/album-1.png",
    isAvailable: async () => true,
    shareFile: async () => { throw { name: "AbortError" }; },
  });
  assert.deepEqual(canceled, { status: "canceled" });

  const failed = await shareNativeMediaFile({
    getFileUri: () => "file:///documents/cw-album-v1/album-1.png",
    isAvailable: async () => true,
    shareFile: async () => { throw new Error("share sheet failed"); },
  });
  assert.equal(failed.status, "failed");
});

test("getExportFeedback and getShareFeedback map states accurately without faking share success", () => {
  assert.deepEqual(getExportFeedback({ status: "saved" }, false), {
    message: "已保存到系统相册。",
    isError: false,
  });
  assert.deepEqual(getExportFeedback({ status: "denied", canAskAgain: false }, false), {
    message: "未获得系统相册写入权限，请在系统设置中开启后重试。",
    isError: true,
  });
  assert.deepEqual(getExportFeedback({ status: "denied", canAskAgain: true }, false), {
    message: "未获得系统相册写入权限，无法保存。",
    isError: true,
  });
  assert.deepEqual(getExportFeedback({ status: "unavailable" }, false), {
    message: "当前安装包暂不支持保存到系统相册，请更新应用后重试。",
    isError: true,
  });
  assert.deepEqual(getExportFeedback({ status: "missing" }, false), {
    message: "这张照片的本地文件已失效，无法保存。",
    isError: true,
  });
  assert.equal(getExportFeedback({ status: "canceled" }, false), undefined);

  assert.equal(getShareFeedback({ status: "completed" }), undefined);
  assert.equal(getShareFeedback({ status: "canceled" }), undefined);
  assert.deepEqual(getShareFeedback({ status: "missing" }), {
    message: "这张照片的本地文件已失效，无法分享。",
    isError: true,
  });
  assert.deepEqual(getShareFeedback({ status: "unavailable", reason: "module" }), {
    message: "当前安装包暂不支持分享图片，请更新应用后重试。",
    isError: true,
  });
  assert.deepEqual(getShareFeedback({ status: "unavailable", reason: "system" }), {
    message: "当前设备暂不支持分享图片。",
    isError: true,
  });
});
