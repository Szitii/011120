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
  MAX_IMPORT_BYTES,
  MAX_NODES,
  MAX_STRING_LENGTH,
  MAX_TOTAL_STRING_LENGTH,
  PROMPT_ONLY_FIELDS,
  safePreview,
} from "./policy.ts";
import type {
  CompanionImportRecord,
  IdentityCandidate,
  IdentityField,
  ImportFinding,
  NormalizedIdentityDraft,
} from "./types.ts";

interface ParseResult {
  readonly sourceFormat: CompanionImportRecord["sourceFormat"];
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
    if (value.includes("\u0000")) {
      throw new ImportPolicyError("IMPORT_INVALID_TEXT", "Import text contains a prohibited null character.");
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

function candidate(
  id: string,
  field: IdentityField,
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

    const isIdentityCandidateSource = field === "name" || field === "description" || field === "personality";
    scanStrings(value, path, isIdentityCandidateSource ? "CANDIDATE_BLOCKED" : "EXCLUDED");
    if (field === "name" && typeof value === "string" && value.trim().length > MAX_DISPLAY_NAME_LENGTH) {
      addFinding(path, "FIELD_CONSTRAINT", "BLOCK", "CANDIDATE_BLOCKED", value, "Display name exceeds 200 characters");
    }
  }

  const candidates: IdentityCandidate[] = [];
  const addStringCandidate = (sourceField: string, field: IdentityField): void => {
    const value = data[sourceField];
    if (typeof value !== "string" || value.trim() === "") return;
    const path = `${prefix}.${sourceField}`;
    candidates.push(
      candidate(
        `candidate-${field}`,
        field,
        value.trim(),
        path,
        findingIdsByPath.get(path)?.filter((id) => findings.find((finding) => finding.id === id)?.action === "CANDIDATE_BLOCKED") ?? [],
      ),
    );
  };

  addStringCandidate("name", "displayName");
  addStringCandidate("description", "identitySummary");
  const personality = data.personality;
  if (typeof personality === "string" && personality.trim() !== "") {
    const path = `${prefix}.personality`;
    candidates.push(
      candidate(
        "candidate-personaTraits",
        "personaTraits",
        Object.freeze([personality.trim()]),
        path,
        findingIdsByPath.get(path)?.filter((id) => findings.find((finding) => finding.id === id)?.action === "CANDIDATE_BLOCKED") ?? [],
      ),
    );
  }

  if (!candidates.some((entry) => entry.field === "displayName")) {
    throw new ImportPolicyError("IMPORT_NAME_REQUIRED", "A non-empty character name is required.");
  }

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
