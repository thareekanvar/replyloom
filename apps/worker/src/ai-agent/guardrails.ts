import type { AgentConfig, AgentEnv, GuardrailResult, IntentLabel } from "./types";
import { buildClassifierPrompt } from "./system-prompt";
import { gatewayRunOptions } from "./gateway";

// Exact canned responses for refused intents. The CODING wording is a hard
// product requirement — the agent is a support assistant and must never
// soften into actually helping with code.
const CANNED: Record<Exclude<IntentLabel, "SUPPORT">, (biz: string) => string> = {
  CODING: () =>
    "I'm a support assistant, so I can't help with coding — happy to help with your account, order, or product questions instead.",
  SENSITIVE: () =>
    "I'm not able to share that kind of internal detail. I'm happy to help with your account or order instead.",
  OFF_TOPIC: (biz) => `I can only help with questions about ${biz}. What can I help you with there?`,
};

function toResult(label: IntentLabel, businessName: string): GuardrailResult {
  if (!isHardBlockedIntent(label)) return { allowed: true, label };
  return { allowed: false, label, cannedReply: CANNED[label as "CODING" | "SENSITIVE"](businessName) };
}

/** Keep safety boundaries, but do not hard-block ordinary conversational traffic. */
export function isHardBlockedIntent(label: IntentLabel | string): boolean {
  return label === "CODING" || label === "SENSITIVE";
}

/**
 * Fast, cheap gate that runs BEFORE any retrieval or generation. Uses a
 * small model so this costs a fraction of a full reply and keeps latency
 * low. Falls back to keyword rules if the model call fails, so a classifier
 * outage never opens the gate wide.
 */
export async function classifyIntent(
  env: AgentEnv,
  config: AgentConfig,
  message: string,
): Promise<GuardrailResult> {
  const keywordLabel = keywordPrecheck(message);
  if (keywordLabel) return toResult(keywordLabel, config.businessName);

  try {
    const result: any = await env.AI.run(
      config.models.classifier,
      {
        messages: [{ role: "user", content: buildClassifierPrompt(config, message) }],
        max_tokens: 5,
      },
      gatewayRunOptions(env, config.workspaceId, "classifier"),
    );
    const raw = String(result?.response ?? "").trim().toUpperCase();
    // Default open on an ambiguous parse — the RAG grounding + strict system
    // prompt are the real backstop for anything that slips past here.
    const label = (["SUPPORT", "CODING", "SENSITIVE", "OFF_TOPIC"] as IntentLabel[]).find((l) =>
      raw.startsWith(l),
    );
    return toResult(label ?? "SUPPORT", config.businessName);
  } catch {
    // Classifier down — be conservative but don't hard-block support traffic.
    return { allowed: true, label: "SUPPORT" };
  }
}

/**
 * Catches the obvious, cheap-to-detect cases without spending a model call.
 * Deliberately narrow patterns — a false positive here (e.g. matching
 * "write me an invoice" as CODING) would wrongly silence a real support
 * question, so the classifier handles everything that isn't unmistakable.
 */
export function keywordPrecheck(message: string): IntentLabel | null {
  const m = message.toLowerCase().trim();

  const coding =
    /\b(write|fix|debug|explain|review|refactor|deploy|create)\s*(me\s+|the\s+|this\s+)?(code|script|function|class|regex|sql|query|api|endpoint|dockerfile|config)\b/.test(m) ||
    /\b(code|script|debug|compile|syntax)\s*(me|this|for me)?\b/.test(m);
  if (coding) return "CODING";
  const sensitive =
    /\b(api\s*key|secret\s*key|auth\s*token|access\s*token|source\s*code|system\s*prompt|your\s*instructions|internal\s*(cost|price|pricing)|cost\s*price|profit\s*margin|margin\d*|another\s*customer('?s)?\s*(data|order|info)|username\s*and\s*password|credentials)\b/.test(
      m,
    );
  if (sensitive) return "SENSITIVE";
  return null;
}

/** Only escalate automatically when the customer asks for it or is clearly upset. */
export function shouldEscalateToHuman(message: string): boolean {
  const m = message.toLowerCase();
  return /\b(human|person|agent|representative|team member|support staff)\b/.test(m) &&
    /\b(connect|speak|talk|transfer|escalat|real|please)\b/.test(m) ||
    /\b(frustrat|angry|furious|ridiculous|unacceptable|terrible|worst|useless|fed up)\b/.test(m);
}

// Regex net for anything the model might leak despite the system prompt.
// Runs on every final output before it's sent to a customer or cached.
const SENSITIVE_PATTERNS: RegExp[] = [
  /\b[sp]k_(live|test)?_?[A-Za-z0-9]{16,}\b/g, // Stripe-style API keys (live/test & raw)
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access keys
  /\b\d{13,19}\b/g, // card-number-length digit runs
  /\bBearer\s+[A-Za-z0-9\-._~+/]+=*\b/g, // bearer tokens
  /\bgh[pous]_[A-Za-z0-9]{20,}\b/g, // GitHub tokens/keys
  /\b(BEGIN|END)\s+(RSA|EC|OPENSSH|PRIVATE)\s+KEY\b/g, // key blocks
];

export function redactSensitive(text: string): string {
  return SENSITIVE_PATTERNS.reduce((t, re) => t.replace(re, "[redacted]"), text);
}
