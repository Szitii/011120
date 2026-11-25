/**
 * The servers the platform runs on, as Fly's Machines API reports them. The console holds a
 * read-only Fly token (`fly tokens create readonly`): it can look, not start, stop or change.
 */

export interface Machine {
  app: string; id: string; name: string; state: string; region: string;
  cpus: number | null; memoryMb: number | null; image: string | null; updatedAt: string | null;
  /** The last time it stopped: when, the exit code, and whether it ran out of memory. */
  lastExit: { at: string; code: number | null; oom: boolean } | null;
}
export type Hosts = { ok: true; machines: Machine[] } | { ok: false; why: string };
export interface FlyAccess { readonly token: string; readonly apps: readonly string[]; readonly fetch?: typeof fetch }

type Raw = Record<string, unknown>;
const text = (v: unknown) => typeof v === "string" ? v : null;
const number = (v: unknown) => typeof v === "number" ? v : null;
const object = (v: unknown): Raw => v !== null && typeof v === "object" ? v as Raw : {};

function machine(app: string, raw: Raw): Machine {
  const guest = object(object(raw.config).guest);
  const exits = (Array.isArray(raw.events) ? raw.events : []).map(object).filter(e => e.type === "exit")
    .sort((a, b) => (number(b.timestamp) ?? 0) - (number(a.timestamp) ?? 0));
  const exit = exits[0], event = object(object(exit?.request).exit_event);
  return {
    app, id: text(raw.id) ?? "?", name: text(raw.name) ?? "", state: text(raw.state) ?? "unknown", region: text(raw.region) ?? "",
    cpus: number(guest.cpus), memoryMb: number(guest.memory_mb), image: text(object(raw.image_ref).tag), updatedAt: text(raw.updated_at),
    lastExit: exit === undefined ? null : { at: new Date(number(exit.timestamp) ?? 0).toISOString(), code: number(event.exit_code), oom: event.oom_killed === true },
  };
}

/** Every machine of the listed apps; on any failure, why (shown on the page instead). */
export async function hosts(access: FlyAccess | null): Promise<Hosts> {
  if (access === null) return { ok: false, why: "后台还没有 Fly 只读令牌(FLY_READ_TOKEN),看不到主机状态。" };
  const get = access.fetch ?? fetch;
  try {
    const lists = await Promise.all(access.apps.map(async app => {
      const response = await get(`https://api.machines.dev/v1/apps/${encodeURIComponent(app)}/machines`,
        { headers: { Authorization: `Bearer ${access.token}` }, signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error(`Fly 回答 ${response.status}(应用 ${app})`);
      const body = await response.json() as unknown;
      return (Array.isArray(body) ? body : []).map(m => machine(app, object(m)));
    }));
    return { ok: true, machines: lists.flat() };
  } catch (error) {
    return { ok: false, why: `读不到 Fly 的主机状态:${error instanceof Error ? error.message : String(error)}` };
  }
}
