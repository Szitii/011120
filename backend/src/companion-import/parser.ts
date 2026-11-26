import { TextDecoder } from "node:util";
import { ImportPolicyError } from "./errors.ts";
import {
  hasActiveContent,
  hasCredential,
  hasPii,
  hasPromptInjection,
  IMPORT_PARSER_VERSION,
  IMPORT_POLICY_VERSION,
  KNOWN_CARD_FIELDS,
  makeFinding,
  MAX_DEPTH,
  MAX_DISPLAY_NAME_LENGTH,
  MAX_EXAMPLE_LENGTH,
  MAX_IMPORT_BYTES,
  MAX_MEMORIES,
  MAX_MEMORY_LENGTH,
  MAX_WORLD_BODY_LENGTH,
  MAX_WORLD_ENTRIES,
  MAX_WORLD_KEY_LENGTH,
  MAX_WORLD_KEYS,
  MAX_NODES,
  MAX_STRING_LENGTH,
  MAX_TOTAL_STRING_LENGTH,
  PROMPT_ONLY_FIELDS,
  safePreview,
} from "./policy.ts";
import type {
  CandidateField,
  IdentityField,
  IdentityCandidate,
  ImportFinding,
  ImportSourceFormat,
  NormalizedIdentityDraft,
} from "./types.ts";

interface ParseResult {
  readonly sourceFormat: ImportSourceFormat;
  readonly draft: NormalizedIdentityDraft;
  readonly findings: readonly ImportFinding[];
}

interface ScanBudget {
  nodes: number;
  totalStringLength: number;
}

const forbiddenObjectKeys = new Set(["__proto__", "prototype", "constructor"]);

function inspectShape(value: unknown, depth: number, budget: ScanBudget): void {
  if (depth > MAX_DEPTH) {
    throw new ImportPolicyError("IMPORT_MAX_DEPTH_EXCEEDED", "Import nesting exceeds the parser limit.");
  }

  budget.nodes += 1;
  if (budget.nodes > MAX_NODES) {
    throw new ImportPolicyError("IMPORT_MAX_NODES_EXCEEDED", "Import node count exceeds the parser limit.");
  }

  if (typeof value === "string") {
    if (value.includes("\u0000") || !value.isWellFormed()) {
      throw new ImportPolicyError(
        "IMPORT_INVALID_TEXT",
        "Import text contains a prohibited null character or an unpaired surrogate.",
      );
    }
    if (value.length > MAX_STRING_LENGTH) {
      throw new ImportPolicyError("IMPORT_STRING_TOO_LONG", "An import string exceeds the parser limit.");
    }
    budget.totalStringLength += value.length;
    if (budget.totalStringLength > MAX_TOTAL_STRING_LENGTH) {
      throw new ImportPolicyError("IMPORT_TEXT_BUDGET_EXCEEDED", "Import text exceeds the parser limit.");
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const nested of value) inspectShape(nested, depth + 1, budget);
    return;
  }

  if (value !== null && typeof value === "object") {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (forbiddenObjectKeys.has(key)) {
        throw new ImportPolicyError("IMPORT_FORBIDDEN_OBJECT_KEY", "Import contains a forbidden object key.");
      }
      inspectShape(nested, depth + 1, budget);
    }
  }
}

function requirePlainObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ImportPolicyError("IMPORT_ROOT_NOT_OBJECT", "A character-card import must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

/** `text` cut to `max` characters, never inside a character (a character is at most two units, so only that much is looked at). */
const cutTo = (text: string, max: number): string => Array.from(text.slice(0, 2 * max)).slice(0, max).join("").trim();

/**
 * A card's example dialogue as we keep it: the `<START>` lines that separate examples are blank
 * lines, and the placeholders for the character and the user are the Companion's name and 主人.
 * The name is put in as it is written: a `$` in it means nothing, and it is no longer than a name
 * may be, so the text grows by no more than that for each placeholder.
 */
function exampleDialogue(text: string, name: string): string {
  const shown = cutTo(name, MAX_DISPLAY_NAME_LENGTH);
  return text.replace(/\r\n?/g, "\n").replace(/^[ \t]*<START>[ \t]*$/gim, "")
    .replace(/\{\{char\}\}|<BOT>/gi, () => shown).replace(/\{\{user\}\}|<USER>/gi, "主人")
    .replace(/\n{3,}/g, "\n\n").trim();
}

function candidate(
  id: string,
  field: CandidateField,
  value: string | readonly string[] | Record<string, unknown>,
  sourcePath: string,
  blockedByFindingIds: readonly string[],
): IdentityCandidate {
  return Object.freeze({
    id,
    field,
    value,
    sourcePath,
    sourceTrust: "EXTERNAL_UNTRUSTED" as const,
    approvable: blockedByFindingIds.length === 0,
    blockedByFindingIds: Object.freeze([...blockedByFindingIds]),
  });
}

export function parseCharacterCard(payload: Uint8Array): ParseResult {
  if (payload.byteLength === 0) {
    throw new ImportPolicyError("IMPORT_EMPTY", "Import payload is empty.");
  }
  if (payload.byteLength > MAX_IMPORT_BYTES) {
    throw new ImportPolicyError("IMPORT_TOO_LARGE", "Import payload exceeds the byte limit.");
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(payload);
  } catch {
    throw new ImportPolicyError("IMPORT_INVALID_UTF8", "Import must be valid UTF-8.");
  }

  const sniffed = text.replace(/^\uFEFF/, "").trimStart();
  if (!sniffed.startsWith("{")) {
    throw new ImportPolicyError("IMPORT_UNSUPPORTED_MEDIA_TYPE", "Only bounded JSON character cards are supported.");
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(sniffed);
  } catch {
    throw new ImportPolicyError("IMPORT_MALFORMED_JSON", "Import is not valid JSON.");
  }

  inspectShape(decoded, 0, { nodes: 0, totalStringLength: 0 });
  const root = requirePlainObject(decoded);
  const isV2 = root.spec === "chara_card_v2" && root.data !== undefined;
  const data = isV2 ? requirePlainObject(root.data) : root;
  const prefix = isV2 ? "$.data" : "$";
  const findings: ImportFinding[] = [];
  const findingIdsByPath = new Map<string, string[]>();
  let findingSequence = 0;

  const addFinding = (
    path: string,
    type: ImportFinding["type"],
    severity: ImportFinding["severity"],
    action: ImportFinding["action"],
    evidence: unknown,
    preview?: string,
  ): string => {
    const id = `finding-${++findingSequence}`;
    findings.push(makeFinding({
      id,
      type,
      severity,
      sourcePath: path,
      action,
      evidence,
      ...(preview === undefined ? {} : { safePreview: preview }),
    }));
    const ids = findingIdsByPath.get(path) ?? [];
    ids.push(id);
    findingIdsByPath.set(path, ids);
    return id;
  };

  const scanStrings = (
    value: unknown,
    path: string,
    action: ImportFinding["action"] = "CANDIDATE_BLOCKED",
  ): void => {
    if (typeof value === "string") {
      if (hasCredential(value)) {
        addFinding(path, "CREDENTIAL", "BLOCK", action, value, "[REDACTED]");
      }
      if (hasPii(value)) {
        addFinding(path, "PII", "WARNING", action, value, "[REDACTED]");
      }
      if (hasPromptInjection(value)) {
        addFinding(path, "POSSIBLE_PROMPT_INJECTION", "BLOCK", action, value, safePreview(value));
      }
      if (hasActiveContent(value)) {
        addFinding(path, "ACTIVE_CONTENT", "BLOCK", action, value, safePreview(value));
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((nested, index) => scanStrings(nested, `${path}[${index}]`, action));
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
        scanStrings(nested, `${path}.${key}`, action);
      }
    }
  };

  if (isV2) {
    for (const [field, value] of Object.entries(root)) {
      if (field === "spec" || field === "spec_version" || field === "data") continue;
      const path = `$.${field}`;
      addFinding(path, "UNKNOWN_FIELD", "WARNING", "OWNER_REVIEW", value, "Unknown envelope field excluded");
      scanStrings(value, path, "EXCLUDED");
    }
  }

  for (const [field, value] of Object.entries(data)) {
    const path = `${prefix}.${field}`;
    if (!KNOWN_CARD_FIELDS.has(field)) {
      addFinding(path, "UNKNOWN_FIELD", "WARNING", "OWNER_REVIEW", value, "Unknown field excluded");
    }

    if (PROMPT_ONLY_FIELDS.has(field)) {
      addFinding(path, "PROMPT_DIRECTIVE", "INFO", "EXCLUDED", value, "Legacy prompt metadata excluded");
    }

    const isIdentityCandidateSource = field === "name" || field === "description" || field === "personality" || field === "memories"
      || field === "mes_example";
    // The world book is scanned entry by entry below: only an entry's own words block that entry.
    if (field !== "character_book") scanStrings(value, path, isIdentityCandidateSource ? "CANDIDATE_BLOCKED" : "EXCLUDED");
    if (field === "name" && typeof value === "string" && value.trim().length > MAX_DISPLAY_NAME_LENGTH) {
      addFinding(path, "FIELD_CONSTRAINT", "BLOCK", "CANDIDATE_BLOCKED", value, "Display name exceeds 200 characters");
    }
  }

  // The card's world book (`character_book`): each usable entry is offered on its own, like a memory.
  // An entry needs trigger words and a text, and must not be switched off in the card. Everything
  // else in the book (its name, comments, positions, extensions) is not used.
  const worldCandidates: IdentityCandidate[] = [];
  const book = data.character_book;
  if (book !== undefined) {
    const bookPath = `${prefix}.character_book`;
    const fields = book !== null && typeof book === "object" && !Array.isArray(book) ? book as Record<string, unknown> : undefined;
    if (fields === undefined || !Array.isArray(fields.entries)) {
      scanStrings(book, bookPath, "EXCLUDED");
      addFinding(bookPath, "FIELD_CONSTRAINT", "WARNING", "EXCLUDED", book, "character_book needs a list of entries");
    } else {
      for (const [key, nested] of Object.entries(fields)) if (key !== "entries") scanStrings(nested, `${bookPath}.${key}`, "EXCLUDED");
      fields.entries.forEach((entry, index) => {
        const path = `${bookPath}.entries[${index}]`;
        const item = entry !== null && typeof entry === "object" && !Array.isArray(entry) ? entry as Record<string, unknown> : {};
        for (const [key, nested] of Object.entries(item)) if (key !== "keys" && key !== "content") scanStrings(nested, `${path}.${key}`, "EXCLUDED");
        // A trigger word is one line of plain text, as when the Owner types one: control characters in it are spaces.
        const words = Array.isArray(item.keys)
          ? item.keys.flatMap((key) => (typeof key === "string" ? [key.replace(/[\p{Cc}\u2028\u2029\s]+/gu, " ").trim()] : [])) : [];
        const keys = words.filter((word, at) => word !== "" && words.findIndex((other) => other.toLowerCase() === word.toLowerCase()) === at);
        const text = typeof item.content === "string" ? item.content.trim() : "";
        if (keys.length === 0 || text === "" || item.enabled === false) {
          scanStrings([item.keys, item.content], path, "EXCLUDED");
          addFinding(path, "FIELD_CONSTRAINT", "WARNING", "EXCLUDED", entry, "Not a usable world book entry (it needs keys and content, and must not be switched off)");
          return;
        }
        if (worldCandidates.length >= MAX_WORLD_ENTRIES) {
          scanStrings([item.keys, item.content], path, "EXCLUDED");
          addFinding(path, "FIELD_CONSTRAINT", "WARNING", "EXCLUDED", entry, `Only the first ${MAX_WORLD_ENTRIES} world book entries are offered`);
          return;
        }
        const before = findings.length;
        scanStrings(item.keys, `${path}.keys`);
        scanStrings(item.content, `${path}.content`);
        const blockedBy = findings.slice(before).map((finding) => finding.id);
        if (keys.some((key) => Array.from(key).length > MAX_WORLD_KEY_LENGTH)) {
          blockedBy.push(addFinding(`${path}.keys`, "FIELD_CONSTRAINT", "BLOCK", "CANDIDATE_BLOCKED", item.keys, `A trigger word exceeds ${MAX_WORLD_KEY_LENGTH} characters`));
        }
        if (keys.length > MAX_WORLD_KEYS) {
          addFinding(`${path}.keys`, "FIELD_CONSTRAINT", "INFO", "OWNER_REVIEW", item.keys, `Only the first ${MAX_WORLD_KEYS} trigger words are kept`);
        }
        if (Array.from(text).length > MAX_WORLD_BODY_LENGTH) {
          addFinding(`${path}.content`, "FIELD_CONSTRAINT", "INFO", "OWNER_REVIEW", item.content, `Cut to ${MAX_WORLD_BODY_LENGTH} characters`);
        }
        worldCandidates.push(candidate(`candidate-world-${index + 1}`, "worldEntry",
          Object.freeze({ keys: Object.freeze(keys.slice(0, MAX_WORLD_KEYS)), body: cutTo(text, MAX_WORLD_BODY_LENGTH) }), path, blockedBy));
      });
    }
  }

  const blockingIds = new Set(findings.filter((finding) => finding.action === "CANDIDATE_BLOCKED").map((finding) => finding.id));
  const candidates: IdentityCandidate[] = [];
  // Our own `memories` field: a list of short texts. Each one is offered on its own, so the Owner
  // approves memory by memory; a blocked one (credential, private data, injection) cannot be approved.
  const memories = data.memories;
  if (memories !== undefined && !Array.isArray(memories)) {
    addFinding(`${prefix}.memories`, "FIELD_CONSTRAINT", "WARNING", "EXCLUDED", memories, "memories must be a list of texts");
  }
  const memoryCandidates: IdentityCandidate[] = [];
  if (Array.isArray(memories)) {
    memories.forEach((value, index) => {
      const path = `${prefix}.memories[${index}]`;
      if (typeof value !== "string" || value.trim() === "") {
        addFinding(path, "FIELD_CONSTRAINT", "WARNING", "EXCLUDED", value, "Not a memory text");
        return;
      }
      if (memoryCandidates.length >= MAX_MEMORIES) {
        addFinding(path, "FIELD_CONSTRAINT", "WARNING", "EXCLUDED", value, `Only the first ${MAX_MEMORIES} memories are offered`);
        return;
      }
      const trimmed = value.trim();
      const blockedBy = (findingIdsByPath.get(path) ?? []).filter((id) => blockingIds.has(id));
      if (Array.from(trimmed).length > MAX_MEMORY_LENGTH) {
        blockedBy.push(addFinding(path, "FIELD_CONSTRAINT", "BLOCK", "CANDIDATE_BLOCKED", value, `A memory exceeds ${MAX_MEMORY_LENGTH} characters`));
      }
      memoryCandidates.push(candidate(`candidate-memory-${index + 1}`, "memory", trimmed, path, blockedBy));
    });
  }

  const addCandidate = (sourceField: string, field: IdentityField, asList = false): void => {
    const value = data[sourceField];
    if (typeof value !== "string" || value.trim() === "") return;
    const path = `${prefix}.${sourceField}`;
    const trimmed = value.trim();
    candidates.push(candidate(
      `candidate-${field}`,
      field,
      asList ? Object.freeze([trimmed]) : trimmed,
      path,
      (findingIdsByPath.get(path) ?? []).filter((id) => blockingIds.has(id)),
    ));
  };

  addCandidate("name", "displayName");
  addCandidate("description", "identitySummary");
  addCandidate("personality", "personaTraits", true);

  if (!candidates.some((entry) => entry.field === "displayName")) {
    throw new ImportPolicyError("IMPORT_NAME_REQUIRED", "A non-empty character name is required.");
  }
  // The card's example dialogue (`mes_example`): offered as the persona's 示例对话, cut to what the models are told.
  const example = data.mes_example;
  if (typeof example === "string") {
    const path = `${prefix}.mes_example`;
    const whole = exampleDialogue(example, (data.name as string).trim());
    const kept = cutTo(whole, MAX_EXAMPLE_LENGTH);
    if (kept !== whole) {
      addFinding(path, "FIELD_CONSTRAINT", "INFO", "OWNER_REVIEW", example, `Cut to ${MAX_EXAMPLE_LENGTH} characters`);
    }
    if (kept !== "") {
      let blockedBy = (findingIdsByPath.get(path) ?? []).filter((id) => blockingIds.has(id));
      if (blockedBy.length === 0) {
        // Nothing wrong with it as the card has it. But what is kept is not what the card has: the
        // name is put in and the <START> lines are taken out, and that can make an instruction or a
        // link out of two harmless halves. So it is scanned once more, as it is kept.
        const before = findings.length;
        scanStrings(kept, path);
        blockedBy = findings.slice(before).map((finding) => finding.id);
      }
      candidates.push(candidate("candidate-dialogueExamples", "dialogueExamples", kept, path, blockedBy));
    }
  }
  candidates.push(...memoryCandidates, ...worldCandidates);

  return Object.freeze({
    sourceFormat: isV2 ? "CHARACTER_CARD_JSON_V2" : "LEGACY_CHARACTER_JSON",
    draft: Object.freeze({
      candidates: Object.freeze(candidates),
      excludedLegacyMetadataPaths: Object.freeze(
        [...PROMPT_ONLY_FIELDS]
          .filter((field) => field in data)
          .map((field) => `${prefix}.${field}`),
      ),
    }),
    findings: Object.freeze(findings),
  });
}

export const parserMetadata = Object.freeze({
  parserVersion: IMPORT_PARSER_VERSION,
  policyVersion: IMPORT_POLICY_VERSION,
});
