import { describe, test, expect } from 'bun:test';
import { Hono } from 'hono';
import {
  buildArchonSessionToken,
  verifyArchonSessionToken,
  createOidcMiddleware,
  getIdentity,
  type OidcIdentity,
} from './oidc-identity';

const SECRET = 'test-secret-do-not-use-in-prod-test-secret-do-not-use-in-prod';

describe('buildArchonSessionToken + verifyArchonSessionToken', () => {
  test('round-trips a minimal identity', () => {
    const identity: OidcIdentity = { slackUserId: 'U_ALICE' };
    const token = buildArchonSessionToken(identity, SECRET);
    expect(token.split('.').length).toBe(3);
    const verified = verifyArchonSessionToken(token, SECRET);
    expect(verified).toEqual({
      slackUserId: 'U_ALICE',
      email: undefined,
      displayName: undefined,
    });
  });

  test('round-trips email + displayName when present', () => {
    const identity: OidcIdentity = {
      slackUserId: 'U_BOB',
      email: 'bob@example.com',
      displayName: 'Bob',
    };
    const token = buildArchonSessionToken(identity, SECRET);
    expect(verifyArchonSessionToken(token, SECRET)).toEqual(identity);
  });

  test('returns null when secret differs (signature check)', () => {
    const token = buildArchonSessionToken({ slackUserId: 'U_X' }, SECRET);
    expect(verifyArchonSessionToken(token, 'wrong-secret')).toBeNull();
  });

  test('returns null on malformed (not 3 segments)', () => {
    expect(verifyArchonSessionToken('not.a.jwt.has.too.many', SECRET)).toBeNull();
    expect(verifyArchonSessionToken('bare-string', SECRET)).toBeNull();
    expect(verifyArchonSessionToken('one.two', SECRET)).toBeNull();
  });

  test('rejects alg: none header (classic JWT bypass)', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        sub: 'U_X',
        iss: 'archon',
        aud: 'archon-session',
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000),
      })
    ).toString('base64url');
    // Empty signature segment — common alg:none forgery.
    const forged = `${header}.${payload}.`;
    expect(verifyArchonSessionToken(forged, SECRET)).toBeNull();
  });

  test('rejects expired tokens', () => {
    // Build a token, then verify with the system clock advanced past exp.
    const identity: OidcIdentity = { slackUserId: 'U_OLD' };
    const token = buildArchonSessionToken(identity, SECRET);
    // The verifier compares against Date.now(); we can't mock that without
    // dep injection, so instead craft a JWT with a past `exp`.
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const past = Math.floor(Date.now() / 1000) - 10;
    const payload = Buffer.from(
      JSON.stringify({
        sub: 'U_OLD',
        iss: 'archon',
        aud: 'archon-session',
        exp: past,
        iat: past - 3600,
      })
    ).toString('base64url');
    const { createHmac } = require('node:crypto') as typeof import('node:crypto');
    const sig = createHmac('sha256', SECRET)
      .update(`${header}.${payload}`)
      .digest()
      .toString('base64url');
    const expired = `${header}.${payload}.${sig}`;
    expect(verifyArchonSessionToken(expired, SECRET)).toBeNull();
    // Sanity: a fresh token still works.
    expect(verifyArchonSessionToken(token, SECRET)?.slackUserId).toBe('U_OLD');
  });

  test('rejects tokens with wrong iss or aud', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const baseClaims = {
      sub: 'U_X',
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
    };
    const { createHmac } = require('node:crypto') as typeof import('node:crypto');
    const sign = (payload: Record<string, unknown>): string => {
      const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
      const s = createHmac('sha256', SECRET)
        .update(`${header}.${p}`)
        .digest()
        .toString('base64url');
      return `${header}.${p}.${s}`;
    };
    expect(
      verifyArchonSessionToken(sign({ ...baseClaims, iss: 'other', aud: 'archon-session' }), SECRET)
    ).toBeNull();
    expect(
      verifyArchonSessionToken(sign({ ...baseClaims, iss: 'archon', aud: 'someone-else' }), SECRET)
    ).toBeNull();
  });

  test('rejects tokens with missing or non-string sub', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const { createHmac } = require('node:crypto') as typeof import('node:crypto');
    const sign = (payload: Record<string, unknown>): string => {
      const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
      const s = createHmac('sha256', SECRET)
        .update(`${header}.${p}`)
        .digest()
        .toString('base64url');
      return `${header}.${p}.${s}`;
    };
    const base = {
      iss: 'archon',
      aud: 'archon-session',
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
    };
    expect(verifyArchonSessionToken(sign(base), SECRET)).toBeNull();
    expect(verifyArchonSessionToken(sign({ ...base, sub: '' }), SECRET)).toBeNull();
    expect(verifyArchonSessionToken(sign({ ...base, sub: 123 }), SECRET)).toBeNull();
  });

  test('rejects garbage that throws during JSON parse', () => {
    // Random non-base64 garbage should be swallowed → null, not thrown.
    expect(verifyArchonSessionToken('@@@.###.$$$', SECRET)).toBeNull();
  });
});

