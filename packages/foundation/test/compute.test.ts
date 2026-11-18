import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConflictError } from "../src/companion-import/index.ts";
import {
  ComputePolicyError,
  ComputeReceiptService,
  ComputeService,
  InMemoryComputeLedgerRepository,
  type ReserveComputeCommand,
} from "../src/compute/index.ts";

function harness(overrides: { maxCalls?: number; maxCost?: number; maxPublications?: number } = {}) {
  let sequence = 0;
  const ledger = new InMemoryComputeLedgerRepository();
  const service = new ComputeService({
    ledger,
    id: () => `compute-id-${++sequence}`,
    now: () => "2026-09-13T04:00:00.000Z",
  });
  service.registerComputeBudget({
    id: "budget-a",
    ownerId: "owner-a",
    companionId: "companion-a",
    periodStart: "2026-09-13T00:00:00.000Z",
    periodEnd: "2026-09-14T00:00:00.000Z",
    maxModelCalls: overrides.maxCalls ?? 3,
    maxInputTokens: 10_000,
    maxOutputTokens: 3_000,
    maxCostMinor: overrides.maxCost ?? 300,
    currency: "USD",
  });
  service.registerPublicationBudget({
    id: "publication-a",
    ownerId: "owner-a",
    companionId: "companion-a",
    periodStart: "2026-09-13T00:00:00.000Z",
    periodEnd: "2026-09-14T00:00:00.000Z",
    maxPublications: overrides.maxPublications ?? 1,
  });
  return { ledger, service };
}

function command(overrides: Partial<ReserveComputeCommand> = {}): ReserveComputeCommand {
  return {
    ownerId: "owner-a",
    companionId: "companion-a",
    socialTwinId: "twin-a",
    reasonCode: "SOCIAL_ENCOUNTER_RESPONSE",
    triggerEventType: "ENCOUNTER",
    triggerEventId: "encounter-a",
    providerId: "provider-a",
    credentialId: "credential-a",
    canonicalModel: "small-text",
    providerModel: "provider-small-v1",
    billingParty: "OWNER",
    currency: "USD",
    pricingVersion: "price/1",
    estimatedInputTokens: 400,
    maxOutputTokens: 200,
    reservedCostMinor: 30,
    promptTemplateVersion: "encounter/1",
    identityVersion: 1,
    socialPersonaVersion: 1,
    memoryPolicyVersion: "memory/1",
    safetyPolicyVersion: "safety/1",
    routerVersion: "router/1",
    idempotencyKey: "encounter-a-attempt-1",
    traceId: "trace-a",
    ...overrides,
  };
}

