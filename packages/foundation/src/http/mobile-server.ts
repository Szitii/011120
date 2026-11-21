import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { MvpApiBoundary } from "./mvp-api.ts";
import type { EncounterCommandPort, MvpHttpRequest, OwnerSessionResolver } from "./types.ts";

const MAX_BODY_BYTES = 32_768;

class UnavailableEncounterPort implements EncounterCommandPort {
  async run(): Promise<never> {
    throw new Error(
      "Encounter creation is unavailable on the mobile HTTP host.",
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
    traceId: "mobile-transport",
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

export const createMobileHttpServer = (sessions: OwnerSessionResolver, mode: "stage1-mobile-dev" | "supabase-auth") => {
  const api = new MvpApiBoundary({
    sessions,
    encounters: new UnavailableEncounterPort(),
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
      writeJson(response, 200, { ok: true, mode });
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
        title: "The mobile HTTP host could not complete the request.",
        status: 500,
        code: "TRANSPORT_ERROR",
        messageClass: "INTERNAL",
        retryHint: "RETRY_SAME_REQUEST",
        traceId: "mobile-transport",
      }, { "content-type": "application/problem+json" });
    }
  });
};
