/**
 * The only way the server calls an address an Owner typed in (their provider's API base or their
 * own agent). It must not become a way into our own network (SSRF):
 *   - https only, port 443, no user:password, query or fragment in the URL;
 *   - every address the name resolves to must be public, checked when the connection is made
 *     (so a name that resolves to a private address later, DNS rebinding, is still refused);
 *     an IP written directly in the URL is checked the same way;
 *   - no redirects are followed, the answer is capped in size and the call in time.
 */
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request } from "node:https";
import { BlockList, isIP } from "node:net";

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
  // IPv4-mapped addresses (::ffff:a.b.c.d) are checked against the IPv4 rules above by BlockList itself.
  ["::", 128], ["::1", 128], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64], ["2001::", 23],
  ["2001:db8::", 32], ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
] as const) blocked.addSubnet(net, prefix, "ipv6");

/** A public unicast address: not private, loopback, link-local (cloud metadata), shared, reserved or multicast. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  return !blocked.check(address, family === 4 ? "ipv4" : "ipv6");
}

/** The URL if the server may call it, else why not. */
export function checkUrl(raw: string): URL | "INVALID_URL" | "BLOCKED_ADDRESS" {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return "INVALID_URL";
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || /\s/.test(raw.trim())
    || (url.port !== "" && url.port !== "443") || raw.length > 500) return "INVALID_URL";
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) !== 0 && !isPublicAddress(host)) return "BLOCKED_ADDRESS";
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) return "BLOCKED_ADDRESS";
  return url;
}

export class BlockedAddressError extends Error {
  constructor() { super("The address is not public."); this.name = "BlockedAddressError"; }
}

type Lookup = typeof dnsLookup;

/** A dns.lookup that fails unless every address is public; answers in whichever form the caller asked for. */
export function publicLookup(resolve: Lookup = dnsLookup): Lookup {
  return ((hostname: string, options: unknown, callback: unknown) => {
    const done = (typeof options === "function" ? options : callback) as (error: Error | null, address?: unknown, family?: number) => void;
    const wanted = (typeof options === "object" && options !== null ? options : {}) as { all?: boolean };
    resolve(hostname, { ...(wanted as object), all: true }, (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => {
      if (error) return done(error);
      if (addresses.length === 0 || addresses.some(entry => !isPublicAddress(entry.address))) return done(new BlockedAddressError());
      if (wanted.all) return done(null, addresses);
      return done(null, addresses[0]!.address, addresses[0]!.family);
    });
  }) as Lookup;
}

export interface PostResult {
  readonly status: number;
  /** The parsed JSON answer, or undefined when it was not JSON. */
  readonly body: unknown;
}

export type PostJson = (url: URL, headers: Record<string, string>, body: unknown, options: { signal: AbortSignal; timeoutMs: number }) => Promise<PostResult>;

const MAX_ANSWER_BYTES = 512 * 1024;

/** POSTs JSON to a checked URL through publicLookup. Rejects on a blocked address, timeout, abort or oversized answer. */
export function createPostJson(resolve: Lookup = dnsLookup): PostJson {
  const lookup = publicLookup(resolve);
  return (url, headers, body, { signal, timeoutMs }) => new Promise<PostResult>((resolvePost, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const call = request({
      protocol: "https:", hostname: url.hostname.replace(/^\[|\]$/g, ""), port: 443, path: `${url.pathname}`, method: "POST",
      headers: { ...headers, "content-type": "application/json", "content-length": String(payload.length), accept: "application/json" },
      lookup, signal, timeout: timeoutMs, agent: false,
    }, response => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_ANSWER_BYTES) { call.destroy(new Error("The answer is too large.")); return; }
        chunks.push(chunk);
      });
      response.on("end", () => {
        let parsed: unknown;
        try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { parsed = undefined; }
        resolvePost({ status: response.statusCode ?? 0, body: parsed });
      });
      response.on("error", reject);
    });
    call.on("timeout", () => call.destroy(new Error("The call timed out.")));
    call.on("error", reject);
    call.end(payload);
  });
}
