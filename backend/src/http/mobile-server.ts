import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { MAX_IMPORT_BYTES } from "../companion-import/policy.ts";
import type { ChatCatalog } from "../chat/models.ts";
import { ChatReplies, devChatModel } from "../chat/replies.ts";
import { MvpApiBoundary } from "./mvp-api.ts";
import type { MvpHttpRequest, OwnerSessionResolver } from "./types.ts";

// The largest body any route takes is a Companion import; every other route caps its own fields.
const MAX_BODY_BYTES = MAX_IMPORT_BYTES;
const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type, idempotency-key, if-match, x-trace-id",
  "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
};
// status and title per transport failure; anything else is a 500 TRANSPORT_ERROR.
const TRANSPORT_PROBLEMS: Readonly<Record<string, readonly [number, string]>> = {
  REQUEST_TOO_LARGE: [413, "Request body is too large."],
  INVALID_JSON: [400, "Request body must contain valid JSON."],
  TRANSPORT_ERROR: [500, "The mobile HTTP host could not complete the request."],
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
    traceId: "mobile-transport",
  }, { "content-type": "application/problem+json" });
};

/**
 * One HTTP host for both the dev token resolver and the Supabase resolver. Chat replies: the dev
 * host answers with a fixed fake reply; the Supabase host has no model yet, so replies end as
 * UNAVAILABLE ("coming soon") until a model is connected.
 */
export const createMobileHttpServer = (
  sessions: OwnerSessionResolver,
  mode: "stage1-mobile-dev" | "supabase-auth",
  chat: { readonly replies: ChatReplies; readonly catalog?: ChatCatalog } =
    { replies: new ChatReplies(mode === "stage1-mobile-dev" ? devChatModel : undefined) },
) => {
  const api = new MvpApiBoundary({
    sessions,
    encounters: {
      run: async () => {
        throw new Error("Encounter creation is unavailable on the mobile HTTP host.");
      },
    },
    replies: chat.replies,
    ...(chat.catalog === undefined ? {} : { catalog: chat.catalog }),
  });

  return createServer(async (request, response) => {
    if (request.method === "OPTIONS") {
      response.writeHead(204, CORS_HEADERS).end();
      return;
    }
    if (request.url === "/healthz") {
      writeJson(response, 200, { ok: true, mode });
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
