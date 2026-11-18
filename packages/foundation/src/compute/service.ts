import { randomUUID } from "node:crypto";
import { contentHash, sha256 } from "../companion-import/canonical.ts";
import { ConflictError, ImportPolicyError } from "../companion-import/errors.ts";
import { REASON_POLICIES } from "./policy.ts";
import type { ComputeLedgerRepository } from "./repository.ts";
import type {
  ComputeBudgetDefinition,
  ComputeBudgetSnapshot,
  ComputeLedgerEntry,
  ComputeReservation,
  ComputeSettlement,
  PublicationBudgetDefinition,
  PublicationBudgetSnapshot,
  PublicationReservation,
  ReserveComputeCommand,
} from "./types.ts";

interface MutableComputeBudget extends ComputeBudgetDefinition {
  reservedCalls: number;
  settledCalls: number;
  reservedInputTokens: number;
  settledInputTokens: number;
  reservedOutputTokens: number;
  settledOutputTokens: number;
  reservedCostMinor: number;
  settledCostMinor: number;
}

interface MutablePublicationBudget extends PublicationBudgetDefinition {
  reservedPublications: number;
  consumedPublications: number;
}

interface TransactionState {
  readonly command: ReserveComputeCommand;
  readonly budgetId: string;
  readonly requestHash: string;
  status: "RESERVED" | "STARTED" | "TERMINAL";
  sequence: number;
}

interface ComputeDependencies {
  readonly ledger: ComputeLedgerRepository;
  readonly now?: () => string;
  readonly id?: () => string;
}

export class ComputePolicyError extends ImportPolicyError {
  override readonly name = "ComputePolicyError";
}

function assertNonNegativeInteger(value: number, code: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new ComputePolicyError(code, "Compute quantities must be non-negative safe integers.");
}

export class ComputeService {
  readonly #ledger: ComputeLedgerRepository;
  readonly #now: () => string;
  readonly #id: () => string;
  readonly #budgets = new Map<string, MutableComputeBudget>();
  readonly #budgetByScope = new Map<string, string>();
  readonly #transactions = new Map<string, TransactionState>();
  readonly #idempotency = new Map<string, string>();
  readonly #publicationBudgets = new Map<string, MutablePublicationBudget>();
  readonly #publicationBudgetByScope = new Map<string, string>();
  readonly #publicationReservations = new Map<string, PublicationReservation>();

  constructor(dependencies: ComputeDependencies) {
    this.#ledger = dependencies.ledger;
    this.#now = dependencies.now ?? (() => new Date().toISOString());
    this.#id = dependencies.id ?? randomUUID;
  }

