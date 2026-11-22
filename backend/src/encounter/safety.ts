import { contentHash } from "../companion-import/canonical.ts";
import { hasCredential } from "../companion-import/policy.ts";

export const ENCOUNTER_SAFETY_POLICY_VERSION = "encounter-safety/0.1.0";

export interface SafetyScanResult {
  readonly contentHash: string;
  readonly sanitized: string;
  readonly threatTypes: readonly string[];
  readonly decision: "ALLOW" | "REDACT" | "BLOCK" | "LIMIT";
  readonly redactionCount: number;
}

const MAX_CHARS = 2_000;
const injectionPatterns = [
  /\bignore\s+(?:all\s+)?(?:previous|prior|system|developer)\s+instructions?\b/i,
  /忽略(?:之前|以上|系统|开发者).{0,12}(?:指令|规则|提示)/,
];
// Whole addresses and numbers are replaced, so these match the full span (unlike the import policy's detectors).
const piiPatterns = [/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, /(?<!\d)(?:\+?\d[\d .()-]{7,}\d)(?!\d)/g];

const blocked = (content: string, threatTypes: readonly string[]): SafetyScanResult =>
  Object.freeze({
    contentHash: contentHash(content),
    sanitized: "",
    threatTypes: Object.freeze([...threatTypes]),
    decision: "BLOCK",
    redactionCount: 0,
  });

function redactPii(content: string): { sanitized: string; redactionCount: number } {
  let redactionCount = 0;
  const sanitized = piiPatterns.reduce((text, pattern) => text.replace(pattern, () => {
    redactionCount += 1;
    return "[REDACTED_PII]";
  }), content);
  return { sanitized, redactionCount };
}

export class EncounterSafetyPipeline {
  readonly #protectedTerms: readonly string[];

  constructor(protectedTerms: readonly string[] = []) {
    this.#protectedTerms = Object.freeze(protectedTerms.filter((term) => term.length > 0));
  }

  scanInput(content: string): SafetyScanResult {
    if (content.length > MAX_CHARS) return blocked(content, ["INPUT_LENGTH"]);
    if (content.trim().length === 0) return blocked(content, ["INPUT_EMPTY"]);
    if (hasCredential(content)) return blocked(content, ["CREDENTIAL"]);
    const { sanitized, redactionCount } = redactPii(content);
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
    const threats = [
      ...(content.trim().length === 0 ? ["OUTPUT_EMPTY"] : []),
      ...(content.length > MAX_CHARS ? ["OUTPUT_LENGTH"] : []),
      ...(hasCredential(content) ? ["CREDENTIAL"] : []),
      ...(this.#protectedTerms.some((term) => content.includes(term)) ? ["PRIVATE_CANARY"] : []),
    ];
    if (threats.length > 0) return blocked(content, threats);
    const { sanitized, redactionCount } = redactPii(content);
    return Object.freeze({
      contentHash: contentHash(content),
      sanitized,
      threatTypes: Object.freeze(redactionCount > 0 ? ["PII"] : []),
      decision: redactionCount > 0 ? "REDACT" : "ALLOW",
      redactionCount,
    });
  }
}
