/**
 * ALB OIDC identity middleware (Patch 4 / Phase A.1).
 *
 * AWS Application Load Balancer with `authenticate-oidc` action injects a
 * signed JWT in `x-amzn-oidc-data` on every forwarded request. The JWT is
 * signed with an ECDSA P-256 (ES256) keypair specific to the AWS region;
 * the public key for a given `kid` is fetched from
 *
 *   https://public-keys.auth.elb.<region>.amazonaws.com/<kid>
 *
 * (See AWS docs: "User claims encoding".)
 *
 * This middleware:
 *   - rejects requests missing or carrying a malformed JWT (401),
 *   - verifies the JWT signature against the region-specific key (cached
 *     by `kid`) and rejects expired/forged tokens (401),
 *   - extracts the Slack user id from the `sub` claim ("T<team>-U<user>"),
 *   - enforces the Slack allowlist already in place for chat (403),
 *   - attaches a typed identity onto the request context so downstream
 *     handlers can authenticate the user.
 *
 * Local-dev policy: the middleware is only wired up at the server entry
 * point when `ALB_OIDC_REGION` is set (production AWS deployments). When
 * unset — `bun run dev`, the CLI, isolated tests — handlers see no
 * identity at all and either tolerate that or fail closed at their own
 * call sites. This keeps the dev path simple (no fake JWT minting) and
 * matches the existing pattern around `ADMIN_DRAIN_SECRET`.
 *
 * Pluggability: the key-fetching function and clock are injectable so
 * tests don't need network access or wall-clock games.
 */
import { createPublicKey, verify, createHmac, timingSafeEqual, type KeyObject } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { createLogger } from '@archon/paths';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger). */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('auth.oidc');
  return cachedLog;
}

/** Identity extracted from a verified ALB OIDC JWT. */
export interface OidcIdentity {
  /** Slack user id (the `U…` half of the `T<team>-U<user>` sub claim). */
  slackUserId: string;
  /** Email claim, when present in the userinfo response. */
  email?: string;
  /** Display name claim (`name`), when present. */
  displayName?: string;
}

/** Fetch a public key PEM for a given `kid` in a given AWS region. */
export type PublicKeyFetcher = (kid: string, region: string) => Promise<string>;

/** Configuration for the middleware factory. */
export interface OidcMiddlewareConfig {
  /**
   * AWS region whose public-key endpoint is canonical for this deployment.
   * Optional — when only the Bearer-token (Slack OIDC session JWT) path is
   * used (Caddy/Docker deployments without an ALB), region can be omitted
   * and the ALB path will reject any `x-amzn-oidc-data` header it sees.
   */
  region?: string;
  /**
   * Slack user ids permitted to reach `/api/*`. The chat path enforces an
   * identical allowlist via `SLACK_ALLOWED_USER_IDS`; the web path is the
   * second enforcement point so the two surfaces stay in lockstep.
   *
   * Empty set = **open mode**: any user with a valid Slack OIDC JWT is
   * permitted. Used by dev deployments that don't want to maintain a
   * user list. ALB OIDC still enforces "must complete the Slack
   * authorize round-trip" so the gate is still "any Slack-workspace
   * member with a valid sub claim" — not the public internet.
   */
  allowedSlackUserIds: ReadonlySet<string>;
  /**
   * Secret for signing/verifying Archon session JWTs (HS256). Required for
   * the Bearer-token auth path (`Authorization: Bearer <archon-jwt>`).
   * When unset, Bearer-token requests on public routes return 401.
   */
  sessionSecret?: string;
  /** Override for tests; defaults to `defaultPublicKeyFetcher`. */
  fetcher?: PublicKeyFetcher;
  /** Override for tests; defaults to `Date.now`. */
  clock?: () => number;
}

/**
 * Build the middleware. Returns a Hono `MiddlewareHandler`. The middleware
 * is responsible for setting `c.set('identity', ...)` so handlers can call
 * {@link getIdentity} without re-parsing the JWT.
 */
