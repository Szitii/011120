type Card = Record<string, unknown>;

function record(value: unknown): Card | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Card : undefined;
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

export function normalizeImportCard(value: unknown, suppliedName = ""): Card | undefined {
  const root = record(value);
  if (!root) return;
  const data = record(root.data);
  const identity = record(root.identity);
  const character = record(root.character);
  const name = firstText(data?.name, root.name, identity?.display_name, root.displayName, character?.name, suppliedName);
  const rawPersona = firstText(root.raw_persona_text);
  const explicitDescription = firstText(data?.description, root.description);
  const personality = firstText(data?.personality, root.personality, explicitDescription ? rawPersona : "");
  const interestInput = identity?.public_interests;
  const interests = (Array.isArray(interestInput) ? interestInput : [interestInput])
    .flatMap(value => typeof value === "string" && value.trim() ? [value.trim()] : []);
  const description = [explicitDescription || rawPersona, interests.length ? `公开兴趣：${interests.join("、")}` : ""]
    .filter(Boolean).join("\n");

  const selected = { name, description, personality };
  // Standard cards keep their metadata for the firewall. Structured exports use an allowlist.
  const standard = root.spec === "chara_card_v2" && data;
  const legacy = !data && !identity && !character && !Object.hasOwn(root, "raw_persona_text");
  if (!standard && !legacy) {
    const memories = Array.isArray(data?.memories) ? data.memories : root.memories;
    return Array.isArray(memories) ? { ...selected, memories: memories.filter(item => typeof item === "string") } : selected;
  }
  const withoutVault = (card: Card) => Object.fromEntries(
    Object.entries(card).filter(([key]) => !key.toLowerCase().startsWith("private_memory_vault"))
  );
  return standard
    ? { ...withoutVault(root), data: { ...withoutVault(data), ...selected } }
    : { ...withoutVault(root), ...selected };
}

export function importCardName(card: Card): string {
  return firstText(record(card.data)?.name, card.name);
}
