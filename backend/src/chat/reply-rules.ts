/**
 * 正则替换: an Owner's own rules over what a Companion says. Each rule finds a pattern in the
 * messages of a reply and puts something in its place ("take out what is in brackets"), before the
 * safety scan sees them.
 *
 * The patterns are the Owner's. Some take forever on some texts, and some replacements make a short
 * text enormous; while a rule runs, the server does nothing else. So:
 *   - all the rules of one reply share one short time limit, and run outside this program's own
 *     objects (a context of their own);
 *   - a replacement is put together piece by piece and counted as it grows, and stops at a limit
 *     (the text before and after a match, $` and $', is not offered: it squares the size);
 *   - a reply that is not chat-sized is left alone.
 * A rule that runs out of time, fails or adds too much is skipped for that reply, and the reply goes on.
 */
import vm from "node:vm";
import type { ReplyRule } from "../../../contracts/chat.ts";

export const MAX_RULES = 10;
const MAX_PATTERN_CHARS = 200;
const MAX_REPLACEMENT_CHARS = 200;
/** g: every match, i: any case, m: ^ and $ per line, s: . also matches a line break, u: whole characters. */
const FLAGS = /^[gimsu]*$/;
/** All the rules of one reply together may take this long (ten ordinary rules over a reply take about a millisecond). */
const REPLY_BUDGET_MS = 50;
/** No single rule more than this, so one bad rule does not use up the time of the others. */
const RULE_TIMEOUT_MS = 20;
/** Rules are for what a Companion says in a chat: a reply of more lines or characters than this is left as it is. */
const MAX_LINES = 12;
const MAX_REPLY_CHARS = 6000;
/** What one rule may put into a reply, all its replacements together. */
const MAX_ADDED_CHARS = 4000;

/** A piece of a replacement: text as it is, or what a match brings ($& the match, $1 a group, $<name> a named group). */
type Piece = string | { readonly ref: string };

/** A replacement in pieces, or null when it asks for the text before or after the match. */
function pieces(replacement: string): Piece[] | null {
  const list: Piece[] = [];
  let from = 0;
  for (const found of replacement.matchAll(/\$(\$|&|`|'|\d{1,2}|<[^>]*>)/g)) {
    const ref = found[1]!;
    if (ref === "`" || ref === "'") return null;
    list.push(replacement.slice(from, found.index), ref === "$" ? "$" : { ref });
    from = found.index + found[0].length;
  }
  list.push(replacement.slice(from));
  return list.filter(piece => piece !== "");
}

/** Text the database can keep: no NUL, no half of a character. */
const storable = (text: string): boolean => text.isWellFormed() && !text.includes("\0");

/** One rule as it is kept, or null when it cannot be used. */
function checkRule(item: unknown): ReplyRule | null {
  if (item === null || typeof item !== "object" || Array.isArray(item)) return null;
  const { pattern, flags = "g", replacement = "", enabled = true, ...unknown } = item as Record<string, unknown>;
  if (Object.keys(unknown).length > 0 || typeof pattern !== "string" || pattern.length < 1 || pattern.length > MAX_PATTERN_CHARS
    || typeof flags !== "string" || !FLAGS.test(flags) || new Set(flags).size !== flags.length
    || typeof replacement !== "string" || replacement.length > MAX_REPLACEMENT_CHARS || typeof enabled !== "boolean"
    || !storable(pattern) || !storable(replacement) || pieces(replacement) === null) return null;
  try {
    new RegExp(pattern, flags);
  } catch {
    return null;
  }
  return { pattern, flags, replacement, enabled };
}

/**
 * The list as it is kept: every rule with its flags (default "g": every match), its replacement
 * (default "": take the match out) and whether it is on. Null when the list cannot be used: not a
 * list of up to 10 rules, an unknown field, a pattern that is empty, too long or does not compile,
 * or a replacement that uses $` or $'.
 */
export function checkRules(value: unknown): ReplyRule[] | null {
  if (!Array.isArray(value) || value.length > MAX_RULES) return null;
  const rules = value.map(checkRule);
  return rules.every(rule => rule !== null) ? rules : null;
}

/**
 * What runs in the context: one rule over every text of the reply. The pattern, the pieces and the
 * texts are values handed in, never part of this code. `put` writes one replacement the way
 * String.replace would ($1 with no such group stays as written), counting what it adds.
 */
const RUN = new vm.Script(`(() => {
  const re = new RegExp(pattern, flags);
  let added = 0;
  const put = (...match) => {
    const groups = typeof match[match.length - 1] === "string" ? undefined : match.pop();
    match.length -= 2;
    const count = match.length - 1;
    let out = "";
    for (const piece of pieces) {
      if (typeof piece === "string") out += piece;
      else if (piece.ref === "&") out += match[0];
      else if (piece.ref[0] === "<") out += groups === undefined ? "$" + piece.ref : groups[piece.ref.slice(1, -1)] ?? "";
      else if (piece.ref.length === 2 && +piece.ref >= 1 && +piece.ref <= count) out += match[+piece.ref] ?? "";
      else if (+piece.ref[0] >= 1 && +piece.ref[0] <= count) out += (match[+piece.ref[0]] ?? "") + piece.ref.slice(1);
      else out += "$" + piece.ref;
      if (added + out.length > max) throw new RangeError("the rule adds too much");
    }
    added += out.length;
    return out;
  };
  return texts.map(text => text.replace(re, put));
})()`);

/**
 * The texts of one reply after every rule that is on, in order. A rule that cannot be run on them
 * (not a usable rule, out of time, adds too much) changes nothing; when the time for the whole reply
 * is used up, the rules that are left are not run. A rule that was stopped by what was left for the
 * reply, rather than by its own limit, has used the time up: the clock is not asked again, or a
 * fraction of a millisecond would decide whether the next rule runs.
 */
export function applyRules(texts: readonly string[], rules: unknown, budgetMs = REPLY_BUDGET_MS): string[] {
  let current = [...texts];
  // What is kept was checked when it was saved, but it is checked again: a list that got in another way must not break a reply.
  const usable = (Array.isArray(rules) ? rules.slice(0, MAX_RULES) : []).map(checkRule).filter(rule => rule !== null && rule.enabled !== false) as ReplyRule[];
  if (usable.length === 0 || texts.length > MAX_LINES || texts.reduce((sum, text) => sum + text.length, 0) > MAX_REPLY_CHARS) return current;
  const scope: Record<string, unknown> = Object.create(null);
  const context = vm.createContext(scope);
  const until = performance.now() + budgetMs;
  for (const rule of usable) {
    const left = until - performance.now();
    if (left < 1) break;
    try {
      Object.assign(scope, { texts: current, pattern: rule.pattern, flags: rule.flags, pieces: pieces(rule.replacement ?? ""), max: MAX_ADDED_CHARS });
      const next: unknown = RUN.runInContext(context, { timeout: Math.max(1, Math.floor(Math.min(left, RULE_TIMEOUT_MS))) });
      if (Array.isArray(next) && next.length === current.length && next.every(text => typeof text === "string")) current = next as string[];
    } catch (error) {
      // Out of time, too much added, or a pattern that stopped compiling: this rule is skipped.
      if (left < RULE_TIMEOUT_MS && (error as { code?: unknown } | null)?.code === "ERR_SCRIPT_EXECUTION_TIMEOUT") break;
    }
  }
  return current;
}
