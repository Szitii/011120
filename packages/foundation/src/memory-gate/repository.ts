import type {
  DisclosureLevel,
  MemoryDescriptor,
  MemoryNamespace,
  MemoryPermission,
  MemoryRecord,
  RetrievedMemory,
} from "./types.ts";

export interface AuthorizedSearchRequest {
  readonly authorizedIds: readonly string[];
  readonly disclosureById: ReadonlyMap<string, DisclosureLevel>;
  readonly query: string;
  readonly maxItems: number;
}

export interface MemoryRepository {
  listDescriptors(ownerId: string, companionId: string, namespace: MemoryNamespace): readonly MemoryDescriptor[];
  listPermissions(memoryIds: readonly string[]): readonly MemoryPermission[];
  searchAuthorized(request: AuthorizedSearchRequest): readonly RetrievedMemory[];
}

export interface MemoryQueryTrace {
  readonly descriptorQueries: readonly { ownerId: string; companionId: string; namespace: MemoryNamespace }[];
  readonly authorizedSearches: readonly { authorizedIds: readonly string[]; maxItems: number }[];
}

function score(query: string, memory: MemoryRecord): number {
  const terms = new Set(query.toLowerCase().split(/\W+/).filter(Boolean));
  if (terms.size === 0) return 0;
  const haystack = `${memory.summary} ${memory.content}`.toLowerCase();
  return [...terms].reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0);
}

export class InMemoryMemoryRepository implements MemoryRepository {
  readonly #memories = new Map<string, MemoryRecord>();
  readonly #permissions: MemoryPermission[] = [];
  readonly #descriptorQueries: { ownerId: string; companionId: string; namespace: MemoryNamespace }[] = [];
  readonly #authorizedSearches: { authorizedIds: readonly string[]; maxItems: number }[] = [];

  addMemory(memory: MemoryRecord): void {
    this.#memories.set(memory.id, Object.freeze(memory));
  }

  addPermission(permission: MemoryPermission): void {
    this.#permissions.push(Object.freeze(permission));
  }

  listDescriptors(ownerId: string, companionId: string, namespace: MemoryNamespace): readonly MemoryDescriptor[] {
    this.#descriptorQueries.push(Object.freeze({ ownerId, companionId, namespace }));
    return Object.freeze([...this.#memories.values()]
      .filter((memory) => memory.ownerId === ownerId && memory.companionId === companionId && memory.namespace === namespace)
      .map(({ content: _content, summary: _summary, ...descriptor }) => Object.freeze(descriptor)));
  }

  listPermissions(memoryIds: readonly string[]): readonly MemoryPermission[] {
    const allowed = new Set(memoryIds);
    return Object.freeze(this.#permissions.filter((permission) => allowed.has(permission.memoryId)));
  }

  searchAuthorized(request: AuthorizedSearchRequest): readonly RetrievedMemory[] {
    this.#authorizedSearches.push(Object.freeze({
      authorizedIds: Object.freeze([...request.authorizedIds]),
      maxItems: request.maxItems,
    }));
    const allowed = new Set(request.authorizedIds);
    return Object.freeze([...this.#memories.values()]
      .filter((memory) => allowed.has(memory.id))
      .sort((left, right) => score(request.query, right) - score(request.query, left))
      .slice(0, request.maxItems)
      .map((memory) => {
        const disclosure = request.disclosureById.get(memory.id);
        if (disclosure === undefined) throw new Error("Authorized search is missing a disclosure decision.");
        const representation = disclosure === "FULL"
          ? memory.content
          : disclosure === "SUMMARY"
            ? memory.summary
            : "[memory exists]";
        return Object.freeze({ id: memory.id, representation, disclosure, sourceTrust: memory.sourceTrust });
      }));
  }

  trace(): MemoryQueryTrace {
    return Object.freeze({
      descriptorQueries: Object.freeze([...this.#descriptorQueries]),
      authorizedSearches: Object.freeze([...this.#authorizedSearches]),
    });
  }
}
