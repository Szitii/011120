export const STARTUP_TIMEOUT_MS = 15_000;

export class RequestTimeoutError extends Error {
  constructor() { super("Request timed out."); }
}

export async function withRequestDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs = STARTUP_TIMEOUT_MS,
  accountSignal?: AbortSignal,
): Promise<T> {
  if (accountSignal?.aborted) throw new Error("Account session changed.");
  const controller = new AbortController();
  let reject!: (reason: Error) => void;
  const interrupted = new Promise<never>((_, onReject) => { reject = onReject; });
  const cancel = () => {
    reject(new Error("Account session changed."));
    controller.abort();
  };
  const timer = setTimeout(() => {
    reject(new RequestTimeoutError());
    controller.abort();
  }, timeoutMs);
  accountSignal?.addEventListener("abort", cancel, { once: true });

  try {
    return await Promise.race([interrupted, Promise.resolve().then(() => operation(controller.signal))]);
  } finally {
    clearTimeout(timer);
    accountSignal?.removeEventListener("abort", cancel);
  }
}
