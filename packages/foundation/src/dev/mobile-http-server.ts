import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type pg from "pg";
import { ApiAuthenticationError, type MvpHttpRequest } from "../http/types.ts";
import { MvpApiBoundary } from "../http/mvp-api.ts";
import { PostgresOwnerAdapter } from "../persistence/postgres/adapter.ts";
import { createPgPool, PgOwnerExecutor } from "../persistence/postgres/client.ts";

const MAX_BODY_BYTES = 32_768;
const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type, idempotency-key, if-match",
  "access-control-allow-methods": "GET, POST, PUT, PATCH, OPTIONS",
};
// status and title per transport failure; anything else is a 500 TRANSPORT_ERROR.
const TRANSPORT_PROBLEMS: Readonly<Record<string, readonly [number, string]>> = {
  REQUEST_TOO_LARGE: [413, "Request body is too large."],
  INVALID_JSON: [400, "Request body must contain valid JSON."],
  TRANSPORT_ERROR: [500, "The development HTTP host could not complete the request."],
};

const collectBody = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_BODY_BYTES) throw new Error("REQUEST_TOO_LARGE");
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.trim() === "") return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error("INVALID_JSON");
  }
};

const toBoundaryRequest = async (request: IncomingMessage): Promise<MvpHttpRequest> => ({
  method: request.method ?? "GET",
  url: request.url ?? "/",
  headers: Object.fromEntries(
    Object.entries(request.headers).map(([name, value]) => [name, Array.isArray(value) ? value.join(", ") : value]),
  ),
  body: await collectBody(request),
});

const writeJson = (
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void => {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...CORS_HEADERS, ...headers });
  response.end(JSON.stringify(body));
};

const writeTransportProblem = (response: ServerResponse, error: unknown): void => {
  const known = error instanceof Error && Object.hasOwn(TRANSPORT_PROBLEMS, error.message);
  const code = known ? (error as Error).message : "TRANSPORT_ERROR";
  const [status, title] = TRANSPORT_PROBLEMS[code]!;
  writeJson(response, status, {
    type: `urn:companion-social:problem:${code.toLowerCase().replaceAll("_", "-")}`,
    title,
    status,
    code,
    messageClass: status === 500 ? "INTERNAL" : "VALIDATION",
    retryHint: status === 500 ? "RETRY_SAME_REQUEST" : "DO_NOT_RETRY",
    traceId: "mobile-dev-transport",
  }, { "content-type": "application/problem+json" });
};

export const createMobileDevHttpServer = (input: {
  readonly pool: pg.Pool;
  readonly bearerToken: string;
  readonly ownerSubject: string;
  readonly ownerId: string;
}) => {
  const owner = new PostgresOwnerAdapter(new PgOwnerExecutor(input.pool, input.ownerSubject));
  const api = new MvpApiBoundary({
    sessions: {
      resolve: async (bearerToken) => {
        if (bearerToken !== input.bearerToken) throw new ApiAuthenticationError("INVALID_TOKEN");
        return { ownerId: input.ownerId, owner };
      },
    },
    encounters: {
      run: async () => {
        throw new Error("Encounter creation is intentionally disabled in the Stage 1 mobile dev HTTP host.");
      },
    },
  });

  return createServer(async (request, response) => {
    if (request.method === "OPTIONS") {
      response.writeHead(204, CORS_HEADERS).end();
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
      writeTransportProblem(response, error);
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
