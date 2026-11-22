import type {
  PostgresPersistenceError,
  ReconcileStartedInput,
  ReconcileStartedResult,
  StaleStartedCandidate,
  StaleStartedCursor,
} from "../persistence/postgres/types.ts";

export interface StartedReconciliationPort {
  listStaleStarted(cutoff: string, limit: number, after?: StaleStartedCursor): Promise<readonly StaleStartedCandidate[]>;
  reconcileStarted(input: ReconcileStartedInput): Promise<ReconcileStartedResult>;
}

export interface ReconciliationWorkerOptions {
  readonly cutoff: string;
  readonly batchSize: number;
  readonly maxItems: number;
  readonly reasonCode: string;
  readonly evidenceSource: ReconcileStartedInput["evidenceSource"];
  readonly providerRequestIdHash?: string;
}

export interface ReconciliationItemResult {
  readonly executionClaimId: string;
  readonly outcome: "reconciled" | "replayed" | "skipped" | "failed";
  readonly errorCode?: string;
}

export interface ReconciliationRunSummary {
  readonly cutoff: string;
  readonly scanned: number;
  readonly reconciled: number;
  readonly replayed: number;
  readonly skipped: number;
  readonly failed: number;
  readonly items: readonly ReconciliationItemResult[];
}

// A concurrent settlement or reconciliation already decided these claims: skipped, not failed.
const SKIPPED_CODES = ["INVALID_STATE", "NOT_FOUND", "CONFLICT"];

const validOptions = (options: ReconciliationWorkerOptions): boolean =>
  !Number.isNaN(Date.parse(options.cutoff)) &&
  Number.isInteger(options.batchSize) && options.batchSize >= 1 && options.batchSize <= 100 &&
  Number.isInteger(options.maxItems) && options.maxItems >= 0 &&
  /^[A-Z][A-Z0-9_]{2,63}$/.test(options.reasonCode);

export async function runStaleStartedReconciliation(
  port: StartedReconciliationPort,
  options: ReconciliationWorkerOptions,
): Promise<ReconciliationRunSummary> {
  if (!validOptions(options)) throw new TypeError("Invalid reconciliation worker options.");
  const cutoff = new Date(options.cutoff).toISOString();
  const items: ReconciliationItemResult[] = [];
  let cursor: StaleStartedCursor | undefined;

  while (items.length < options.maxItems) {
    const requestedLimit = Math.min(options.batchSize, options.maxItems - items.length);
    const page = await port.listStaleStarted(cutoff, requestedLimit, cursor);
    if (page.length === 0) break;
    for (const candidate of page) {
      const { executionClaimId } = candidate;
      try {
        const result = await port.reconcileStarted({
          actorOwnerId: candidate.actorOwnerId,
          executionClaimId,
          reasonCode: options.reasonCode,
          evidenceSource: options.evidenceSource,
          ...(options.providerRequestIdHash === undefined
            ? {}
            : { providerRequestIdHash: options.providerRequestIdHash }),
        });
        items.push({ executionClaimId, outcome: result.replayed ? "replayed" : "reconciled" });
      } catch (error) {
        const code = (error as Partial<PostgresPersistenceError>).code;
        const errorCode = typeof code === "string" ? code : "UNEXPECTED";
        items.push({ executionClaimId, outcome: SKIPPED_CODES.includes(errorCode) ? "skipped" : "failed", errorCode });
      }
      cursor = { staleAt: candidate.staleAt, executionClaimId };
      if (items.length === options.maxItems) break;
    }
    if (page.length < requestedLimit) break;
  }

  const count = (outcome: ReconciliationItemResult["outcome"]): number =>
    items.filter((item) => item.outcome === outcome).length;
  return {
    cutoff,
    scanned: items.length,
    reconciled: count("reconciled"),
    replayed: count("replayed"),
    skipped: count("skipped"),
    failed: count("failed"),
    items,
  };
}
