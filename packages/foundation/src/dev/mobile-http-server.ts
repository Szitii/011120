import { fileURLToPath } from "node:url";
import path from "node:path";
import type pg from "pg";
import {
  ApiAuthenticationError,
  type AuthenticatedOwnerSession,
  type OwnerSessionResolver,
} from "../http/types.ts";
import { createMobileHttpServer } from "../http/mobile-server.ts";
import { PostgresCommunityAdapter } from "../community/postgres.ts";
import {
  createPgPool,
  PgOwnerExecutor,
  PostgresOwnerAdapter,
} from "../persistence/postgres/index.ts";

class DevOwnerSessionResolver implements OwnerSessionResolver {
  readonly #token: string;
  readonly #ownerId: string;
  readonly #owner: PostgresOwnerAdapter;
  readonly #community: PostgresCommunityAdapter;

  constructor(input: {
    readonly pool: pg.Pool;
    readonly bearerToken: string;
    readonly ownerSubject: string;
    readonly ownerId: string;
  }) {
    this.#token = input.bearerToken;
    this.#ownerId = input.ownerId;
    const executor = new PgOwnerExecutor(input.pool, input.ownerSubject);
    this.#owner = new PostgresOwnerAdapter(executor);
    this.#community = new PostgresCommunityAdapter(executor);
  }

  async resolve(bearerToken: string): Promise<AuthenticatedOwnerSession> {
    if (bearerToken !== this.#token) {
      throw new ApiAuthenticationError("INVALID_TOKEN");
    }
    return { ownerId: this.#ownerId, owner: this.#owner, community: this.#community };
  }
}

export const createMobileDevHttpServer = (input: {
  readonly pool: pg.Pool;
  readonly bearerToken: string;
  readonly ownerSubject: string;
  readonly ownerId: string;
}) => createMobileHttpServer(new DevOwnerSessionResolver(input), "stage1-mobile-dev");

const main = async (): Promise<void> => {
  if (process.env.NODE_ENV === "production" || process.env.SUPABASE_URL || process.env.SUPABASE_PUBLISHABLE_KEY) {
    throw new Error("Use the Supabase-authenticated mobile API in this environment.");
  }
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString || process.env.COMPANION_SOCIAL_DEV_DATABASE !== "1") {
    throw new Error(
      "Set DATABASE_URL and COMPANION_SOCIAL_DEV_DATABASE=1 before starting the Stage 1 mobile dev server.",
    );
  }

  const host = process.env.MOBILE_DEV_HOST ?? "0.0.0.0";
  const port = Number(process.env.MOBILE_DEV_PORT ?? 8787);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("MOBILE_DEV_PORT must be a valid TCP port.");
  }
  const bearerToken = process.env.MOBILE_DEV_OWNER_TOKEN ?? "companion-social-stage1-owner";

  const pool = createPgPool(connectionString);
  const server = createMobileDevHttpServer({
    pool,
    bearerToken,
    ownerSubject: process.env.MOBILE_DEV_OWNER_SUBJECT ?? "00000000-0000-0000-0000-0000000000a1",
    ownerId: process.env.MOBILE_DEV_OWNER_ID ?? "00000000-0000-0000-0000-0000000001a1",
  });

  const shutdown = (): void => {
    server.close();
    void pool.end();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });

  process.stdout.write(
    [
      `Stage 1 mobile dev API listening on http://${host}:${port}`,
      `Bearer token: ${bearerToken}`,
      "SampleCompanion Companion: 00000000-0000-0000-0000-0000000002a1",
      "This host is development-only and Encounter creation is intentionally disabled.",
      "",
    ].join("\n"),
  );
};

const argvPath = process.argv[1];
if (argvPath !== undefined && path.resolve(argvPath) === path.resolve(fileURLToPath(import.meta.url))) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