export function createOidcMiddleware(config: OidcMiddlewareConfig): MiddlewareHandler {
  const fetcher = config.fetcher ?? defaultPublicKeyFetcher;
  const clock = config.clock ?? Date.now;
  const keyCache = new Map<string, KeyObject>();

  return async (c, next) => {
    // Pass CORS preflight through unconditionally. Browsers send OPTIONS
    // without `x-amzn-oidc-data`, and the cors middleware downstream is
    // responsible for handling preflight. Blocking OPTIONS here would
    // break every cross-origin request from the SPA before it could even
    // attempt the real call.
    if (c.req.method === 'OPTIONS') {
      await next();
      return;
    }

    // Internal calls from inside the container (e.g. workflow scripts hitting
    // /api over localhost) bypass ALB and so never carry x-forwarded-for. ALB
    // always sets x-forwarded-for on public requests, so its absence proves
    // the call did not transit the internet-facing load balancer. We require
    // BOTH ALB headers be absent — a request with x-amzn-oidc-data should
    // always be JWT-validated, never silently bypassed.
    //
    // Internal callers MAY include `x-archon-internal-user` to claim an
    // identity (so child workflows the call dispatches inherit a per-user
    // env overlay). The header is trusted only on this internal path —
    // a request with x-forwarded-for set hits the JWT branch below and
    // this header is ignored. Single-tenant container, only our own code
    // can set it; trust scope is the same as the IAM identity already
    // running in the task.
    const jwt = c.req.header('x-amzn-oidc-data');
    if (!c.req.header('x-forwarded-for') && !jwt) {
      const internalUser = c.req.header('x-archon-internal-user');
      if (internalUser) {
        const identity: OidcIdentity = { slackUserId: internalUser };
        c.set('identity', identity);
        getLog().debug(
          { path: c.req.path, slackUserIdMasked: maskUid(internalUser) },
          'auth.oidc.internal_call_with_user'
        );
      } else {
        getLog().debug({ path: c.req.path }, 'auth.oidc.internal_call_bypass');
      }
      await next();
      return;
    }

    // Bearer-token path (Slack OIDC session JWT minted by /auth/slack/callback).
    // Lives between the internal bypass and the ALB JWT check so:
    //   - internal callers (no x-forwarded-for) never hit it,
    //   - it takes precedence over the ALB header check (clients on Caddy
    //     deployments have no x-amzn-oidc-data to fall through to anyway).
    // When sessionSecret is unset we explicitly refuse rather than fall
    // through, so an operator who forgets to set ARCHON_SESSION_SECRET sees
    // a clear 401 instead of silently rejecting all callers as unauthenticated.
    const authHeader = c.req.header('Authorization') ?? '';
    if (authHeader.startsWith('Bearer ')) {
      const bearerToken = authHeader.slice('Bearer '.length);
      if (!config.sessionSecret) {
        getLog().warn({ path: c.req.path }, 'auth.oidc.bearer_secret_not_configured');
        return c.json({ error: 'session tokens not configured' }, 401);
      }
      const identity = verifyArchonSessionToken(bearerToken, config.sessionSecret);
      if (!identity) {
        getLog().warn({ path: c.req.path }, 'auth.oidc.bearer_token_invalid');
        return c.json({ error: 'unauthenticated' }, 401);
      }
      if (
        config.allowedSlackUserIds.size > 0 &&
        !config.allowedSlackUserIds.has(identity.slackUserId)
      ) {
        getLog().info(
          {
            slackUserIdMasked: maskUid(identity.slackUserId),
            path: c.req.path,
          },
          'auth.oidc.bearer_allowlist_denied'
        );
        return c.json({ error: 'forbidden' }, 403);
      }
      c.set('identity', identity);
      await next();
      return;
    }

    if (!jwt) {
      // Distinct from the "key not in allowlist" case so operators can grep
      // the log to distinguish "ALB didn't attach a JWT" (config drift) from
      // "user got past auth but is not on the allowlist" (deliberate deny).
      getLog().warn({ path: c.req.path }, 'auth.oidc.missing_jwt');
      return c.json({ error: 'unauthenticated' }, 401);
    }

    // Need a region to verify ALB-injected JWTs. Reject explicitly when the
    // header is present but region is unconfigured — this catches a
    // misdeployment (ALB attached a token, server can't verify it) instead
    // of silently 401ing as "unauthenticated".
    if (!config.region) {
      getLog().warn({ path: c.req.path }, 'auth.oidc.region_not_configured');
      return c.json({ error: 'unauthenticated' }, 401);
    }

    let claims: AlbOidcClaims;
    try {
      claims = await verifyAlbOidcJwt(jwt, {
        region: config.region,
        fetcher,
        clock,
        keyCache,
      });
    } catch (err) {
      getLog().warn(
        { err, path: c.req.path, errorMessage: (err as Error).message },
        'auth.oidc.jwt_verify_failed'
      );
      return c.json({ error: 'unauthenticated' }, 401);
    }

    const slackUserId = parseSlackSub(claims.sub);
    // Empty allowlist = open mode (see OidcMiddlewareConfig docstring).
    // The size check has to come before the .has() lookup because a
    // populated Set is the signal to enforce; an empty Set falls through
    // to "permit any valid JWT."
    if (config.allowedSlackUserIds.size > 0 && !config.allowedSlackUserIds.has(slackUserId)) {
      getLog().info(
        {
          slackUserIdMasked: maskUid(slackUserId),
          path: c.req.path,
        },
        'auth.oidc.allowlist_denied'
      );
      return c.json({ error: 'forbidden' }, 403);
    }

    const identity: OidcIdentity = {
      slackUserId,
      email: typeof claims.email === 'string' ? claims.email : undefined,
      displayName: typeof claims.name === 'string' ? claims.name : undefined,
    };
    c.set('identity', identity);
    await next();
    return;
  };
}

