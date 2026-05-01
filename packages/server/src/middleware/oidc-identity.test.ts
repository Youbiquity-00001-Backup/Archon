import { describe, test, expect, mock } from 'bun:test';
import { Hono } from 'hono';
import { generateKeyPairSync, sign as cryptoSign, createPrivateKey } from 'node:crypto';
import {
  createOidcMiddleware,
  getIdentity,
  parseAllowedSlackUserIds,
  parseSlackSub,
  type PublicKeyFetcher,
} from './oidc-identity';

// ─── Test fixtures: real keys, real signed JWTs ─────────────────────────────
//
// We generate a real EC P-256 keypair and sign real JWTs with it. The
// fetcher in tests returns the matching public key PEM. This is faster than
// pre-baking a fixture and exercises the actual `crypto.verify` codepath.

interface TestKeys {
  publicKeyPem: string;
  privateKeyPem: string;
}

function newKeyPair(): TestKeys {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }) as string,
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
  };
}

function base64UrlEncode(buf: Buffer | string): string {
  const b = typeof buf === 'string' ? Buffer.from(buf, 'utf8') : buf;
  return b.toString('base64url');
}

interface SignOpts {
  kid: string;
  alg?: string;
  privateKeyPem: string;
  payload: Record<string, unknown>;
}

/** Produce an ALB-shaped signed JWT (ES256, ieee-p1363 / JWS sig encoding). */
function signJwt(opts: SignOpts): string {
  const header = { alg: opts.alg ?? 'ES256', kid: opts.kid, typ: 'JWT' };
  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const payloadB64 = base64UrlEncode(JSON.stringify(opts.payload));
  const signingInput = `${headerB64}.${payloadB64}`;
  const sig = cryptoSign('sha256', Buffer.from(signingInput, 'utf8'), {
    key: createPrivateKey(opts.privateKeyPem),
    // Match what ALB / JWS produces and what our middleware decodes.
    dsaEncoding: 'ieee-p1363',
  });
  return `${signingInput}.${base64UrlEncode(sig)}`;
}

const ALLOWED = new Set(['U_GOOD']);
const REGION = 'us-east-1';

function newApp(opts: {
  fetcher: PublicKeyFetcher;
  allowed?: ReadonlySet<string>;
  clock?: () => number;
}) {
  const mw = createOidcMiddleware({
    region: REGION,
    allowedSlackUserIds: opts.allowed ?? ALLOWED,
    fetcher: opts.fetcher,
    clock: opts.clock,
  });
  const app = new Hono();
  app.use('/api/*', mw);
  app.get('/api/me', c => {
    const identity = getIdentity(c);
    return c.json({ identity });
  });
  app.options('/api/me', c => c.body(null, 204));
  return app;
}

// ─── parseSlackSub ──────────────────────────────────────────────────────────

describe('parseSlackSub', () => {
  test('strips the team prefix and returns the user half', () => {
    expect(parseSlackSub('TABCDE-U12345')).toBe('U12345');
  });

  test('returns the input unchanged if no dash is present', () => {
    expect(parseSlackSub('U12345')).toBe('U12345');
  });

  test('returns empty string for empty input', () => {
    expect(parseSlackSub('')).toBe('');
  });
});

// ─── parseAllowedSlackUserIds ───────────────────────────────────────────────

describe('parseAllowedSlackUserIds', () => {
  test('returns empty set for unset / empty / whitespace-only env', () => {
    expect(parseAllowedSlackUserIds(undefined).size).toBe(0);
    expect(parseAllowedSlackUserIds('').size).toBe(0);
    expect(parseAllowedSlackUserIds('   ').size).toBe(0);
  });

  test('splits on comma and trims whitespace', () => {
    const set = parseAllowedSlackUserIds(' U1, U2 ,U3 ');
    expect(set.has('U1')).toBe(true);
    expect(set.has('U2')).toBe(true);
    expect(set.has('U3')).toBe(true);
    expect(set.size).toBe(3);
  });

  test('drops empty segments produced by stray commas', () => {
    const set = parseAllowedSlackUserIds('U1,,U2,');
    expect(set.size).toBe(2);
  });
});

// ─── createOidcMiddleware ───────────────────────────────────────────────────

