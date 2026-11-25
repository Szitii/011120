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
export interface Volume { app: string; id: string; name: string; region: string; sizeGb: number }
export type Hosts = { ok: true; machines: Machine[]; volumes: Volume[] } | { ok: false; why: string };
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

function volume(app: string, raw: Raw): Volume {
  return { app, id: text(raw.id) ?? "?", name: text(raw.name) ?? "", region: text(raw.region) ?? "", sizeGb: number(raw.size_gb) ?? 0 };
}

// Fly's list prices (docs.fly.io/about/pricing, read 2026-11-25), in US cents a month. Ashburn is the base;
// other regions multiply CPU and RAM (not volumes). A shared CPU works out to $0.69 and RAM to $6 a GB:
// shared-cpu-1x with 256 MB is $2.19 in Ashburn, $2.87 in Tokyo. Shared CPUs only: the platform runs no others.
const SHARED_CPU_CENTS = 69, RAM_CENTS_PER_GB = 600, VOLUME_CENTS_PER_GB = 15;
const REGION_FACTOR: Readonly<Record<string, number>> = { iad: 1, ewr: 1, nrt: 1.308 };
/** Regions not in the table are priced like Tokyo, among the dearer ones, so the guess errs high. */
const factor = (region: string) => REGION_FACTOR[region] ?? 1.308;

/** What one machine costs for a whole month of running, by its size; null when stopped (it then pays only for its disk). */
export function machineCents(m: Machine): number | null {
  if (m.state !== "started" || m.cpus === null || m.memoryMb === null) return null;
  return Math.round((m.cpus * SHARED_CPU_CENTS + (m.memoryMb / 1024) * RAM_CENTS_PER_GB) * factor(m.region));
}
export const volumeCents = (v: Volume) => v.sizeGb * VOLUME_CENTS_PER_GB;
/** A month of everything as it is now: running machines and disks. Not traffic, IPs or anything else. */
export const flyMonthCents = (h: Hosts & { ok: true }) =>
  h.machines.reduce((n, m) => n + (machineCents(m) ?? 0), 0) + h.volumes.reduce((n, v) => n + volumeCents(v), 0);

/** Every machine and volume of the listed apps; on any failure, why (shown on the page instead). */
export async function hosts(access: FlyAccess | null): Promise<Hosts> {
  if (access === null) return { ok: false, why: "后台还没有 Fly 只读令牌(FLY_READ_TOKEN),看不到主机状态。" };
  const get = access.fetch ?? fetch;
  try {
    const list = async (app: string, what: "machines" | "volumes"): Promise<Raw[]> => {
      const response = await get(`https://api.machines.dev/v1/apps/${encodeURIComponent(app)}/${what}`,
        { headers: { Authorization: `Bearer ${access.token}` }, signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error(`Fly 回答 ${response.status}(应用 ${app})`);
      const body = await response.json() as unknown;
      return (Array.isArray(body) ? body : []).map(object);
    };
    const apps = await Promise.all(access.apps.map(async app => {
      const [machines, volumes] = await Promise.all([list(app, "machines"), list(app, "volumes")]);
      return { machines: machines.map(m => machine(app, m)), volumes: volumes.map(v => volume(app, v)) };
    }));
    return { ok: true, machines: apps.flatMap(a => a.machines), volumes: apps.flatMap(a => a.volumes) };
  } catch (error) {
    return { ok: false, why: `读不到 Fly 的主机状态:${error instanceof Error ? error.message : String(error)}` };
  }
}