describe("ComputeTransaction append-only ledger", () => {
  it("records complete attribution before and after provider I/O", () => {
    const { ledger, service } = harness();
    const reservation = service.reserve(command());
    const started = service.start(reservation.transactionId);
    const settled = service.settle(reservation.transactionId, {
      inputTokens: 350,
      outputTokens: 120,
      actualCostMinor: 21,
      status: "SUCCEEDED",
      providerRequestIdHash: "provider-request-hash",
    });
    const entries = ledger.listByTransaction(reservation.transactionId);

    assert.deepEqual(entries.map((entry) => entry.entryType), ["RESERVATION", "START", "SETTLEMENT"]);
    assert.equal(started.status, "STARTED");
    assert.equal(settled.actualCostMinor, 21);
    assert.equal(settled.ownerId, "owner-a");
    assert.equal(settled.companionId, "companion-a");
    assert.equal(settled.reasonCode, "SOCIAL_ENCOUNTER_RESPONSE");
    assert.equal(settled.providerModel, "provider-small-v1");
    assert.equal(Object.isFrozen(settled), true);
    const budget = service.computeBudget("owner-a", "companion-a");
    assert.equal(budget.reservedCalls, 0);
    assert.equal(budget.settledCalls, 1);
    assert.equal(budget.settledCostMinor, 21);
  });

  it("atomically refuses reservations beyond the hard cap and records rejection", () => {
    const { ledger, service } = harness({ maxCalls: 1 });
    service.reserve(command());
    assert.throws(
      () => service.reserve(command({ idempotencyKey: "attempt-2", triggerEventId: "encounter-b" })),
      (error: unknown) => error instanceof ComputePolicyError && error.code === "COMPUTE_BUDGET_EXHAUSTED",
    );
    assert.ok(ledger.listByOwner("owner-a").some((entry) => entry.entryType === "REJECTION" && entry.outcomeCode === "BUDGET_EXHAUSTED"));
    assert.equal(service.computeBudget("owner-a", "companion-a").reservedCalls, 1);
  });

  it("makes reservation idempotency stable and rejects request substitution", () => {
    const { service } = harness();
    const first = service.reserve(command());
    assert.equal(service.reserve(command()).transactionId, first.transactionId);
    assert.throws(
      () => service.reserve(command({ reservedCostMinor: 29 })),
      ConflictError,
    );
  });

  it("releases unused reservations without charging settled usage", () => {
    const { service } = harness();
    const reservation = service.reserve(command());
    const release = service.release(reservation.transactionId);
    const budget = service.computeBudget("owner-a", "companion-a");

    assert.equal(release.status, "CANCELLED");
    assert.equal(budget.reservedCalls, 0);
    assert.equal(budget.settledCalls, 0);
    assert.throws(() => service.start(reservation.transactionId), ConflictError);
  });

  it("accounts for failed or blocked provider work while leaving publication independent", () => {
    const { service } = harness();
    const reservation = service.reserve(command());
    service.start(reservation.transactionId);
    service.settle(reservation.transactionId, {
      inputTokens: 390,
      outputTokens: 50,
      actualCostMinor: 18,
      status: "BLOCKED",
      outcomeCode: "OUTPUT_DLP_BLOCK",
    });

    assert.equal(service.computeBudget("owner-a", "companion-a").settledCostMinor, 18);
    assert.equal(service.publicationBudget("owner-a", "companion-a").consumedPublications, 0);
  });

  it("uses compensating reconciliation entries instead of editing history", () => {
    const { ledger, service } = harness();
    const reservation = service.reserve(command());
    service.start(reservation.transactionId);
    service.settle(reservation.transactionId, { inputTokens: 350, outputTokens: 100, actualCostMinor: 20, status: "SUCCEEDED" });
    const before = ledger.listByTransaction(reservation.transactionId)[2];
    const reconciliation = service.reconcile(reservation.transactionId, 3);

    assert.equal(before?.actualCostMinor, 20);
    assert.equal(reconciliation.entryType, "RECONCILIATION");
    assert.equal(reconciliation.costDeltaMinor, 3);
    assert.equal(service.computeBudget("owner-a", "companion-a").settledCostMinor, 23);
    assert.equal(ledger.listByTransaction(reservation.transactionId).length, 4);
  });

  it("reserves and consumes publication separately, and releases blocked output holds", () => {
    const { service } = harness({ maxPublications: 1 });
    const first = service.reservePublication("owner-a", "companion-a", "event-a");
    assert.equal(service.publicationBudget("owner-a", "companion-a").reservedPublications, 1);
    service.releasePublication(first.id);
    assert.equal(service.publicationBudget("owner-a", "companion-a").reservedPublications, 0);

    const second = service.reservePublication("owner-a", "companion-a", "event-b");
    service.consumePublication(second.id);
    assert.equal(service.publicationBudget("owner-a", "companion-a").consumedPublications, 1);
    assert.throws(() => service.reservePublication("owner-a", "companion-a", "event-c"), ComputePolicyError);
  });

  it("rejects reason, billing, ceiling, currency, and lifecycle violations before provider work", () => {
    const { service } = harness();
    assert.throws(
      () => service.reserve(command({ billingParty: "PLATFORM" })),
      (error: unknown) => error instanceof ComputePolicyError && error.code === "COMPUTE_REASON_POLICY_MISMATCH",
    );
    assert.throws(
      () => service.reserve(command({ maxOutputTokens: 801 })),
      (error: unknown) => error instanceof ComputePolicyError && error.code === "COMPUTE_REASON_CEILING_EXCEEDED",
    );
    assert.throws(
      () => service.reserve(command({ currency: "CNY" })),
      (error: unknown) => error instanceof ComputePolicyError && error.code === "COMPUTE_CURRENCY_MISMATCH",
    );
    assert.throws(() => service.start("missing"), ConflictError);
  });

  it("creates an Owner-scoped receipt from immutable ledger entries without exposing credentials", () => {
    const { service } = harness();
    const reservation = service.reserve(command());
    service.start(reservation.transactionId);
    service.settle(reservation.transactionId, {
      inputTokens: 350,
      outputTokens: 100,
      actualCostMinor: 20,
      status: "SUCCEEDED",
    });
    const receipts = new ComputeReceiptService(service);
    const receipt = receipts.create("owner-a", reservation.transactionId);

    assert.equal(receipt.actualCostMinor, 20);
    assert.equal(receipt.outcome, "SUCCEEDED");
    assert.equal(receipt.socialPersonaVersion, 1);
    assert.ok(!Object.hasOwn(receipt, "credentialId"));
    assert.throws(() => receipts.create("owner-b", reservation.transactionId));
    assert.throws(() => receipts.create("owner-a", "missing"), ConflictError);
  });
});
