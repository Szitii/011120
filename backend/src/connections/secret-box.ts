/**
 * Seals an Owner's API key or agent token before it is stored, so the database, its backups and
 * operators only ever see ciphertext. AES-256-GCM with the server's key (CONNECTION_SECRET_KEY,
 * 32 random bytes in base64, e.g. `openssl rand -base64 32`, kept in the host's secrets).
 *
 * Each secret is bound to its Companion (additional authenticated data), so a sealed value copied
 * to another Companion's row does not open. Format: v1.<iv>.<tag>.<ciphertext>, base64url.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export class SecretBox {
  readonly #key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== 32) throw new Error("CONNECTION_SECRET_KEY must be 32 bytes in base64.");
    this.#key = key;
  }

  /** The box from CONNECTION_SECRET_KEY; undefined when it is not set (connections are then off). */
  static fromEnv(env: Readonly<Record<string, string | undefined>> = process.env): SecretBox | undefined {
    const value = env.CONNECTION_SECRET_KEY?.trim();
    return value ? new SecretBox(Buffer.from(value, "base64")) : undefined;
  }

  seal(plain: string, companionId: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    cipher.setAAD(Buffer.from(companionId));
    const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return ["v1", iv, cipher.getAuthTag(), data].map(part => (typeof part === "string" ? part : part.toString("base64url"))).join(".");
  }

  /** Throws when the value was not sealed by this key for this Companion. */
  open(sealed: string, companionId: string): string {
    const [version, iv, tag, data, ...rest] = sealed.split(".");
    if (version !== "v1" || iv === undefined || tag === undefined || data === undefined || rest.length > 0) {
      throw new Error("Unknown sealed secret.");
    }
    const decipher = createDecipheriv("aes-256-gcm", this.#key, Buffer.from(iv, "base64url"));
    decipher.setAAD(Buffer.from(companionId));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
  }
}