  registerComputeBudget(definition: ComputeBudgetDefinition): void {
    for (const value of [definition.maxModelCalls, definition.maxInputTokens, definition.maxOutputTokens, definition.maxCostMinor]) {
      assertNonNegativeInteger(value, "COMPUTE_BUDGET_INVALID");
    }
    const scope = `${definition.ownerId}:${definition.companionId}`;
    if (this.#budgetByScope.has(scope)) throw new ConflictError("A compute budget already exists for this scope.");
    this.#budgets.set(definition.id, {
      ...definition,
      reservedCalls: 0,
      settledCalls: 0,
      reservedInputTokens: 0,
      settledInputTokens: 0,
      reservedOutputTokens: 0,
      settledOutputTokens: 0,
      reservedCostMinor: 0,
      settledCostMinor: 0,
    });
    this.#budgetByScope.set(scope, definition.id);
  }

  registerPublicationBudget(definition: PublicationBudgetDefinition): void {
    assertNonNegativeInteger(definition.maxPublications, "PUBLICATION_BUDGET_INVALID");
    const scope = `${definition.ownerId}:${definition.companionId}`;
    if (this.#publicationBudgetByScope.has(scope)) throw new ConflictError("A publication budget already exists for this scope.");
    this.#publicationBudgets.set(definition.id, { ...definition, reservedPublications: 0, consumedPublications: 0 });
    this.#publicationBudgetByScope.set(scope, definition.id);
  }

  reserve(command: ReserveComputeCommand): ComputeReservation {
    this.#validateCommand(command);
    const requestHash = contentHash({ ...command });
    const idempotencyScope = `${command.ownerId}:${command.idempotencyKey}`;
    const retryTransactionId = this.#idempotency.get(idempotencyScope);
    if (retryTransactionId !== undefined) {
      const retry = this.#transactions.get(retryTransactionId);
      if (retry === undefined || retry.requestHash !== requestHash) throw new ConflictError("Compute idempotency key was reused with a different request.");
      const entry = this.#ledger.listByTransaction(retryTransactionId)[0];
      if (entry === undefined || entry.entryType !== "RESERVATION") throw new ConflictError("Idempotent compute reservation is not available.");
      return Object.freeze({ transactionId: retryTransactionId, budgetId: retry.budgetId, reservedCostMinor: entry.reservedCostMinor, entry });
    }

    const budget = this.#activeBudget(command.ownerId, command.companionId);
    const transactionId = this.#id();
    if (budget.currency !== command.currency) {
      this.#append(command, transactionId, 1, "REJECTION", "REJECTED", 0, 0, 0, 0, "CURRENCY_MISMATCH");
      throw new ComputePolicyError("COMPUTE_CURRENCY_MISMATCH", "Reservation currency does not match the active budget.");
    }
    const withinBudget =
      budget.reservedCalls + budget.settledCalls + 1 <= budget.maxModelCalls &&
      budget.reservedInputTokens + budget.settledInputTokens + command.estimatedInputTokens <= budget.maxInputTokens &&
      budget.reservedOutputTokens + budget.settledOutputTokens + command.maxOutputTokens <= budget.maxOutputTokens &&
      budget.reservedCostMinor + budget.settledCostMinor + command.reservedCostMinor <= budget.maxCostMinor;

    if (!withinBudget) {
      this.#append(command, transactionId, 1, "REJECTION", "REJECTED", 0, 0, 0, 0, "BUDGET_EXHAUSTED");
      throw new ComputePolicyError("COMPUTE_BUDGET_EXHAUSTED", "Compute reservation exceeds the active hard cap.");
    }

    budget.reservedCalls += 1;
    budget.reservedInputTokens += command.estimatedInputTokens;
    budget.reservedOutputTokens += command.maxOutputTokens;
    budget.reservedCostMinor += command.reservedCostMinor;
    const entry = this.#append(
      command,
      transactionId,
      1,
      "RESERVATION",
      "RESERVED",
      command.estimatedInputTokens,
      command.maxOutputTokens,
      command.reservedCostMinor,
      0,
    );
    this.#transactions.set(transactionId, { command, budgetId: budget.id, requestHash, status: "RESERVED", sequence: 1 });
    this.#idempotency.set(idempotencyScope, transactionId);
    return Object.freeze({ transactionId, budgetId: budget.id, reservedCostMinor: command.reservedCostMinor, entry });
  }

  start(transactionId: string): ComputeLedgerEntry {
    const state = this.#requiredTransaction(transactionId);
    if (state.status !== "RESERVED") throw new ConflictError("Only a reserved transaction may start provider I/O.");
    state.status = "STARTED";
    state.sequence += 1;
    return this.#append(state.command, transactionId, state.sequence, "START", "STARTED", 0, 0, 0, 0);
  }

  settle(transactionId: string, settlement: ComputeSettlement): ComputeLedgerEntry {
    const state = this.#requiredTransaction(transactionId);
    if (state.status !== "STARTED") throw new ConflictError("Only a started transaction may settle.");
    for (const value of [settlement.inputTokens, settlement.outputTokens, settlement.actualCostMinor]) {
      assertNonNegativeInteger(value, "COMPUTE_SETTLEMENT_INVALID");
    }
    const budget = this.#requiredBudget(state.budgetId);
    budget.reservedCalls -= 1;
    budget.reservedInputTokens -= state.command.estimatedInputTokens;
    budget.reservedOutputTokens -= state.command.maxOutputTokens;
    budget.reservedCostMinor -= state.command.reservedCostMinor;
    budget.settledCalls += 1;
    budget.settledInputTokens += settlement.inputTokens;
    budget.settledOutputTokens += settlement.outputTokens;
    budget.settledCostMinor += settlement.actualCostMinor;
    state.status = "TERMINAL";
    state.sequence += 1;
    return this.#append(
      state.command,
      transactionId,
      state.sequence,
      "SETTLEMENT",
      settlement.status,
      settlement.inputTokens,
      settlement.outputTokens,
      0,
      settlement.actualCostMinor,
      settlement.outcomeCode,
      settlement.providerRequestIdHash,
    );
  }

  release(transactionId: string, outcomeCode = "CANCELLED_BEFORE_PROVIDER"): ComputeLedgerEntry {
    const state = this.#requiredTransaction(transactionId);
    if (state.status !== "RESERVED") throw new ConflictError("Only a reservation not yet sent to a provider may be released.");
    const budget = this.#requiredBudget(state.budgetId);
    budget.reservedCalls -= 1;
    budget.reservedInputTokens -= state.command.estimatedInputTokens;
    budget.reservedOutputTokens -= state.command.maxOutputTokens;
    budget.reservedCostMinor -= state.command.reservedCostMinor;
    state.status = "TERMINAL";
    state.sequence += 1;
    return this.#append(state.command, transactionId, state.sequence, "RELEASE", "CANCELLED", 0, 0, 0, 0, outcomeCode);
  }

  reconcile(transactionId: string, costDeltaMinor: number, outcomeCode = "PROVIDER_RECONCILIATION"): ComputeLedgerEntry {
    assertNonNegativeInteger(Math.abs(costDeltaMinor), "COMPUTE_RECONCILIATION_INVALID");
    const state = this.#requiredTransaction(transactionId);
    if (state.status !== "TERMINAL") throw new ConflictError("Only a terminal transaction may be reconciled.");
    const budget = this.#requiredBudget(state.budgetId);
    if (budget.settledCostMinor + costDeltaMinor < 0) {
      throw new ComputePolicyError("COMPUTE_RECONCILIATION_INVALID", "Reconciliation cannot make settled cost negative.");
    }
    budget.settledCostMinor += costDeltaMinor;
    state.sequence += 1;
    return this.#append(
      state.command,
      transactionId,
      state.sequence,
      "RECONCILIATION",
      "RECONCILED",
      0,
      0,
      0,
      0,
      outcomeCode,
      undefined,
      costDeltaMinor,
    );
  }

  reservePublication(ownerId: string, companionId: string, relatedEventId: string): PublicationReservation {
    const budget = this.#activePublicationBudget(ownerId, companionId);
    if (budget.reservedPublications + budget.consumedPublications + 1 > budget.maxPublications) {
      throw new ComputePolicyError("PUBLICATION_BUDGET_EXHAUSTED", "Publication reservation exceeds the independent cap.");
    }
    budget.reservedPublications += 1;
    const reservation = Object.freeze({
      id: this.#id(), budgetId: budget.id, ownerId, companionId, relatedEventId, status: "RESERVED" as const,
    });
    this.#publicationReservations.set(reservation.id, reservation);
    return reservation;
  }

  consumePublication(id: string): PublicationReservation {
    return this.#finishPublication(id, "CONSUMED");
  }

  releasePublication(id: string): PublicationReservation {
    return this.#finishPublication(id, "RELEASED");
  }

  computeBudget(ownerId: string, companionId: string): ComputeBudgetSnapshot {
    return Object.freeze({ ...this.#activeBudget(ownerId, companionId) });
  }

  publicationBudget(ownerId: string, companionId: string): PublicationBudgetSnapshot {
    return Object.freeze({ ...this.#activePublicationBudget(ownerId, companionId) });
  }

  transactionEntries(transactionId: string): readonly ComputeLedgerEntry[] {
    return this.#ledger.listByTransaction(transactionId);
  }

  #finishPublication(id: string, terminal: "CONSUMED" | "RELEASED"): PublicationReservation {
    const reservation = this.#publicationReservations.get(id);
    if (reservation === undefined || reservation.status !== "RESERVED") throw new ConflictError("Publication reservation is not active.");
    const budget = this.#publicationBudgets.get(reservation.budgetId);
    if (budget === undefined) throw new ConflictError("Publication budget is missing.");
    budget.reservedPublications -= 1;
    if (terminal === "CONSUMED") budget.consumedPublications += 1;
    const finished = Object.freeze({ ...reservation, status: terminal });
    this.#publicationReservations.set(id, finished);
    return finished;
  }

  #validateCommand(command: ReserveComputeCommand): void {
    if (command.idempotencyKey.trim() === "" || command.traceId.trim() === "") {
      throw new ComputePolicyError("COMPUTE_ATTRIBUTION_INCOMPLETE", "Idempotency and trace IDs are required.");
    }
    for (const value of [command.estimatedInputTokens, command.maxOutputTokens, command.reservedCostMinor]) {
      assertNonNegativeInteger(value, "COMPUTE_RESERVATION_INVALID");
    }
    const reason = REASON_POLICIES[command.reasonCode];
    if (reason === undefined || reason.billingParty !== command.billingParty) {
      throw new ComputePolicyError("COMPUTE_REASON_POLICY_MISMATCH", "Reason or billing party is not registered.");
    }
    if (
      command.estimatedInputTokens > reason.maxInputTokens ||
      command.maxOutputTokens > reason.maxOutputTokens ||
      command.reservedCostMinor > reason.maxReservedCostMinor
    ) {
      throw new ComputePolicyError("COMPUTE_REASON_CEILING_EXCEEDED", "Reservation exceeds the registered reason ceiling.");
    }
  }

  #activeBudget(ownerId: string, companionId: string): MutableComputeBudget {
    const id = this.#budgetByScope.get(`${ownerId}:${companionId}`);
    if (id === undefined) throw new ComputePolicyError("COMPUTE_BUDGET_MISSING", "No compute budget exists for the Owner and Companion.");
    const budget = this.#requiredBudget(id);
    const now = this.#now();
    if (now < budget.periodStart || now >= budget.periodEnd) throw new ComputePolicyError("COMPUTE_BUDGET_INACTIVE", "Compute budget is outside its active period.");
    return budget;
  }

  #activePublicationBudget(ownerId: string, companionId: string): MutablePublicationBudget {
    const id = this.#publicationBudgetByScope.get(`${ownerId}:${companionId}`);
    const budget = id === undefined ? undefined : this.#publicationBudgets.get(id);
    if (budget === undefined) throw new ComputePolicyError("PUBLICATION_BUDGET_MISSING", "No publication budget exists for the Owner and Companion.");
    const now = this.#now();
    if (now < budget.periodStart || now >= budget.periodEnd) throw new ComputePolicyError("PUBLICATION_BUDGET_INACTIVE", "Publication budget is outside its active period.");
    return budget;
  }

  #requiredBudget(id: string): MutableComputeBudget {
    const budget = this.#budgets.get(id);
    if (budget === undefined) throw new ConflictError("Compute budget is missing.");
    return budget;
  }

  #requiredTransaction(id: string): TransactionState {
    const transaction = this.#transactions.get(id);
    if (transaction === undefined) throw new ConflictError("Compute transaction does not exist.");
    return transaction;
  }

  #append(
    command: ReserveComputeCommand,
    transactionId: string,
    sequence: number,
    entryType: ComputeLedgerEntry["entryType"],
    status: ComputeLedgerEntry["status"],
    inputTokens: number,
    outputTokens: number,
    reservedCostMinor: number,
    actualCostMinor: number,
    outcomeCode?: string,
    providerRequestIdHash?: string,
    costDeltaMinor = 0,
  ): ComputeLedgerEntry {
    const entry: ComputeLedgerEntry = Object.freeze({
      id: this.#id(),
      transactionId,
      sequence,
      entryType,
      ownerId: command.ownerId,
      companionId: command.companionId,
      ...(command.socialTwinId === undefined ? {} : { socialTwinId: command.socialTwinId }),
      reasonCode: command.reasonCode,
      triggerEventType: command.triggerEventType,
      triggerEventId: command.triggerEventId,
      providerId: command.providerId,
      ...(command.credentialId === undefined ? {} : { credentialId: command.credentialId }),
      canonicalModel: command.canonicalModel,
      providerModel: command.providerModel,
      billingParty: command.billingParty,
      currency: command.currency,
      pricingVersion: command.pricingVersion,
      inputTokens,
      outputTokens,
      reservedCostMinor,
      actualCostMinor,
      costDeltaMinor,
      promptTemplateVersion: command.promptTemplateVersion,
      identityVersion: command.identityVersion,
      ...(command.socialPersonaVersion === undefined ? {} : { socialPersonaVersion: command.socialPersonaVersion }),
      memoryPolicyVersion: command.memoryPolicyVersion,
      safetyPolicyVersion: command.safetyPolicyVersion,
      routerVersion: command.routerVersion,
      status,
      ...(outcomeCode === undefined ? {} : { outcomeCode }),
      ...(providerRequestIdHash === undefined ? {} : { providerRequestIdHash }),
      traceId: command.traceId,
      attemptNo: command.attemptNo ?? 1,
      ...(command.retryParentTransactionId === undefined ? {} : { retryParentTransactionId: command.retryParentTransactionId }),
      idempotencyKeyHash: sha256(command.idempotencyKey),
      createdAt: this.#now(),
    });
    this.#ledger.append(entry);
    return entry;
  }
}
