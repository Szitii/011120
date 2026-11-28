/**
 * A small MCP client: enough to ask a tool server which tools it has and to call one.
 *
 * MCP (Model Context Protocol) over "Streamable HTTP": every request is one JSON-RPC message
 * POSTed to the server's address, and the answer comes back as JSON or as a short event stream
 * that carries the same JSON. A conversation starts with `initialize`; the server may hand out a
 * session id to send along from then on. Nothing else of the protocol is used here: no resources,
 * no prompts, no messages from the server.
 *
 * Every call goes through the guard (connections/guard.ts): https, public addresses only, no
 * redirects, the answer capped in size and time.
 */
import { checkUrl, type PostRaw } from "../connections/guard.ts";

export interface McpTool { name: string; description: string; inputSchema: unknown }

/**
 * Why a tool server gave no usable answer. AUTH, RATE_LIMITED and NOT_FOUND are refusals: nothing
 * was done. UNREACHABLE (no answer in time, or the server failed) and BAD_ANSWER leave it open
 * whether a call that was sent was carried out: see `uncertain`.
 */
export type McpFailure = "AUTH" | "RATE_LIMITED" | "NOT_FOUND" | "UNREACHABLE" | "BAD_ANSWER";

/** After this failure nobody knows whether the call was carried out. */
export const uncertain = (reason: McpFailure): boolean => reason === "UNREACHABLE" || reason === "BAD_ANSWER";

export class McpError extends Error {
  readonly reason: McpFailure;
  constructor(reason: McpFailure) {
    super(`The tool server failed: ${reason}.`);
    this.name = "McpError";
    this.reason = reason;
  }
}

/** One conversation with a tool server, started on first use. */
export interface McpSession {
  /** The tools the server has, 200 at most. */
  tools(signal: AbortSignal): Promise<McpTool[]>;
  /** Calls one. `ok` false: the tool itself says it failed (the text says why). */
  call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<{ ok: boolean; text: string }>;
}

/** The newest protocol version this client speaks; the server answers with the one it wants. */
const PROTOCOL = "2025-06-18";
const TIMEOUT_MS = 15_000;
const MAX_TOOLS = 200;
const NAME = /^[A-Za-z0-9_.-]{1,64}$/;

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** The JSON-RPC answer to request `id` in a body that is JSON or an event stream; undefined when there is none. */
export function rpcAnswer(text: string, contentType: string, id: number): Record<string, unknown> | undefined {
  const documents = !contentType.includes("text/event-stream") ? [text]
    // One event per blank-line-separated block; its data lines, joined, are one JSON message.
    : text.split(/\r?\n\r?\n/).map(event => event.split(/\r?\n/).flatMap(line => (line.startsWith("data:") ? [line.slice(5).trimStart()] : [])).join("\n"));
  for (const document of documents) {
    let parsed: unknown;
    try { parsed = JSON.parse(document); } catch { continue; }
    const found = (Array.isArray(parsed) ? parsed : [parsed]).map(object).find(message => message?.id === id && ("result" in message || "error" in message));
    if (found !== undefined) return found;
  }
  return undefined;
}

export function mcpSession(post: PostRaw, url: URL, token: string): McpSession {
  let started: Promise<Record<string, string>> | undefined;
  let nextId = 1;
  const base = { authorization: `Bearer ${token}`, accept: "application/json, text/event-stream" };

  /** One request and its result; a notification (no `method` answer expected) returns undefined. */
  async function send(method: string, params: unknown, headers: Record<string, string>, signal: AbortSignal, notify = false):
    Promise<{ result: Record<string, unknown> | undefined; headers: Readonly<Record<string, string>> }> {
    const id = notify ? undefined : nextId++;
    // Only an address the server may call at all (https, port 443, not a private address written out).
    if (typeof checkUrl(url.href) === "string") throw new McpError("NOT_FOUND");
    let answer;
    try {
      answer = await post(url, { ...base, ...headers }, { jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method, ...(params === undefined ? {} : { params }) },
        { signal, timeoutMs: TIMEOUT_MS, ...(id === undefined ? {} : { enough: (text: string) => rpcAnswer(text, "text/event-stream", id) !== undefined }) });
    } catch {
      throw new McpError("UNREACHABLE");
    }
    if (answer.status === 401 || answer.status === 403) throw new McpError("AUTH");
    if (answer.status === 429) throw new McpError("RATE_LIMITED");
    if (answer.status === 404 || answer.status === 405) throw new McpError("NOT_FOUND");
    if (answer.status >= 500) throw new McpError("UNREACHABLE");
    if (answer.status < 200 || answer.status > 299) throw new McpError("BAD_ANSWER");
    if (id === undefined) return { result: undefined, headers: answer.headers };
    const message = rpcAnswer(answer.text, answer.headers["content-type"] ?? "", id);
    const result = object(message?.result);
    // A JSON-RPC error (unknown method, bad parameters) or no answer to this request at all.
    if (result === undefined) throw new McpError("BAD_ANSWER");
    return { result, headers: answer.headers };
  }

  /** The headers every request after the handshake carries: the session, if the server opened one, and the version agreed on. */
  const handshake = (signal: AbortSignal): Promise<Record<string, string>> => started ??= (async () => {
    const hello = await send("initialize", { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "011120", version: "1" } }, {}, signal);
    const version = typeof hello.result?.protocolVersion === "string" ? hello.result.protocolVersion : PROTOCOL;
    const session = hello.headers["mcp-session-id"];
    const headers = { "mcp-protocol-version": version, ...(session ? { "mcp-session-id": session } : {}) };
    await send("notifications/initialized", undefined, headers, signal, true);
    return headers;
  })().catch((error: unknown) => { started = undefined; throw error; });

  return {
    async tools(signal) {
      const headers = await handshake(signal);
      const listed: McpTool[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 10 && listed.length < MAX_TOOLS; page += 1) {
        const { result } = await send("tools/list", cursor === undefined ? {} : { cursor }, headers, signal);
        for (const item of Array.isArray(result?.tools) ? result.tools : []) {
          const tool = object(item);
          if (tool !== undefined && typeof tool.name === "string" && NAME.test(tool.name) && listed.length < MAX_TOOLS) {
            listed.push({ name: tool.name, description: typeof tool.description === "string" ? tool.description.slice(0, 2000) : "",
              inputSchema: object(tool.inputSchema) ?? { type: "object" } });
          }
        }
        cursor = typeof result?.nextCursor === "string" && result.nextCursor !== "" ? result.nextCursor : undefined;
        if (cursor === undefined) break;
      }
      return listed;
    },
    async call(name, args, signal) {
      const headers = await handshake(signal);
      const { result } = await send("tools/call", { name, arguments: args }, headers, signal);
      // Text is what a model reads; pictures and files in a result are left out.
      const text = (Array.isArray(result?.content) ? result.content : []).flatMap(part => {
        const piece = object(part);
        return piece?.type === "text" && typeof piece.text === "string" ? [piece.text] : [];
      }).join("\n").trim();
      const structured = text.length === 0 && result?.structuredContent !== undefined ? JSON.stringify(result.structuredContent) : text;
      return { ok: result?.isError !== true, text: structured };
    },
  };
}
