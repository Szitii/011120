import { createHash } from "node:crypto";

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeValue);
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalizeValue(nested)]),
    );
  }

  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalizeValue(value));
}

export function contentHash(value: unknown): string {
  return sha256(canonicalJson(value));
}
