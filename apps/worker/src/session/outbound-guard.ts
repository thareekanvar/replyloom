// Anti-ban guardrails for EVERY outgoing WhatsApp message from a session
// (agent replies, API sends, scheduled sends, keyword/AI auto-replies,
// broadcasts). Broadcasts already have their own layer (lists, ceilings,
// warm-up daily cap, per-contact cooldown, circuit breakers -- see
// claude/broadcast-anti-spam-design-2026-09-23.md); this covers the paths
// that had no limit at all.
//
// These don't make an unofficial client safe -- only the official WhatsApp
// Business Platform is -- they stop this app from producing the patterns
// WhatsApp flags most: bursts, lots of first messages to strangers, and
// bot-to-bot reply loops.
import { warmUpMultiplier } from "@workspace/db";

export type SendKind = "manual" | "api" | "broadcast" | "scheduled" | "auto";

export function parseSendKind(value: string | null | undefined): SendKind {
  return value === "api" || value === "broadcast" || value === "scheduled" || value === "auto" ? value : "manual";
}

/** Classic token bucket: `capacity` burst, then `refillPerSec` sustained. */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
    now = Date.now()
  ) {
    this.tokens = capacity;
    this.last = now;
  }

  private refill(now: number) {
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.refillPerSec);
    this.last = now;
  }

  /** Takes a token and returns 0, or returns how many ms until one is free. */
  take(now = Date.now()): number {
    this.refill(now);
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return 0;
    }
    return Math.ceil(((1 - this.tokens) / this.refillPerSec) * 1000);
  }
}

/** Per-session outbound pace: bursts of 8, then ~24 messages/minute. */
export const OUTBOUND_BURST = 8;
export const OUTBOUND_PER_SEC = 0.4;
/** A send that would wait longer than this is refused instead (429). */
export const MAX_QUEUE_WAIT_MS = 5_000;

/**
 * Auto-replies (keyword rules + AI agent) are the classic ban trigger when
 * two bots answer each other forever. Per contact: at most 1 per minute and
 * 5 per hour; per session: at most 120 per hour.
 */
export class AutoReplyLimiter {
  private perContact = new Map<string, number[]>();
  private session: number[] = [];

  constructor(
    private readonly perContactMinGapMs = 60_000,
    private readonly perContactPerHour = 5,
    private readonly sessionPerHour = 120
  ) {}

  allow(jid: string, now = Date.now()): boolean {
    const hourAgo = now - 60 * 60_000;
    const history = (this.perContact.get(jid) ?? []).filter((t) => t > hourAgo);
    this.session = this.session.filter((t) => t > hourAgo);
    const last = history.at(-1);
    if (last !== undefined && now - last < this.perContactMinGapMs) return false;
    if (history.length >= this.perContactPerHour) return false;
    if (this.session.length >= this.sessionPerHour) return false;
    history.push(now);
    this.perContact.set(jid, history);
    this.session.push(now);
    if (this.perContact.size > 5_000) this.perContact.clear();
    return true;
  }
}

/**
 * Daily cap on *new* chats: first messages to numbers that have never
 * written to this number. Scaled by the same warm-up tiers as broadcasts,
 * so a freshly linked number can't start messaging strangers at full rate.
 */
export const BASE_NEW_CHATS_PER_DAY = 50;
export function newChatDailyCap(sessionCreatedAt: Date | null | undefined, now = new Date()) {
  return Math.max(5, Math.round(BASE_NEW_CHATS_PER_DAY * warmUpMultiplier(sessionCreatedAt, now)));
}

export function dayKey(now = new Date()) {
  return now.toISOString().slice(0, 10);
}
