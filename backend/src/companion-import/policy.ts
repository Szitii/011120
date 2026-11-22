import { contentHash } from "./canonical.ts";
import type { FindingSeverity, FindingType, ImportFinding } from "./types.ts";

export const IMPORT_POLICY_VERSION = "companion-import-policy/0.1.0";
export const IMPORT_PARSER_VERSION = "character-card-json/0.1.0";
export const MAX_IMPORT_BYTES = 256 * 1024;
export const MAX_DEPTH = 12;
export const MAX_NODES = 10_000;
export const MAX_STRING_LENGTH = 32_000;
export const MAX_TOTAL_STRING_LENGTH = 128_000;
export const MAX_DISPLAY_NAME_LENGTH = 200;

export const PROMPT_ONLY_FIELDS = new Set([
  "system_prompt",
  "post_history_instructions",
  "first_mes",
  "mes_example",
  "scenario",
  "creator_notes",
  "character_book",
  "alternate_greetings",
  "extensions",
]);

export const KNOWN_CARD_FIELDS = new Set([
  "name",
  "description",
  "personality",
  "creator",
  "character_version",
  "tags",
  ...PROMPT_ONLY_FIELDS,
]);

const credentialPatterns = [
  /\b(?:sk|pk)-[A-Za-z0-9_-]{16,}\b/,
  /\bgh[opurs]_[A-Za-z0-9]{20,}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\b(?:api[_ -]?key|access[_ -]?token|password)\s*[:=]\s*\S+/i,
];

const piiPatterns = [
  // An address needs one word character somewhere before the @. Matching only that keeps the scan
  // linear: the former `\b[A-Z0-9._%+-]+@` prefix took over a second on a crafted 32 KB string.
  /[A-Z0-9_][._%+-]*@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  /(?<!\d)(?:\+?\d[\d .()-]{7,}\d)(?!\d)/,
];

const injectionPatterns = [
  /\bignore\s+(?:all\s+)?(?:previous|prior|system|developer)\s+instructions?\b/i,
  /\b(?:system|developer)\s*message\s*:/i,
  /\bdo\s+not\s+follow\s+(?:the\s+)?(?:policy|rules|instructions)\b/i,
  /忽略(?:之前|以上|系统|开发者).{0,12}(?:指令|规则|提示)/,
  /(?:系统|开发者)(?:消息|指令)\s*[:：]/,
];

const activeContentPatterns = [
  /<\s*(?:script|iframe|object|embed|form)\b/i,
  /\bjavascript\s*:/i,
  /https?:\/\//i,
];

export function hasCredential(value: string): boolean {
  return credentialPatterns.some((pattern) => pattern.test(value));
}

export function hasPii(value: string): boolean {
  return piiPatterns.some((pattern) => pattern.test(value));
}

export function hasPromptInjection(value: string): boolean {
  return injectionPatterns.some((pattern) => pattern.test(value));
}

export function hasActiveContent(value: string): boolean {
  return activeContentPatterns.some((pattern) => pattern.test(value));
}

export function makeFinding(input: {
  id: string;
  type: FindingType;
  severity: FindingSeverity;
  sourcePath: string;
  action: ImportFinding["action"];
  evidence: unknown;
  safePreview?: string;
}): ImportFinding {
  return Object.freeze({
    id: input.id,
    type: input.type,
    severity: input.severity,
    sourcePath: input.sourcePath,
    action: input.action,
    evidenceHash: contentHash(input.evidence),
    ...(input.safePreview === undefined ? {} : { safePreview: input.safePreview }),
  });
}

export function safePreview(value: string): string {
  if (hasCredential(value) || hasPii(value)) {
    return "[REDACTED]";
  }

  // Cutting inside a surrogate pair would leave a lone surrogate, which PostgreSQL jsonb rejects.
  return value.replace(/\s+/g, " ").slice(0, 80).replace(/[\uD800-\uDBFF]$/, "");
}
