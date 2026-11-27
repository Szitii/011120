import type { ActiveIdentityContext, IdentityKind } from "../contracts.ts";

export class InvalidIdentityContextError extends Error {
  constructor() { super("Invalid identity context."); }
}

function record(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : undefined;
}

export function validateIdentityContext(payload: unknown, requested?: { kind: IdentityKind; id: string }): ActiveIdentityContext {
  const result = record(payload);
  const viewer = record(result?.viewer);
  const subject = record(result?.activeSubject);
  const presentation = record(subject?.presentation);
  if (typeof viewer?.ownerId !== "string" || !viewer.ownerId.trim()
      || typeof subject?.id !== "string" || !subject.id.trim()
      || (subject.kind === "OWNER" && subject.id !== viewer.ownerId)
      || typeof presentation?.displayName !== "string"
      || (requested ? subject.kind !== requested.kind || subject.id !== requested.id
        : subject.kind !== "OWNER" || subject.id !== viewer.ownerId)) {
    throw new InvalidIdentityContextError();
  }
  return payload as ActiveIdentityContext;
}
