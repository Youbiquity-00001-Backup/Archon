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
import { createPublicKey, verify, type KeyObject } from 'node:crypto';
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
  /** AWS region whose public-key endpoint is canonical for this deployment. */
  region: string;
  /**
   * Slack user ids permitted to reach `/api/*`. The chat path enforces an
   * identical allowlist via `SLACK_ALLOWED_USER_IDS`; the web path is the
   * second enforcement point so the two surfaces stay in lockstep.
   */
  allowedSlackUserIds: ReadonlySet<string>;
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

    const jwt = c.req.header('x-amzn-oidc-data');
    if (!jwt) {
      // Distinct from the "key not in allowlist" case so operators can grep
      // the log to distinguish "ALB didn't attach a JWT" (config drift) from
      // "user got past auth but is not on the allowlist" (deliberate deny).
      getLog().warn({ path: c.req.path }, 'auth.oidc.missing_jwt');
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
    if (!config.allowedSlackUserIds.has(slackUserId)) {
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

// ─── Re-exports for tests ───────────────────────────────────────────────────

export { defaultPublicKeyFetcher };