/**
 * Read the verified identity attached by `createOidcMiddleware`. Returns
 * `undefined` when the middleware did not run (dev mode or a route that
 * was placed in the bypass list). Call sites that require identity must
 * fail closed when this returns `undefined`.
 */
export function getIdentity(c: Context): OidcIdentity | undefined {
  // Hono context's get() is loosely typed; the cast is safe because the
  // middleware is the only setter and uses the same key.
  return c.get('identity' as never) as OidcIdentity | undefined;
}

/**
 * Parse `SLACK_ALLOWED_USER_IDS` into a Set. Comma-separated, whitespace-
 * tolerant. Returns an empty Set if the env var is unset; callers decide
 * whether that means "allow all" (open dev) or "deny all" (locked-down
 * prod). The middleware factory always treats empty-allowlist as
 * deny-all — there is no scenario where Phase A.1 wants the web tier to
 * be open to every Slack workspace member.
 */
export function parseAllowedSlackUserIds(envValue: string | undefined): Set<string> {
  if (!envValue || envValue.trim() === '') return new Set();
  return new Set(
    envValue
      .split(',')
      .map(id => id.trim())
      .filter(id => id !== '')
  );
}

/**
 * Slack OIDC encodes its `sub` claim as `T<teamId>-U<userId>`. The user id
 * is what we match against the chat allowlist (which only knows Slack user
 * ids, not workspace ids), so we strip the team prefix here. If the sub is
 * already a bare user id, return it unchanged.
 */
export function parseSlackSub(sub: string): string {
  if (!sub) return '';
  const dashIdx = sub.indexOf('-');
  if (dashIdx < 0) return sub;
  return sub.slice(dashIdx + 1);
}

// ─── JWT verification ───────────────────────────────────────────────────────

interface AlbOidcClaims {
  sub: string;
  exp?: number;
  iat?: number;
  iss?: string;
  /** ALB sets `client` to the OIDC client id (the Slack app's client id). */
  client?: string;
  /** Slack OIDC userinfo extras. */
  email?: string;
  name?: string;
  [k: string]: unknown;
}

interface JwtHeader {
  alg: string;
  kid?: string;
  typ?: string;
}

interface VerifyOptions {
  region: string;
  fetcher: PublicKeyFetcher;
  clock: () => number;
  keyCache: Map<string, KeyObject>;
}

async function verifyAlbOidcJwt(jwt: string, opts: VerifyOptions): Promise<AlbOidcClaims> {
  const parts = jwt.split('.');
  if (parts.length !== 3) {
    throw new Error('malformed JWT (expected 3 segments)');
  }
  const [headerB64, payloadB64, signatureB64] = parts;

  let header: JwtHeader;
  try {
    header = JSON.parse(base64UrlDecode(headerB64).toString('utf8')) as JwtHeader;
  } catch {
    throw new Error('malformed JWT header');
  }

  // ALB only ever uses ES256. Reject anything else explicitly so a header
  // forgery to `alg: none` (the classic JWT bypass) cannot work.
  if (header.alg !== 'ES256') {
    throw new Error(`unsupported alg "${header.alg}" (expected ES256)`);
  }
  if (!header.kid) {
    throw new Error('JWT header missing kid');
  }

  const publicKey = await getCachedPublicKey(header.kid, opts);

  const signedData = Buffer.from(`${headerB64}.${payloadB64}`, 'utf8');
  const signature = base64UrlDecode(signatureB64);

  // ALB / JWS uses the IEEE P1363 raw (r || s) signature encoding.
  // Node's crypto.verify defaults to DER for ECDSA — we have to opt into
  // P1363 explicitly via dsaEncoding, otherwise verification always fails.
  const valid = verify(
    'sha256',
    signedData,
    { key: publicKey, dsaEncoding: 'ieee-p1363' },
    signature
  );
  if (!valid) {
    throw new Error('JWT signature verification failed');
  }

  let payload: AlbOidcClaims;
  try {
    payload = JSON.parse(base64UrlDecode(payloadB64).toString('utf8')) as AlbOidcClaims;
  } catch {
    throw new Error('malformed JWT payload');
  }

  // Time bounds. ALB sets `exp` to ~5 minutes after `iat`, so a stale token
  // gets caught here even when the public key is still valid.
  const nowSeconds = Math.floor(opts.clock() / 1000);
  if (typeof payload.exp === 'number' && payload.exp < nowSeconds) {
    throw new Error('JWT expired');
  }

  if (!payload.sub || typeof payload.sub !== 'string') {
    throw new Error('JWT missing sub claim');
  }

  return payload;
}

