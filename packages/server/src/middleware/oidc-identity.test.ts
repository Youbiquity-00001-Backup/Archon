import { describe, test, expect } from 'bun:test';
import { createSign, createHmac, generateKeyPairSync } from 'node:crypto';
import { Hono } from 'hono';
import {
  buildArchonSessionToken,
  verifyArchonSessionToken,
  createOidcMiddleware,
  getIdentity,
  parseAllowedSlackUserIds,
  type OidcIdentity,
  type PublicKeyFetcher,
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

  test('internal call with x-archon-internal-user attaches that identity', async () => {
    const app = makeApp({ sessionSecret: SECRET });
    // No x-forwarded-for → internal bypass path; x-archon-internal-user claims identity.
    const res = await app.request('/api/echo', {
      method: 'GET',
      headers: { 'x-archon-internal-user': 'U_INTERNAL' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { identity: OidcIdentity | null };
    expect(body.identity).toEqual({ slackUserId: 'U_INTERNAL' });
  });
});

// ─── ALB JWT path ────────────────────────────────────────────────────────────

const albKeyPair = generateKeyPairSync('ec', { namedCurve: 'P-256' });

function mintAlbJwt(claims: Record<string, unknown>, kid = 'test-kid'): string {
  const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid, typ: 'JWT' })).toString(
    'base64url'
  );
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signingInput = `${header}.${payload}`;
  const signer = createSign('sha256');
  signer.update(signingInput);
  const sig = signer
    .sign({ key: albKeyPair.privateKey, dsaEncoding: 'ieee-p1363' })
    .toString('base64url');
  return `${header}.${payload}.${sig}`;
}

function makeAlbApp(fetcher: PublicKeyFetcher): Hono {
  const app = new Hono();
  const mw = createOidcMiddleware({
    region: 'us-east-1',
    allowedSlackUserIds: new Set<string>(),
    fetcher,
  });
  app.use('/api/*', mw);
  app.get('/api/echo', c => {
    const identity = getIdentity(c);
    return c.json({ identity: identity ?? null });
  });
  return app;
}

const albFetcher: PublicKeyFetcher = async (_kid, _region) =>
  albKeyPair.publicKey.export({ type: 'spki', format: 'pem' }) as string;

describe('createOidcMiddleware — ALB JWT path', () => {
  test('valid ES256 ALB JWT → 200 with identity attached', async () => {
    const app = makeAlbApp(albFetcher);
    const now = Math.floor(Date.now() / 1000);
    const jwt = mintAlbJwt({
      sub: 'TTEAM-UALICE',
      exp: now + 300,
      iat: now,
      email: 'alice@example.com',
    });
    const res = await app.request('/api/echo', {
      method: 'GET',
      headers: { 'x-forwarded-for': '1.2.3.4', 'x-amzn-oidc-data': jwt },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { identity: OidcIdentity | null };
    expect(body.identity?.slackUserId).toBe('UALICE');
    expect(body.identity?.email).toBe('alice@example.com');
  });

  test('expired ALB JWT → 401', async () => {
    const app = makeAlbApp(albFetcher);
    const past = Math.floor(Date.now() / 1000) - 60;
    const jwt = mintAlbJwt({ sub: 'TTEAM-UALICE', exp: past, iat: past - 300 });
    const res = await app.request('/api/echo', {
      method: 'GET',
      headers: { 'x-forwarded-for': '1.2.3.4', 'x-amzn-oidc-data': jwt },
    });
    expect(res.status).toBe(401);
  });

  test('valid ALB JWT but user not in allowlist → 403', async () => {
    const app = new Hono();
    const mw = createOidcMiddleware({
      region: 'us-east-1',
      allowedSlackUserIds: new Set(['UOTHER']),
      fetcher: albFetcher,
    });
    app.use('/api/*', mw);
    app.get('/api/echo', c => c.json({ ok: true }));
    const now = Math.floor(Date.now() / 1000);
    const jwt = mintAlbJwt({ sub: 'TTEAM-UALICE', exp: now + 300, iat: now });
    const res = await app.request('/api/echo', {
      method: 'GET',
      headers: { 'x-forwarded-for': '1.2.3.4', 'x-amzn-oidc-data': jwt },
    });
    expect(res.status).toBe(403);
  });

  test('tampered signature → 401', async () => {
    const app = makeAlbApp(albFetcher);
    const now = Math.floor(Date.now() / 1000);
    const jwt = mintAlbJwt({ sub: 'TTEAM-UALICE', exp: now + 300, iat: now });
    // Flip a middle character of the signature (avoid the last char whose padding
    // bits are ignored by base64url decoders).
    const parts = jwt.split('.');
    const mid = Math.floor(parts[2].length / 2);
    const flipped =
      parts[2].slice(0, mid) + (parts[2][mid] === 'A' ? 'B' : 'A') + parts[2].slice(mid + 1);
    parts[2] = flipped;
    const tampered = parts.join('.');
    const res = await app.request('/api/echo', {
      method: 'GET',
      headers: { 'x-forwarded-for': '1.2.3.4', 'x-amzn-oidc-data': tampered },
    });
    expect(res.status).toBe(401);
  });
});

// ─── parseAllowedSlackUserIds ─────────────────────────────────────────────────

describe('parseAllowedSlackUserIds', () => {
  test('undefined → empty set', () => expect(parseAllowedSlackUserIds(undefined).size).toBe(0));
  test('empty string → empty set', () => expect(parseAllowedSlackUserIds('').size).toBe(0));
  test('whitespace-only → empty set', () => expect(parseAllowedSlackUserIds('   ').size).toBe(0));
  test('comma-separated with whitespace → trimmed set', () => {
    expect(parseAllowedSlackUserIds(' U_ALICE , U_BOB , ')).toEqual(new Set(['U_ALICE', 'U_BOB']));
  });
  test('single id → set of one', () => {
    expect(parseAllowedSlackUserIds('U_ALICE')).toEqual(new Set(['U_ALICE']));
  });
  test('empty entries from double commas are filtered', () => {
    expect(parseAllowedSlackUserIds('U_ALICE,,U_BOB')).toEqual(new Set(['U_ALICE', 'U_BOB']));
  });
});
