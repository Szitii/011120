const FAILURE_WINDOW_MS = 15_000;
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

export async function fetchWithConnectionStatus(url: string, init: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    if (!init.signal?.aborted && error instanceof Error && error.name !== "AbortError") {
      const now = Date.now();
      if (lastFailureAt !== undefined && now - lastFailureAt <= FAILURE_WINDOW_MS) setConnectionIssue(true);
      lastFailureAt = now;
    }
    throw error;
  }

  // Any HTTP response confirms a working connection to the service.
  if (!init.signal?.aborted) {
    lastFailureAt = undefined;
    setConnectionIssue(false);
  }
  return response;
}
