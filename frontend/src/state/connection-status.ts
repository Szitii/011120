import { withRequestDeadline } from "./request-deadline.ts";

const FAILURE_WINDOW_MS = 15_000;
const READ_TIMEOUT_MS = 20_000;
const listeners = new Set<() => void>();
let lastFailureAt: number | undefined;
let connectionIssue = false;

export function hasConnectionIssue() {
  return connectionIssue;
}

export function subscribeToConnectionStatus(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function setConnectionIssue(next: boolean) {
  if (next === connectionIssue) return;
  connectionIssue = next;
  for (const listener of listeners) listener();
}

export function fetchWithConnectionStatus(url: string, init: RequestInit): Promise<Response>;
export function fetchWithConnectionStatus<T>(url: string, init: RequestInit, consume: (response: Response) => Promise<T>): Promise<T>;
export async function fetchWithConnectionStatus<T>(
  url: string,
  init: RequestInit,
  consume?: (response: Response) => Promise<T>,
): Promise<Response | T> {
  const read = async (signal?: AbortSignal | null) => {
    const response = await fetch(url, { ...init, signal });
    return consume ? consume(response) : response;
  };
  let result: Response | T;
  try {
    result = init.method === "GET"
      ? await withRequestDeadline(read, READ_TIMEOUT_MS, init.signal ?? undefined)
      : await read(init.signal);
  } catch (error) {
    if (!init.signal?.aborted && error instanceof Error && error.name !== "AbortError") {
      const now = Date.now();
      if (lastFailureAt !== undefined && now - lastFailureAt <= FAILURE_WINDOW_MS) setConnectionIssue(true);
      lastFailureAt = now;
    }
    throw error;
  }

  if (!init.signal?.aborted) {
    lastFailureAt = undefined;
    setConnectionIssue(false);
  }
  return result;
}
