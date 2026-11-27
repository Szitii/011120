import assert from "node:assert/strict";
import test from "node:test";
import {
  buildExportFilename,
  detectImageExtensionFromBytes,
  resolveImageExtension,
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