describe('createOidcMiddleware', () => {
  test('happy path: valid JWT → identity attached, handler runs', async () => {
    const keys = newKeyPair();
    const fetcher = mock(async () => keys.publicKeyPem);
    const app = newApp({ fetcher });
    const jwt = signJwt({
      kid: 'kid-1',
      privateKeyPem: keys.privateKeyPem,
      payload: {
        sub: 'TABCDE-U_GOOD',
        exp: Math.floor(Date.now() / 1000) + 300,
        email: 'alice@example.com',
        name: 'Alice',
      },
    });

    const res = await app.request('/api/me', {
      headers: { 'x-amzn-oidc-data': jwt },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { identity: { slackUserId: string; email?: string } };
    expect(body.identity.slackUserId).toBe('U_GOOD');
    expect(body.identity.email).toBe('alice@example.com');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test('caches the public key by kid (one fetch across many requests)', async () => {
    const keys = newKeyPair();
    const fetcher = mock(async () => keys.publicKeyPem);
    const app = newApp({ fetcher });
    const mkJwt = () =>
      signJwt({
        kid: 'kid-cache',
        privateKeyPem: keys.privateKeyPem,
        payload: {
          sub: 'T-U_GOOD',
          exp: Math.floor(Date.now() / 1000) + 300,
        },
      });

    for (let i = 0; i < 5; i++) {
      const res = await app.request('/api/me', { headers: { 'x-amzn-oidc-data': mkJwt() } });
      expect(res.status).toBe(200);
    }
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test('401 when the JWT header is missing entirely', async () => {
    const fetcher = mock(async () => '');
    const app = newApp({ fetcher });
    const res = await app.request('/api/me');
    expect(res.status).toBe(401);
    expect(fetcher).not.toHaveBeenCalled();
  });

  test('401 on malformed JWT (not 3 segments)', async () => {
    const fetcher = mock(async () => '');
    const app = newApp({ fetcher });
    const res = await app.request('/api/me', { headers: { 'x-amzn-oidc-data': 'not.valid' } });
    expect(res.status).toBe(401);
  });

  test('401 when alg is not ES256 (defends against `alg: none` bypass)', async () => {
    const keys = newKeyPair();
    const fetcher = mock(async () => keys.publicKeyPem);
    const app = newApp({ fetcher });
    const jwt = signJwt({
      kid: 'kid-1',
      alg: 'HS256', // Not what ALB ever sends — must be rejected.
      privateKeyPem: keys.privateKeyPem,
      payload: { sub: 'T-U_GOOD', exp: Math.floor(Date.now() / 1000) + 300 },
    });
    const res = await app.request('/api/me', { headers: { 'x-amzn-oidc-data': jwt } });
    expect(res.status).toBe(401);
  });

  test('401 when the signature is verified against the wrong key', async () => {
    const realKeys = newKeyPair();
    const wrongKeys = newKeyPair();
    // Fetcher returns the WRONG public key — simulates regional-key
    // rotation drift or an attacker-controlled signing key.
    const fetcher = mock(async () => wrongKeys.publicKeyPem);
    const app = newApp({ fetcher });
    const jwt = signJwt({
      kid: 'kid-1',
      privateKeyPem: realKeys.privateKeyPem,
      payload: { sub: 'T-U_GOOD', exp: Math.floor(Date.now() / 1000) + 300 },
    });
    const res = await app.request('/api/me', { headers: { 'x-amzn-oidc-data': jwt } });
    expect(res.status).toBe(401);
  });

  test('401 on expired token even if signature is valid', async () => {
    const keys = newKeyPair();
    const fetcher = mock(async () => keys.publicKeyPem);
    let now = 1_000_000_000_000; // some fixed wall-clock
    const app = newApp({ fetcher, clock: () => now });
    const jwt = signJwt({
      kid: 'kid-1',
      privateKeyPem: keys.privateKeyPem,
      payload: {
        sub: 'T-U_GOOD',
        // Issued 10 minutes ago, expired 5 minutes ago.
        exp: Math.floor(now / 1000) - 5 * 60,
      },
    });
    const res = await app.request('/api/me', { headers: { 'x-amzn-oidc-data': jwt } });
    expect(res.status).toBe(401);
  });

  test('401 when public-key fetch throws (e.g. wrong region)', async () => {
    const keys = newKeyPair();
    const fetcher = mock(async () => {
      throw new Error('public key fetch failed: 404');
    });
    const app = newApp({ fetcher });
    const jwt = signJwt({
      kid: 'kid-1',
      privateKeyPem: keys.privateKeyPem,
      payload: { sub: 'T-U_GOOD', exp: Math.floor(Date.now() / 1000) + 300 },
    });
    const res = await app.request('/api/me', { headers: { 'x-amzn-oidc-data': jwt } });
    expect(res.status).toBe(401);
  });

  test('403 when the user passes signature but is not on the allowlist', async () => {
    const keys = newKeyPair();
    const fetcher = mock(async () => keys.publicKeyPem);
    const app = newApp({ fetcher });
    const jwt = signJwt({
      kid: 'kid-1',
      privateKeyPem: keys.privateKeyPem,
      payload: {
        sub: 'TABCDE-U_NOT_ALLOWED',
        exp: Math.floor(Date.now() / 1000) + 300,
      },
    });
    const res = await app.request('/api/me', { headers: { 'x-amzn-oidc-data': jwt } });
    expect(res.status).toBe(403);
  });

  test('an empty allowlist denies everyone, including signed identities', async () => {
    const keys = newKeyPair();
    const fetcher = mock(async () => keys.publicKeyPem);
    const app = newApp({ fetcher, allowed: new Set() });
    const jwt = signJwt({
      kid: 'kid-1',
      privateKeyPem: keys.privateKeyPem,
      payload: { sub: 'T-U_GOOD', exp: Math.floor(Date.now() / 1000) + 300 },
    });
    const res = await app.request('/api/me', { headers: { 'x-amzn-oidc-data': jwt } });
    expect(res.status).toBe(403);
  });

  test('OPTIONS preflight passes through without a JWT (no fetcher hit)', async () => {
    const fetcher = mock(async () => '');
    const app = newApp({ fetcher });
    const res = await app.request('/api/me', { method: 'OPTIONS' });
    // Hono's options handler we wired returns 204; the important thing is
    // we don't 401.
    expect(res.status).toBe(204);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
