import { contentHash } from "../companion-import/canonical.ts";

export const ENCOUNTER_SAFETY_POLICY_VERSION = "encounter-safety/0.1.0";

export interface SafetyScanResult {
  readonly contentHash: string;
  readonly sanitized: string;
  readonly threatTypes: readonly string[];
  readonly decision: "ALLOW" | "REDACT" | "BLOCK" | "LIMIT";
  readonly redactionCount: number;
}

const credentialPatterns = [
  /\b(?:sk|pk)-[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[opurs]_[A-Za-z0-9]{20,}\b/g,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  /\b(?:api[_ -]?key|access[_ -]?token|password)\s*[:=]\s*\S+/gi,
];
const injectionPatterns = [
  /\bignore\s+(?:all\s+)?(?:previous|prior|system|developer)\s+instructions?\b/i,
  /忽略(?:之前|以上|系统|开发者).{0,12}(?:指令|规则|提示)/,
];
const emailPattern = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const phonePattern = /(?<!\d)(?:\+?\d[\d .()-]{7,}\d)(?!\d)/g;

function containsCredential(content: string): boolean {
  return credentialPatterns.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(content);
  });
}

export class EncounterSafetyPipeline {
  readonly #protectedTerms: readonly string[];

  constructor(protectedTerms: readonly string[] = []) {
    this.#protectedTerms = Object.freeze([...protectedTerms].filter((term) => term.length > 0));
  }

  scanInput(content: string): SafetyScanResult {
    if (content.trim().length === 0 || content.length > 2_000 || containsCredential(content)) {
      return Object.freeze({
        contentHash: contentHash(content),
        sanitized: "",
        threatTypes: Object.freeze([content.length > 2_000 ? "INPUT_LENGTH" : content.trim().length === 0 ? "INPUT_EMPTY" : "CREDENTIAL"]),
        decision: "BLOCK",
        redactionCount: 0,
      });
    }
    let sanitized = content;
    let redactionCount = 0;
    sanitized = sanitized.replace(emailPattern, () => {
      redactionCount += 1;
      return "[REDACTED_PII]";
    }).replace(phonePattern, () => {
      redactionCount += 1;
      return "[REDACTED_PII]";
    });
    const injected = injectionPatterns.some((pattern) => pattern.test(content));
    return Object.freeze({
      contentHash: contentHash(content),
      sanitized,
      threatTypes: Object.freeze([
        ...(injected ? ["PROMPT_INJECTION"] : []),
        ...(redactionCount > 0 ? ["PII"] : []),
      ]),
      decision: injected ? "LIMIT" : redactionCount > 0 ? "REDACT" : "ALLOW",
      redactionCount,
    });
  }

  scanOutput(content: string): SafetyScanResult {
    const hasProtectedTerm = this.#protectedTerms.some((term) => content.includes(term));
    if (content.trim().length === 0 || content.length > 2_000 || containsCredential(content) || hasProtectedTerm) {
      return Object.freeze({
        contentHash: contentHash(content),
        sanitized: "",
        threatTypes: Object.freeze([
          ...(content.trim().length === 0 ? ["OUTPUT_EMPTY"] : []),
          ...(content.length > 2_000 ? ["OUTPUT_LENGTH"] : []),
          ...(containsCredential(content) ? ["CREDENTIAL"] : []),
          ...(hasProtectedTerm ? ["PRIVATE_CANARY"] : []),
        ]),
        decision: "BLOCK",
        redactionCount: 0,
      });
    }
    let redactionCount = 0;
    const sanitized = content.replace(emailPattern, () => {
      redactionCount += 1;
      return "[REDACTED_PII]";
    }).replace(phonePattern, () => {
      redactionCount += 1;
      return "[REDACTED_PII]";
    });
    return Object.freeze({
      contentHash: contentHash(content),
      sanitized,
      threatTypes: Object.freeze(redactionCount > 0 ? ["PII"] : []),
      decision: redactionCount > 0 ? "REDACT" : "ALLOW",
      redactionCount,
    });
  }
}