// ─── Bearer-token path in the middleware ────────────────────────────────────

function makeApp(opts: { sessionSecret?: string; allowed?: ReadonlySet<string> }): Hono {
  const app = new Hono();
  const mw = createOidcMiddleware({
    region: 'us-east-1',
    allowedSlackUserIds: opts.allowed ?? new Set<string>(),
    sessionSecret: opts.sessionSecret,
  });
  app.use('/api/*', mw);
  app.get('/api/echo', c => {
    const identity = getIdentity(c);
    return c.json({ identity: identity ?? null });
  });
  return app;
}

function publicRequest(
  app: Hono,
  path: string,
  headers: Record<string, string> = {}
): Promise<Response> {
  // x-forwarded-for marks the request as "public" (came in via ALB / proxy)
  // so the internal-bypass branch does not run.
  return app.request(path, {
    method: 'GET',
    headers: { 'x-forwarded-for': '1.2.3.4', ...headers },
  });
}

describe('createOidcMiddleware — Bearer-token path', () => {
  test('valid Bearer token attaches identity and 200s', async () => {
    const app = makeApp({ sessionSecret: SECRET });
    const token = buildArchonSessionToken(
      { slackUserId: 'U_ALICE', email: 'alice@x.com', displayName: 'Alice' },
      SECRET
    );
    const res = await publicRequest(app, '/api/echo', {
      Authorization: `Bearer ${token}`,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { identity: OidcIdentity | null };
    expect(body.identity).toEqual({
      slackUserId: 'U_ALICE',
      email: 'alice@x.com',
      displayName: 'Alice',
    });
  });

  test('Bearer token with wrong signature returns 401', async () => {
    const app = makeApp({ sessionSecret: SECRET });
    const token = buildArchonSessionToken({ slackUserId: 'U_X' }, 'other-secret');
    const res = await publicRequest(app, '/api/echo', {
      Authorization: `Bearer ${token}`,
    });
    expect(res.status).toBe(401);
  });

  test('Bearer header with sessionSecret unset returns 401 (configured-out)', async () => {
    const app = makeApp({}); // no sessionSecret
    const token = buildArchonSessionToken({ slackUserId: 'U_X' }, SECRET);
    const res = await publicRequest(app, '/api/echo', {
      Authorization: `Bearer ${token}`,
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('session tokens not configured');
  });

  test('Bearer token denied when sub is not in non-empty allowlist (403)', async () => {
    const app = makeApp({
      sessionSecret: SECRET,
      allowed: new Set(['U_ALLOWED']),
    });
    const token = buildArchonSessionToken({ slackUserId: 'U_OTHER' }, SECRET);
    const res = await publicRequest(app, '/api/echo', {
      Authorization: `Bearer ${token}`,
    });
    expect(res.status).toBe(403);
  });

  test('Bearer token permitted when sub is in allowlist', async () => {
    const app = makeApp({
      sessionSecret: SECRET,
      allowed: new Set(['U_ALLOWED']),
    });
    const token = buildArchonSessionToken({ slackUserId: 'U_ALLOWED' }, SECRET);
    const res = await publicRequest(app, '/api/echo', {
      Authorization: `Bearer ${token}`,
    });
    expect(res.status).toBe(200);
  });

  test('empty allowlist = open mode for Bearer path too', async () => {
    const app = makeApp({ sessionSecret: SECRET, allowed: new Set() });
    const token = buildArchonSessionToken({ slackUserId: 'U_ANY' }, SECRET);
    const res = await publicRequest(app, '/api/echo', {
      Authorization: `Bearer ${token}`,
    });
    expect(res.status).toBe(200);
  });

  test('no Bearer and no ALB JWT → 401 unauthenticated', async () => {
    const app = makeApp({ sessionSecret: SECRET });
    const res = await publicRequest(app, '/api/echo');
    expect(res.status).toBe(401);
  });

  test('internal call (no x-forwarded-for) bypasses Bearer check entirely', async () => {
    const app = makeApp({ sessionSecret: SECRET });
    // No x-forwarded-for, no Authorization, no x-amzn-oidc-data → internal bypass.
    const res = await app.request('/api/echo', { method: 'GET' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { identity: OidcIdentity | null };
    // Internal bypass with no x-archon-internal-user attaches no identity.
    expect(body.identity).toBeNull();
  });

  test('ALB JWT header present but region unset → 401 (explicit reject)', async () => {
    const app = new Hono();
    const mw = createOidcMiddleware({
      // region intentionally omitted; only Bearer auth is configured.
      allowedSlackUserIds: new Set<string>(),
      sessionSecret: SECRET,
    });
    app.use('/api/*', mw);
    app.get('/api/echo', c => c.json({ ok: true }));
    const res = await app.request('/api/echo', {
      method: 'GET',
      headers: {
        'x-forwarded-for': '1.2.3.4',
        'x-amzn-oidc-data': 'header.payload.sig',
      },
    });
    expect(res.status).toBe(401);
  });
});
