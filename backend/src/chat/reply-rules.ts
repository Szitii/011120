/**
 * 正则替换: an Owner's own rules over what a Companion says. Each rule finds a pattern in a message
 * of a reply and puts something in its place ("take out what is in brackets"), before the safety
 * scan sees the message.
 *
 * The patterns are the Owner's, and some patterns take forever on some texts. So every rule runs in
 * a context of its own under a time limit: one that runs out of time, fails, or blows the message up
 * is skipped for that message, and the reply goes on.
 */
import vm from "node:vm";
import type { ReplyRule } from "../../../contracts/chat.ts";

export const MAX_RULES = 10;
const MAX_PATTERN_CHARS = 200;
const MAX_REPLACEMENT_CHARS = 200;
/** g: every match, i: any case, m: ^ and $ per line, s: . also matches a line break, u: whole characters. */
const FLAGS = /^[gimsu]*$/;
const RULE_TIMEOUT_MS = 50;
/** A rule may not make a message longer than this (a message is at most 2000 characters). */
const MAX_RESULT_CHARS = 4000;

/**
 * The list as it is kept: every rule with its flags (default "g": every match), its replacement
 * (default "": take the match out) and whether it is on. Null when the list cannot be used: not a
 * list of up to 10 rules, an unknown field, a pattern that is empty, too long or does not compile.
 */
export function checkRules(value: unknown): ReplyRule[] | null {
  if (!Array.isArray(value) || value.length > MAX_RULES) return null;
  const rules: ReplyRule[] = [];
  for (const item of value) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return null;
    const { pattern, flags = "g", replacement = "", enabled = true, ...unknown } = item as Record<string, unknown>;
    if (Object.keys(unknown).length > 0 || typeof pattern !== "string" || pattern.length < 1 || pattern.length > MAX_PATTERN_CHARS
      || typeof flags !== "string" || !FLAGS.test(flags) || new Set(flags).size !== flags.length
      || typeof replacement !== "string" || replacement.length > MAX_REPLACEMENT_CHARS || typeof enabled !== "boolean") return null;
    try {
      new RegExp(pattern, flags);
    } catch {
      return null;
    }
    rules.push({ pattern, flags, replacement, enabled });
  }
  return rules;
}

/** The text after every rule that is on, in order. A rule that cannot be run on it changes nothing. */
export function applyRules(text: string, rules: readonly ReplyRule[] | undefined, timeoutMs = RULE_TIMEOUT_MS): string {
  let current = text;
  for (const rule of rules ?? []) {
    if (rule.enabled === false) continue;
    try {
      // The pattern and the replacement are values in the context, never part of the code that runs.
      const next: unknown = vm.runInNewContext("text.replace(new RegExp(pattern, flags), replacement)",
        { text: current, pattern: rule.pattern, flags: rule.flags ?? "g", replacement: rule.replacement ?? "" }, { timeout: timeoutMs });
      if (typeof next === "string" && next.length <= MAX_RESULT_CHARS) current = next;
    } catch {
      // Out of time, or a pattern that stopped compiling: this rule is skipped.
    }
  }
  return current;
}
