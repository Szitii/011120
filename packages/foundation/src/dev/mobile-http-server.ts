import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type pg from "pg";
import {
  ApiAuthenticationError,
  type AuthenticatedOwnerSession,
  type EncounterCommandPort,
  type MvpHttpRequest,
  type OwnerSessionResolver,
} from "../http/types.ts";
import { MvpApiBoundary } from "../http/mvp-api.ts";
import { PostgresCommunityAdapter } from "../community/postgres.ts";
import {
  createPgPool,
  PostgresOwnerAdapter,
  type SqlExecutor,
} from "../persistence/postgres/index.ts";

const MAX_BODY_BYTES = 32_768;
const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_PORT = 8787;
const DEFAULT_DEV_TOKEN = "companion-social-stage1-owner";
const DEFAULT_OWNER_SUBJECT = "00000000-0000-0000-0000-0000000000a1";

class TransactionalOwnerExecutor implements SqlExecutor {
  readonly #pool: pg.Pool;
  readonly #subject: string;

  constructor(pool: pg.Pool, subject: string) {
    this.#pool = pool;
    this.#subject = subject;
  }

  async query<Row extends Record<string, unknown>>(
    text: string,
    values: readonly unknown[],
  ): Promise<{ readonly rows: Row[]; readonly rowCount: number | null }> {
    const client = await this.#pool.connect();
    try {
      await client.query("begin");
      await client.query("set local role authenticated");
      await client.query(
        "select set_config('request.jwt.claim.sub',$1,true)",
        [this.#subject],
      );
      const result = await client.query<Row>(text, [...values]);
      await client.query("commit");
      return { rows: result.rows, rowCount: result.rowCount };
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

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
    const executor = new TransactionalOwnerExecutor(input.pool, input.ownerSubject);
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

class ReadOnlyDevEncounterPort implements EncounterCommandPort {
  async run(): Promise<never> {
    throw new Error(
      "Encounter creation is intentionally disabled in the Stage 1 mobile dev HTTP host.",
    );
  }
}

const collectBody = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let bytes = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_BODY_BYTES) {
      throw new Error("REQUEST_TOO_LARGE");
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) return undefined;

  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.trim() === "") return undefined;

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error("INVALID_JSON");
  }
};

const headersFrom = (
  request: IncomingMessage,
): Readonly<Record<string, string | undefined>> => {
  const headers: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) headers[name] = value.join(", ");
    else headers[name] = value;
  }
  return headers;
};

const writeJson = (
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void => {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.setHeader("cache-control", "no-store");
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("access-control-allow-headers", "authorization, content-type, idempotency-key, if-match");
  response.setHeader("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  for (const [name, value] of Object.entries(headers)) {
    response.setHeader(name, value);
  }
  response.end(JSON.stringify(body));
};

const writeTransportProblem = (
  response: ServerResponse,
  status: number,
  code: string,
  title: string,
): void => {
  writeJson(response, status, {
    type: `urn:companion-social:problem:${code.toLowerCase().replaceAll("_", "-")}`,
    title,
    status,
    code,
    messageClass: "VALIDATION",
    retryHint: "DO_NOT_RETRY",
    traceId: "mobile-dev-transport",
  }, { "content-type": "application/problem+json" });
};

const toBoundaryRequest = async (
  request: IncomingMessage,
): Promise<MvpHttpRequest> => ({
  method: request.method ?? "GET",
  url: request.url ?? "/",
  headers: headersFrom(request),
  body: await collectBody(request),
});

export const createMobileDevHttpServer = (input: {
  readonly pool: pg.Pool;
  readonly bearerToken: string;
  readonly ownerSubject: string;
  readonly ownerId: string;
}) => {
  const api = new MvpApiBoundary({
    sessions: new DevOwnerSessionResolver(input),
    encounters: new ReadOnlyDevEncounterPort(),
  });

  return createServer(async (request, response) => {
    if (request.method === "OPTIONS") {
      response.statusCode = 204;
      response.setHeader("access-control-allow-origin", "*");
      response.setHeader("access-control-allow-headers", "authorization, content-type, idempotency-key, if-match");
      response.setHeader("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
      response.end();
      return;
    }

    if (request.url === "/healthz") {
      writeJson(response, 200, { ok: true, mode: "stage1-mobile-dev" });
      return;
    }

    try {
      const result = await api.handle(await toBoundaryRequest(request));
      writeJson(response, result.status, result.body, result.headers);
    } catch (error) {
      const code = error instanceof Error ? error.message : "TRANSPORT_ERROR";
      if (code === "REQUEST_TOO_LARGE") {
        writeTransportProblem(response, 413, code, "Request body is too large.");
        return;
      }
      if (code === "INVALID_JSON") {
        writeTransportProblem(response, 400, code, "Request body must contain valid JSON.");
        return;
      }
      writeJson(response, 500, {
        type: "urn:companion-social:problem:transport-error",
        title: "The development HTTP host could not complete the request.",
        status: 500,
        code: "TRANSPORT_ERROR",
        messageClass: "INTERNAL",
        retryHint: "RETRY_SAME_REQUEST",
        traceId: "mobile-dev-transport",
      }, { "content-type": "application/problem+json" });
    }
  });
};

const main = async (): Promise<void> => {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString || process.env.COMPANION_SOCIAL_DEV_DATABASE !== "1") {
    throw new Error(
      "Set DATABASE_URL and COMPANION_SOCIAL_DEV_DATABASE=1 before starting the Stage 1 mobile dev server.",
    );
  }

  const host = process.env.MOBILE_DEV_HOST ?? DEFAULT_HOST;
  const port = Number(process.env.MOBILE_DEV_PORT ?? DEFAULT_PORT);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("MOBILE_DEV_PORT must be a valid TCP port.");
  }

  const bearerToken = process.env.MOBILE_DEV_OWNER_TOKEN ?? DEFAULT_DEV_TOKEN;
  const ownerSubject = process.env.MOBILE_DEV_OWNER_SUBJECT ?? DEFAULT_OWNER_SUBJECT;
  const ownerId = process.env.MOBILE_DEV_OWNER_ID ?? "00000000-0000-0000-0000-0000000001a1";

  const pool = createPgPool(connectionString);
  const server = createMobileDevHttpServer({
    pool,
    bearerToken,
    ownerSubject,
    ownerId,
  });

  const shutdown = async (): Promise<void> => {
    server.close();
    await pool.end();
  };

  process.once("SIGINT", () => {
    void shutdown();
  });
  process.once("SIGTERM", () => {
    void shutdown();
  });

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
const isMain =
  argvPath !== undefined &&
  path.resolve(argvPath) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
