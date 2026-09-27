// Auto-reply "regex" rules are user-written patterns run against EVERY
// inbound message inside the WhatsApp session Durable Object. JavaScript
// regexes backtrack, so a pattern like `(a+)+$` against a crafted message
// can take seconds-to-forever (ReDoS) and freeze that number's session.
// Defence in depth:
//   1. validateRulePattern() rejects risky shapes when the rule is saved,
//   2. compileRulePattern() re-checks + compiles once (cached),
//   3. matchRulePattern() caps the input length it runs on.

export const MAX_RULE_PATTERN_LENGTH = 200;
export const MAX_MATCH_INPUT_LENGTH = 1_000;

// A quantified group that itself contains a quantifier or alternation:
// (a+)+  (a*)*  (a|ab)*  (\w+\s?){2,}  -- the classic catastrophic shapes.
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*(?:[+*]|\{\d+,?\d*\}|\|)(?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d+,?\d*\})/;
// Backreferences / lookbehind make matching super-linear or engine-specific.
const BACKREFERENCE = /\\[1-9]|\\k<|\(\?<[=!]/;

/** Returns a user-facing error, or null when the pattern is acceptable. */
export function validateRulePattern(pattern: string): string | null {
  if (!pattern.trim()) return "Pattern can't be empty.";
  if (pattern.length > MAX_RULE_PATTERN_LENGTH) {
    return `Pattern is too long (max ${MAX_RULE_PATTERN_LENGTH} characters).`;
  }
  try {
    new RegExp(pattern, "i");
  } catch {
    return "That isn't a valid regular expression.";
  }
  if (NESTED_QUANTIFIER.test(pattern)) {
    return "Nested repetition like (a+)+ or (a|b)* can freeze message handling. Simplify the pattern.";
  }
  if (BACKREFERENCE.test(pattern)) {
    return "Backreferences and lookbehind aren't allowed in auto-reply patterns.";
  }
  return null;
}

const compiled = new Map<string, RegExp | null>();

/** Compiled, validated regex (cached per pattern), or null if unsafe/invalid. */
export function compileRulePattern(pattern: string): RegExp | null {
  const hit = compiled.get(pattern);
  if (hit !== undefined) return hit;
  let re: RegExp | null = null;
  if (validateRulePattern(pattern) === null) {
    try {
      re = new RegExp(pattern, "i");
    } catch {
      re = null;
    }
  }
  if (compiled.size > 2_000) compiled.clear();
  compiled.set(pattern, re);
  return re;
}

/** Matches with the input capped; an unsafe/invalid pattern never matches. */
export function matchRulePattern(pattern: string, text: string): boolean {
  const re = compileRulePattern(pattern);
  if (!re) return false;
  return re.test(text.length > MAX_MATCH_INPUT_LENGTH ? text.slice(0, MAX_MATCH_INPUT_LENGTH) : text);
}
