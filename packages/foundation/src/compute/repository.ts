import type { ComputeLedgerEntry } from "./types.ts";

export interface ComputeLedgerRepository {
  append(entry: ComputeLedgerEntry): void;
  listByTransaction(transactionId: string): readonly ComputeLedgerEntry[];
  listByOwner(ownerId: string): readonly ComputeLedgerEntry[];
}

export class InMemoryComputeLedgerRepository implements ComputeLedgerRepository {
  readonly #entries: ComputeLedgerEntry[] = [];

  append(entry: ComputeLedgerEntry): void {
    this.#entries.push(Object.freeze(entry));
  }

  listByTransaction(transactionId: string): readonly ComputeLedgerEntry[] {
    return Object.freeze(this.#entries.filter((entry) => entry.transactionId === transactionId));
  }

  listByOwner(ownerId: string): readonly ComputeLedgerEntry[] {
    return Object.freeze(this.#entries.filter((entry) => entry.ownerId === ownerId));
  }
}
