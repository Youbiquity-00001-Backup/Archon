/**
 * In-memory OAuth state stores with TTL eviction.
 *
 * `IOAuthStateStore` / `InMemoryOAuthStateStore` — generic single-use token
 * store designed for a future GitHub OAuth flow. Not yet wired to a
 * production route; the interface is shaped for a Redis/DDB-backed swap when
 * multi-task deployments need it.
 *
 * `ISlackOidcStateStore` / `InMemorySlackOidcStateStore` — active: used by
 * `/auth/slack/initiate` to carry PKCE verifier + redirectAfter across the
 * Slack OpenID Connect round-trip.
 *
 * Process-local: acceptable for single web-task deployments.
 */
import { randomBytes } from 'node:crypto';

const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes
const TOKEN_BYTES = 24; // 192 bits ≈ urlsafe-base64 32 chars

interface StateEntry {
  slackUserId: string;
  expiresAt: number;
}

/** Pluggable interface so the store can be swapped for a Redis/DDB-backed one later. */
export interface IOAuthStateStore {
  /** Mint a fresh token bound to this Slack user; valid for `ttlMs` (or default). */
  create(slackUserId: string, ttlMs?: number): string;
  /** Look up & atomically consume a token. Returns the bound Slack user, or null. */
  consume(token: string): string | null;
  /** Test/diagnostic: return the number of live tokens. */
  size(): number;
  /** Test/diagnostic: drop all tokens. */
  clear(): void;
}

export class InMemoryOAuthStateStore implements IOAuthStateStore {
  private readonly map = new Map<string, StateEntry>();
  private readonly defaultTtlMs: number;
  private readonly clock: () => number;

  constructor(opts: { defaultTtlMs?: number; clock?: () => number } = {}) {
    this.defaultTtlMs = opts.defaultTtlMs ?? DEFAULT_TTL_MS;
    this.clock = opts.clock ?? Date.now;
  }

  create(slackUserId: string, ttlMs?: number): string {
    if (!slackUserId) {
      throw new Error('OAuth state requires a non-empty slackUserId');
    }
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    const expiresAt = this.clock() + (ttlMs ?? this.defaultTtlMs);
    this.map.set(token, { slackUserId, expiresAt });
    return token;
  }

  consume(token: string): string | null {
    if (!token) return null;
    const entry = this.map.get(token);
    if (!entry) return null;
    // Always remove on lookup — even if expired, to prevent replay attacks
    // taking advantage of clock skew between create() and consume().
    this.map.delete(token);
    if (entry.expiresAt < this.clock()) return null;
    return entry.slackUserId;
  }

  size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }
}

// ─── Slack OIDC state (PKCE) ────────────────────────────────────────────────

/**
 * State carried across the Slack OIDC PKCE round-trip. The verifier is held
 * server-side so the callback can submit it to Slack's token endpoint without
 * trusting the browser to round-trip it. `redirectAfter` is the URL the
 * caller wants Archon to bounce to once the session JWT is minted (e.g. a
 * SPA callback page or CLI redirect handler).
 */
export interface SlackOidcStateData {
  codeVerifier: string;
  redirectAfter?: string;
}

/** Pluggable interface so the store can be swapped for a shared-state one later. */
export interface ISlackOidcStateStore {
  create(data: SlackOidcStateData, ttlMs?: number): string;
  consume(token: string): SlackOidcStateData | null;
  size(): number;
  clear(): void;
}

interface SlackOidcStateEntry {
  data: SlackOidcStateData;
  expiresAt: number;
}

export class InMemorySlackOidcStateStore implements ISlackOidcStateStore {
  private readonly map = new Map<string, SlackOidcStateEntry>();
  private readonly defaultTtlMs: number;
  private readonly clock: () => number;

  constructor(opts: { defaultTtlMs?: number; clock?: () => number } = {}) {
    this.defaultTtlMs = opts.defaultTtlMs ?? DEFAULT_TTL_MS;
    this.clock = opts.clock ?? Date.now;
  }

  create(data: SlackOidcStateData, ttlMs?: number): string {
    if (!data.codeVerifier) {
      throw new Error('Slack OIDC state requires a non-empty codeVerifier');
    }
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    const expiresAt = this.clock() + (ttlMs ?? this.defaultTtlMs);
    this.map.set(token, { data, expiresAt });
    return token;
  }

  consume(token: string): SlackOidcStateData | null {
    if (!token) return null;
    const entry = this.map.get(token);
    if (!entry) return null;
    // Always remove on lookup — even if expired, to prevent replay attacks
    // taking advantage of clock skew between create() and consume().
    this.map.delete(token);
    if (entry.expiresAt < this.clock()) return null;
    return entry.data;
  }

  size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }
}
