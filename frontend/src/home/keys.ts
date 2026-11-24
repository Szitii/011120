export interface HomeScope {
  ownerId: string;
  companionId: string;
}

export function homeStorageKey({ ownerId, companionId }: HomeScope, item: string): string {
  return `cw:v1:owner:${encodeURIComponent(ownerId)}:home:${encodeURIComponent(companionId)}:${item}`;
}