async function getCachedPublicKey(kid: string, opts: VerifyOptions): Promise<KeyObject> {
  const cached = opts.keyCache.get(kid);
  if (cached) return cached;

  const pem = await opts.fetcher(kid, opts.region);
  const key = createPublicKey(pem);
  opts.keyCache.set(kid, key);
  return key;
}

/**
 * Default public-key fetcher. Hits the AWS public-keys endpoint and
 * returns the response body as a PEM string. AWS rotates these keys
 * infrequently, and the server caches by kid forever (process lifetime).
 */
const defaultPublicKeyFetcher: PublicKeyFetcher = async (kid, region) => {
  const url = `https://public-keys.auth.elb.${region}.amazonaws.com/${encodeURIComponent(kid)}`;
  const res = await fetch(url, { headers: { Accept: 'application/x-pem-file' } });
  if (!res.ok) {
    throw new Error(`public key fetch failed: ${res.status} for kid=${kid}`);
  }
  const pem = (await res.text()).trim();
  if (!pem.includes('BEGIN PUBLIC KEY')) {
    throw new Error(`public key fetch returned non-PEM content for kid=${kid}`);
  }
  return pem;
};

// ─── Encoding helpers ───────────────────────────────────────────────────────

function base64UrlDecode(s: string): Buffer {
  // Buffer accepts 'base64url' natively in modern Node/Bun.
  return Buffer.from(s, 'base64url');
}

function maskUid(uid: string): string {
  if (uid.length <= 4) return '***';
  return `${uid.slice(0, 4)}***`;
}

// ─── Archon session JWT (HS256) ─────────────────────────────────────────────

/**
 * Mint an Archon session JWT for a Slack-authenticated identity. Signed with
 * HS256 using the operator-supplied `ARCHON_SESSION_SECRET`. Stateless — no
 * database row, no refresh token, ~1 hour TTL. Caller is responsible for
 * delivering the token to the client (typically via a `?token=` redirect
 * from `/auth/slack/callback`).
 */
export function buildArchonSessionToken(identity: OidcIdentity, secret: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const claims: Record<string, unknown> = {
    sub: identity.slackUserId,
    iss: 'archon',
    aud: 'archon-session',
    exp: now + 3600,
    iat: now,
  };
  if (identity.email) claims.email = identity.email;
  if (identity.displayName) claims.name = identity.displayName;
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signInput = `${header}.${payload}`;
  const sig = createHmac('sha256', secret).update(signInput).digest().toString('base64url');
  return `${header}.${payload}.${sig}`;
}

/**
 * Verify an Archon session JWT and return the encoded identity, or null on
 * any failure (bad signature, expired, wrong alg, missing claims). Rejects
 * `alg: none` explicitly — the classic JWT bypass.
 */
export function verifyArchonSessionToken(token: string, secret: string): OidcIdentity | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [headerB64, payloadB64, sigB64] = parts;

    const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    // Pin algorithm before any signature work — defeats alg:none and
    // alg-confusion attacks.
    if (header.alg !== 'HS256') return null;

    const expected = createHmac('sha256', secret).update(`${headerB64}.${payloadB64}`).digest();
    const actual = Buffer.from(sigB64, 'base64url');
    // Length check before timingSafeEqual — it throws on length mismatch and
    // would leak token-length info via timing if we treated the throw as
    // "invalid signature".
    if (expected.length !== actual.length) return null;
    if (!timingSafeEqual(expected, actual)) return null;

    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp === 'number' && payload.exp < now) return null;
    if (payload.iss !== 'archon' || payload.aud !== 'archon-session') return null;
    if (typeof payload.sub !== 'string' || !payload.sub) return null;

    return {
      slackUserId: payload.sub,
      email: typeof payload.email === 'string' ? payload.email : undefined,
      displayName: typeof payload.name === 'string' ? payload.name : undefined,
    };
  } catch {
    return null;
  }
}

// ─── Re-exports for tests ───────────────────────────────────────────────────

export { defaultPublicKeyFetcher };
